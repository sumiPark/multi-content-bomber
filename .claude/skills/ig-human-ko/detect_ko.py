#!/usr/bin/env python3
"""
detect_ko.py - 한국어 초안이 얼마나 기계가 쓴 것처럼 보이는지 다섯 가지 검사로 채점한다.

원본: github.com/Jakeschincariol/instagram-agent-skill 의 ig-human/detect.py (MIT).
원본은 영어 단어·축약형(it's, don't)·대문자 고유명사로 쟀다. 이 판은 같은 다섯 패널을
한국어 신호로 바꿨다.

이것이 무엇인가: 공개 AI 탐지기들이 보는 신호를 본뜬 로컬 휴리스틱 다섯 개.
문장 길이 변화, 구체성, 상투어, 타이포 지문, 말투. 전부 이 컴퓨터에서 글만 보고
계산한다. 아무것도 업로드하지 않는다.

이것이 아닌 것: GPTZero, Originality, Copyleaks, 카피킬러, 무하유 GPT킬러 같은
서비스가 아니다. 그 API를 부르지 않고 그 판정을 약속할 수 없다. 그들이 공통으로
보는 것을 잡을 뿐이고, 정직하게 할 수 있는 말은 이 줄까지다. 한국어 실제 코퍼스로
기준값을 맞춘 적도 없다(기준값은 원본 영어 값을 어절 단위로 환산한 추정).

각 검사는 0~100의 "사람 점수"를 낸다. 높을수록 좋다.

  BURSTINESS   문장 길이 변화    사람은 길이를 들쭉날쭉, 모델은 고르게
  SPECIFICITY  구체성           100어절당 숫자·이름·인용
  SLOP         상투어 밀도       100어절당 slop_ko.json 적중
  FINGERPRINT  타이포 지문       보이지 않는 문자, em dash, 둥근 따옴표
  VOICE        말투             구어 표지, 인칭, 어미 반복, 구조적 티

사용법
  python -I detect_ko.py draft.txt
  python -I detect_ko.py draft.txt --json
  python -I detect_ko.py before.txt after.txt      # 전후 비교
"""

import argparse
import json
import os
import re
import statistics
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
LEX = os.path.join(HERE, "slop_ko.json")

SENT_RE = re.compile(r"[^.!?…\n]+[.!?…]*")
HANGUL_RE = re.compile(r"[가-힣]")
NUMBERS = re.compile(r"\d[\d,.]*\s?(?:%|원|만\s?원|개|일|초|분|시간|주|개월|년|kg|g|ml|mg|브릭스|brix|명|번|가지|단계|배|위)?")
LATIN = re.compile(r"(?<![A-Za-z])[A-Za-z][A-Za-z0-9]{1,}")
QUOTE = re.compile(r"[\"“'‘「『][^\"”'’」』\n]{2,40}[\"”'’」』]")
TIME_WORDS = re.compile(r"(?<![가-힣])(?:이틀|사흘|나흘|열흘|보름|일주일|(?:한|두|석|넉)\s?달|반년)")
PRONOUNS = re.compile(r"(?<![가-힣])(?:저|제|나|내|우리|저희|여러분|너|당신)(?:는|가|도|만|의|한테|희)?(?=\s|$|[,.!?])|제가|내가")
FORMAL_END = re.compile(r"(?:니다|니까)\s*[.!?]*\s*$")


def clamp(n):
    return max(0.0, min(100.0, n))


def scale(value, human, machine):
    """value를 0~100으로: human 값이면 100, machine 값이면 0."""
    if human == machine:
        return 50.0
    return clamp((value - machine) / (human - machine) * 100)


def load_lexicon(path=LEX):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def eojeol(text):
    return [t for t in text.split() if re.search(r"[가-힣A-Za-z0-9]", t)]


def sentences(text):
    """두 어절 이상인 문장만. 한 단어짜리 줄은 길이 변화 계산을 흐린다."""
    return [s.strip() for s in SENT_RE.findall(text) if len(eojeol(s)) >= 2]


def entry_pattern(entry):
    """사전 항목 -> 정규식. regex가 있으면 그대로, 없으면 앞이 한글이 아닌 자리의 find."""
    if entry.get("regex"):
        return re.compile(entry["regex"], re.MULTILINE)
    body = re.escape(entry["find"]).replace(r"\ ", r"\s*")
    return re.compile(r"(?<![가-힣])" + body)


def find_slop(text, lex):
    """words + phrases 적중 목록 [(entry, count)]. 겹치는 위치는 한 번만 센다."""
    taken = set()
    hits = []
    for entry in sorted(lex["words"] + lex["phrases"], key=lambda e: -len(e["find"])):
        n = 0
        for m in entry_pattern(entry).finditer(text):
            span = set(range(m.start(), max(m.end(), m.start() + 1)))
            if span & taken:
                continue
            taken |= span
            n += 1
        if n:
            hits.append((entry, n))
    return hits


def find_rewrites(text, lex):
    out = []
    for r in lex.get("rewrites", []):
        n = len(re.findall(r["regex"], text))
        if n:
            out.append((r, n))
    return out


def find_structures(text, lex):
    out = []
    for s in lex["structures"]:
        try:
            n = len(re.compile(s["regex"], re.MULTILINE).findall(text))
        except re.error:
            continue
        if s["id"] == "listing" and n < 2:
            continue                                   # "첫째"가 한 번이면 나열이 아니다
        if n:
            out.append((s, n))
    return out


def sentence_ending(s):
    """문장 끝 두 음절(문장부호·이모지·공백 제거 후). '했습니다' -> '니다'."""
    tail = re.sub(r"[^가-힣]+$", "", s.strip())
    syl = HANGUL_RE.findall(tail[-4:])
    return "".join(syl[-2:]) if len(syl) >= 2 else None


def ending_runs(text, run_len=3):
    """같은 어미가 run_len번 이상 연속인 구간들 [(어미, 시작 문장 번호, 길이)]."""
    ends = [sentence_ending(s) for s in sentences(text)]
    runs, i = [], 0
    while i < len(ends):
        j = i
        while j + 1 < len(ends) and ends[j + 1] and ends[j + 1] == ends[i]:
            j += 1
        if ends[i] and j - i + 1 >= run_len:
            runs.append((ends[i], i + 1, j - i + 1))
        i = j + 1
    return runs


# ---------------------------------------------------------------------------
# 다섯 검사
# ---------------------------------------------------------------------------

def check_burstiness(text):
    """사람은 문장 길이를 세게 흔든다. 모델은 고르게 쓴다. 길이는 음절로 잰다."""
    lens = [len(HANGUL_RE.findall(s)) + len(re.findall(r"[A-Za-z0-9]", s)) // 2 for s in sentences(text)]
    lens = [n for n in lens if n]
    if len(lens) < 4:
        return 50.0, "문장이 적어 판단 보류"
    mean = statistics.mean(lens)
    cv = statistics.pstdev(lens) / mean if mean else 0
    score = scale(cv, human=0.70, machine=0.22)
    return score, f"문장 {len(lens)}개의 길이 변화 {cv:.2f} (0.55 이상이 사람 같음)"


def concrete(text):
    t = re.sub(r"(?<=\d),(?=\d)", "", text)
    hits = [m.group(0) for m in NUMBERS.finditer(t)]
    hits += [m.group(0) for m in TIME_WORDS.finditer(t)]
    hits += [m.group(0) for m in QUOTE.finditer(t)]
    hits += list({m.group(0) for m in LATIN.finditer(t)})
    return hits


def check_specificity(text):
    """숫자, 이름, 인용. 상투어는 추상적이다."""
    w = eojeol(text)
    if len(w) < 15:
        return 50.0, "글이 짧아 판단 보류"
    hits = concrete(text)
    density = len(hits) * 100 / len(w)
    # 기준값: 원본(100단어당 사람 6 / 기계 0.5)을 한국어 어절로 환산(1어절 ≈ 영어 1.6단어)
    score = scale(density, human=8.0, machine=0.8)
    shown = ", ".join(hits[:4]) if hits else "없음"
    return score, f"구체 신호 {len(hits)}개, 100어절당 {density:.1f} (5 이상 권장) [{shown}]"


def check_slop(text, lex):
    """상투어 밀도."""
    w = eojeol(text)
    if not w:
        return 50.0, "비어 있음"
    hits = find_slop(text, lex) + find_rewrites(text, lex)
    n = sum(c for _, c in hits)
    density = n * 100 / len(w)
    score = scale(density, human=0.0, machine=6.0)
    names = sorted({(e.get("find") or e.get("name")) for e, _ in hits})
    detail = f"상투어 {n}개, 100어절당 {density:.1f}"
    if names:
        detail += " (" + ", ".join(names[:4]) + (", ..." if len(names) > 4 else "") + ")"
    return score, detail


def check_fingerprint(text):
    """폰 키보드가 만들지 않는 문자. 한국어 기준으로 가중치 조정."""
    # 한글 채움 문자(U+3164)는 Lo라 Cf 검사로 안 잡혀서 따로 센다.
    invisible = sum(1 for c in text if unicodedata.category(c) == "Cf" or c in "ㅤᅟᅠ")
    em = text.count("—") + text.count("―")
    # iOS '스마트 구두점'은 한국어 자판에서도 둥근 따옴표·줄임표를 만든다 -> 가볍게만 센다.
    curly = sum(text.count(c) for c in "‘’“”")
    ellip = text.count("…")
    hard = sum(text.count(c) for c in "   　")
    total = invisible * 4 + em * 2 + curly * 0.5 + ellip * 0.5 + hard
    per1k = total * 1000 / max(len(text), 1)
    score = scale(per1k, human=0.0, machine=15.0)
    return score, (f"보이지 않는 문자 {invisible}, em dash {em}, 둥근 따옴표 {curly}, "
                   f"줄임표 문자 {ellip}, 특수 공백 {hard}")


def check_voice(text, lex):
    """구어 표지, 인칭, 어미 반복, 그리고 모델이 기본으로 쓰는 모양."""
    w = eojeol(text)
    if len(w) < 15:
        return 50.0, "글이 짧아 판단 보류"
    per100 = 100 / len(w)
    colloq = sum(len(re.findall(p, text, re.MULTILINE)) for p in lex.get("colloquial", [])) * per100
    person = len(PRONOUNS.findall(text)) * per100
    sents = sentences(text)
    formal = sum(1 for s in sents if FORMAL_END.search(s)) / max(len(sents), 1)
    struct = find_structures(text, lex)
    runs = ending_runs(text)
    tells = sum(n for _, n in struct) + len(runs)
    names = [s["id"] for s, _ in struct] + [f"어미 '{e}' {k}연속" for e, _, k in runs]
    bullets = [len(b.split()) for b in re.findall(r"(?m)^\s*[-*•]\s+(.+)$", text)]
    uniform = len(bullets) >= 3 and statistics.pstdev(bullets) < 1.6
    score = (scale(colloq, human=8.0, machine=0.0) * 0.30
             + scale(person, human=4.0, machine=0.3) * 0.20
             + scale(formal, human=0.2, machine=0.9) * 0.20
             + clamp(100 - tells * 22) * 0.30)
    if uniform:
        score -= 12
        names.append("고른 글머리표")
    detail = (f"구어 표지 {colloq:.1f}, 인칭 {person:.1f} (100어절당), "
              f"'~니다' 문장 비율 {formal:.0%}, 구조적 티 {tells}개")
    if names:
        detail += " [" + ", ".join(names[:4]) + "]"
    return clamp(score), detail


CHECKS = ["BURSTINESS", "SPECIFICITY", "SLOP", "FINGERPRINT", "VOICE"]
CHECK_KO = {"BURSTINESS": "길이 변화", "SPECIFICITY": "구체성", "SLOP": "상투어",
            "FINGERPRINT": "타이포 지문", "VOICE": "말투"}


def run(text, lex):
    results = {
        "BURSTINESS": check_burstiness(text),
        "SPECIFICITY": check_specificity(text),
        "SLOP": check_slop(text, lex),
        "FINGERPRINT": check_fingerprint(text),
        "VOICE": check_voice(text, lex),
    }
    scores = [results[c][0] for c in CHECKS]
    # 가장 약한 검사가 판정을 끌어내린다: 탐지기는 신호 하나면 충분하다.
    overall = statistics.mean(scores) * 0.6 + min(scores) * 0.4
    verdict = "PASS" if overall >= 70 and min(scores) >= 55 else (
        "REVIEW" if overall >= 50 else "FLAGGED")
    return results, overall, verdict


VERDICT_KO = {"PASS": "통과", "REVIEW": "검토", "FLAGGED": "AI 티 남"}


def bar(score, width=24):
    filled = round(score / 100 * width)
    return "#" * filled + "." * (width - filled)


def pad(s, width):
    w = sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)
    return s + " " * max(0, width - w)


def render(results, overall, verdict, label=None, out=sys.stdout):
    title = "AI 티 검사 패널" + (f"  -  {label}" if label else "")
    print("\n" + title, file=out)
    print("=" * 62, file=out)
    for name in CHECKS:
        score, detail = results[name]
        print(f"  {pad(CHECK_KO[name], 12)} {bar(score)} {score:5.1f}", file=out)
        print(f"  {'':<12} {detail}", file=out)
    print("-" * 62, file=out)
    print(f"  {pad('사람 점수', 12)} {bar(overall)} {overall:5.1f}   {verdict} ({VERDICT_KO[verdict]})",
          file=out)
    if verdict != "PASS":
        weakest = min(CHECKS, key=lambda c: results[c][0])
        print(f"\n  가장 약한 신호: {CHECK_KO[weakest]}. 그것부터 고쳐라.", file=out)
    print("", file=out)


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")    # 파이프 입력도 UTF-8로 (Windows 기본 cp949)
        sys.stdout.reconfigure(encoding="utf-8")   # Windows 콘솔에서 한글 깨짐 방지
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="한국어 초안의 AI 티를 다섯 검사로 채점한다.")
    ap.add_argument("input", nargs="?", default="-", help="파일, 또는 - (표준입력)")
    ap.add_argument("compare", nargs="?", help="두 번째 파일 (전후 비교)")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--lexicon", default=LEX)
    args = ap.parse_args()

    lex = load_lexicon(args.lexicon)

    def read(p):
        return sys.stdin.read() if p == "-" else open(p, encoding="utf-8-sig").read()

    targets = [(args.input, read(args.input))]
    if args.compare:
        targets.append((args.compare, read(args.compare)))

    payload = []
    for name, text in targets:
        results, overall, verdict = run(text, lex)
        payload.append({
            "source": name,
            "checks": {k: {"score": round(v[0], 1), "detail": v[1]} for k, v in results.items()},
            "human_score": round(overall, 1),
            "verdict": verdict,
        })

    if args.json:
        print(json.dumps(payload if args.compare else payload[0], indent=2, ensure_ascii=False))
        return

    for (name, text), p in zip(targets, payload):
        results, overall, verdict = run(text, lex)
        render(results, overall, verdict, label=os.path.basename(name) if args.compare else None)
    if args.compare:
        a, b = payload
        delta = b["human_score"] - a["human_score"]
        print(f"  {a['human_score']:.1f} {a['verdict']}  ->  "
              f"{b['human_score']:.1f} {b['verdict']}   ({delta:+.1f})\n")

    sys.exit(0 if payload[-1]["verdict"] == "PASS" else 1)


if __name__ == "__main__":
    main()
