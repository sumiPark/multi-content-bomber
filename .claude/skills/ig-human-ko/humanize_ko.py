#!/usr/bin/env python3
"""
humanize_ko.py - 한국어 초안에서 기계 지문을 걷어 낸다.

원본: github.com/Jakeschincariol/instagram-agent-skill 의 ig-human/humanize.py (MIT).
원본은 영어 상투어를 평이한 단어로 자동 치환했다. 한국어는 조사·어미가 붙어서 단어를
기계적으로 바꾸면 문장이 깨지기 쉽다. 그래서 이 판은 자동 치환을 "확실히 안전한 것"으로
좁혔다.

자동으로 고치는 것 (순서대로)
  1. 보이지 않는 문자   폭 없는 공백·결합 문자·BOM·태그 문자·한글 채움 문자 삭제,
                        특수 공백은 일반 공백으로. 이모지 조합(👩‍👧) 안의 ZWJ는 보존.
  2. 타이포            em dash(—)·가로줄(―) -> 쉼표, 숫자 사이 en dash -> 물결(~),
                        둥근 따옴표 -> 곧은 따옴표, 줄임표 문자 -> 마침표 셋, • -> -.
                        가운뎃점(·)과 화살표(→)는 한국어에서 사람이 쓰므로 둔다.
  3. 명백한 번역투      slop_ko.json의 rewrites만: ~에 있어서 -> ~에서,
                        ~을/를 통해 -> ~(으)로(받침 맞춤), 되어집니다 -> 됩니다 등.

제안만 하는 것 (글은 안 바꾼다. 고르는 건 사람·모델 몫)
  - words·phrases 상투어 (다양한, 놓치지 마세요, 또한, ~에 대해 ...) + 대체 제안
  - 구조적 티 ("단순한 X가 아니라 Y", 첫째·둘째 나열, 셋 묶음, 해시태그 벽, 서두 ...)
  - 같은 어미 3연속 ("~습니다. ~습니다. ~습니다.")
  - 문장 길이가 너무 고름

사용법
  python -I humanize_ko.py draft.txt                 # 고친 글을 표준출력으로
  python -I humanize_ko.py draft.txt --report        # 무엇을 바꿨고 무엇을 제안하는지 (stderr)
  python -I humanize_ko.py draft.txt -o clean.txt --report
  python -I humanize_ko.py draft.txt --json
"""

import argparse
import json
import os
import re
import sys
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)                 # python -I 는 스크립트 폴더를 sys.path에 안 넣는다
from detect_ko import (LEX, ending_runs, entry_pattern, find_structures,  # noqa: E402
                       load_lexicon, sentences, HANGUL_RE)

URL_RE = re.compile(r"https?://\S+|www\.\S+|\S+@\S+\.\S+|(?<!\S)@[\w.]+")


def _cp(spec):
    if "-" in spec:
        a, b = spec.split("-")
        return (int(a[2:], 16), int(b[2:], 16))
    return int(spec[2:], 16)


def protect_urls(text):
    found = []

    def stash(m):
        found.append(m.group(0))
        return f"\x00URL{len(found) - 1}\x00"

    return URL_RE.sub(stash, text), found


def restore_urls(text, found):
    for i, url in enumerate(found):
        text = text.replace(f"\x00URL{i}\x00", url)
    return text


def _is_emoji(ch):
    return bool(ch) and (unicodedata.category(ch) == "So" or 0x1F000 <= ord(ch) <= 0x1FAFF
                         or ch == "️")


def pass_invisible(text, lex):
    hits = []
    for entry in lex["invisible"]:
        cp = _cp(entry["cp"])
        repl = "" if entry["action"] == "delete" else " "
        if isinstance(cp, tuple):
            pattern = re.compile("[" + re.escape(chr(cp[0])) + "-" + re.escape(chr(cp[1])) + "]")
        elif cp == 0x200D:
            # 이모지 사이의 ZWJ는 조합 이모지의 일부다(👩‍👧). 그건 남긴다.
            pattern = re.compile(r"(?<![\U0001F000-\U0001FAFF☀-➿️])‍"
                                 r"|‍(?![\U0001F000-\U0001FAFF☀-➿])")
        else:
            pattern = re.compile(re.escape(chr(cp)))
        n = len(pattern.findall(text))
        if n:
            hits.append({"name": entry["cp"] + " " + entry["name"], "count": n,
                         "action": "삭제" if entry["action"] == "delete" else "공백으로"})
            text = pattern.sub(repl, text)
    stray = [c for i, c in enumerate(text) if unicodedata.category(c) == "Cf"
             and not (c == "‍" and _is_emoji(text[i - 1] if i else "")
                      and _is_emoji(text[i + 1] if i + 1 < len(text) else ""))]
    if stray:
        hits.append({"name": "그 밖의 보이지 않는 서식 문자", "count": len(stray), "action": "삭제"})
        text = "".join(c for i, c in enumerate(text) if not (
            unicodedata.category(c) == "Cf"
            and not (c == "‍" and _is_emoji(text[i - 1] if i else "")
                     and _is_emoji(text[i + 1] if i + 1 < len(text) else ""))))
    return text, hits


def pass_typographic(text, lex):
    hits = []
    for entry in lex["typographic"]:
        ch = entry["from"]
        n = text.count(ch)
        if not n:
            continue
        hits.append({"name": f"{ch} {entry['name']}", "count": n, "to": entry["to"].strip() or "(공백)"})
        if ch in "—―":
            # 종결 어미(~다/~요/~죠) 뒤의 줄표는 문장을 끝내는 자리라 마침표로, 나머지는 쉼표로.
            text = re.sub(r"(?<=[다요죠])\s*[—―]+\s*", ". ", text)
            text = re.sub(r"\s*[—―]+\s*", ", ", text)
        elif ch == "–":
            text = re.sub(r"(?<=\d)\s*–\s*(?=\d)", "~", text)   # 5–10분 -> 5~10분
            text = re.sub(r"\s+–\s+", ", ", text)                # 줄표처럼 쓴 것
            text = text.replace("–", "-")
        else:
            text = text.replace(ch, entry["to"])
    # 쉼표가 다른 문장부호 앞에 오면 어색하다.
    text = re.sub(r",\s*([,.;:!?])", r"\1", text)
    text = re.sub(r",[ \t]*\n", "\n", text)
    text = re.sub(r"(?m)^[ \t]*,[ \t]*", "", text)
    return text, hits


def _ro(word):
    """앞 말 받침에 맞는 '으로/로'. 받침 없음·ㄹ받침 -> 로, 그 밖 -> 으로."""
    last = word[-1]
    if "가" <= last <= "힣":
        jong = (ord(last) - 0xAC00) % 28
        return "로" if jong in (0, 8) else "으로"
    if last.isdigit():                         # 영 일 이 삼 사 오 육 칠 팔 구
        return "으로" if last in "036" else "로"
    return "로"


def pass_rewrites(text, lex):
    hits = []
    for r in lex.get("rewrites", []):
        pattern = re.compile(r["regex"])
        found = pattern.findall(text)
        if not found:
            continue
        samples = []

        def sub(m, r=r, samples=samples):
            out = m.expand(r["replace"].replace("{(으)로}", ""))
            if "{(으)로}" in r["replace"]:
                out = out + _ro(m.group(1))
            if len(samples) < 2:
                samples.append(f"{m.group(0)} -> {out}")
            return out

        text = pattern.sub(sub, text)
        hits.append({"name": r["name"], "count": len(found), "family": r["family"],
                     "examples": samples})
    return text, hits


def tidy(text):
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"[ \t]+([,.!?])", r"\1", text)
    text = re.sub(r"(?m)^[ \t]+$", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


def suggestions(text, lex):
    """자동으로 안 바꾸는 상투어: 어디에 있고 무엇으로 바꿀지."""
    out = []
    taken = set()
    for entry in sorted(lex["words"] + lex["phrases"], key=lambda e: -len(e["find"])):
        for m in entry_pattern(entry).finditer(text):
            span = set(range(m.start(), max(m.end(), m.start() + 1)))
            if span & taken:
                continue
            taken |= span
            line_no = text.count("\n", 0, m.start()) + 1
            a, b = max(0, m.start() - 8), min(len(text), m.end() + 8)
            out.append({"find": entry["find"], "matched": m.group(0), "line": line_no,
                        "context": text[a:b].replace("\n", " "), "suggest": entry["suggest"],
                        "family": entry["family"]})
    out.sort(key=lambda s: s["line"])
    return out


def scan_structures(text, lex):
    flags = [{"name": s["name"], "count": n, "fix": s["fix"]} for s, n in find_structures(text, lex)]
    for e, start, k in ending_runs(text):
        flags.append({"name": f"같은 어미 '~{e}' {k}문장 연속 ({start}번째 문장부터)", "count": k,
                      "fix": "어미를 섞어라. 한 문장은 짧게 끊고, 하나는 질문이나 반말로."})
    lens = [len(HANGUL_RE.findall(s)) for s in sentences(text)]
    lens = [n for n in lens if n]
    if len(lens) >= 4:
        mean = sum(lens) / len(lens)
        var = sum((n - mean) ** 2 for n in lens) / len(lens)
        cv = (var ** 0.5) / mean if mean else 0
        if cv < 0.35:
            flags.append({"name": f"문장 길이가 너무 고름 (변화 {cv:.2f})", "count": len(lens),
                          "fix": "한 문장은 반으로 자르고, 다른 하나는 길게 두라. 기계는 고르게 쓴다."})
    return flags


def humanize(text, lex):
    text, urls = protect_urls(text)
    text, inv = pass_invisible(text, lex)
    text, typo = pass_typographic(text, lex)
    text, rew = pass_rewrites(text, lex)
    text = tidy(text)
    text = restore_urls(text, urls)
    return text.strip() + "\n", {
        "invisible": inv,
        "typographic": typo,
        "rewrites": rew,
        "suggestions": suggestions(text, lex),
        "structures": scan_structures(text, lex),
    }


def render_report(report, out=sys.stderr):
    def head(title):
        print(f"\n{title}\n" + "-" * 40, file=out)

    fixed = sum(h["count"] for k in ("invisible", "typographic", "rewrites") for h in report[k])
    head("휴머나이즈 보고서")
    print(f"자동으로 고친 기계 흔적 {fixed}개, 바꿀 말 제안 {len(report['suggestions'])}개, "
          f"구조적 티 {len(report['structures'])}개", file=out)

    if report["invisible"]:
        head("1. 보이지 않는 문자 (자동)")
        for h in report["invisible"]:
            print(f"  {h['count']:>3}x  {h['name']}  -> {h['action']}", file=out)
    if report["typographic"]:
        head("2. 타이포 (자동)")
        for h in report["typographic"]:
            print(f"  {h['count']:>3}x  {h['name']}  -> {h['to']}", file=out)
    if report["rewrites"]:
        head("3. 명백한 번역투 (자동)")
        for h in report["rewrites"]:
            print(f"  {h['count']:>3}x  {h['name']}", file=out)
            for ex in h["examples"]:
                print(f"        예: {ex}", file=out)
    if report["suggestions"]:
        head("4. 상투어 (제안만 - 직접 고르세요)")
        for s in report["suggestions"]:
            print(f"  {s['line']:>3}줄  \"{s['matched']}\"  [{s['family']}]", file=out)
            print(f"        …{s['context']}…", file=out)
            print(f"        -> {s['suggest']}", file=out)
    if report["structures"]:
        head("5. 구조적 티 (자동 수정 안 함 - 직접 다시 쓰세요)")
        for h in report["structures"]:
            print(f"  {h['count']:>3}x  {h['name']}\n        {h['fix']}", file=out)
    if not any(report.values()):
        head("깨끗함")
        print("  걷어 낼 게 없다.", file=out)
    print("", file=out)


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")    # 파이프 입력도 UTF-8로 (Windows 기본 cp949)
        sys.stdout.reconfigure(encoding="utf-8")   # Windows 콘솔에서 한글 깨짐 방지
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="한국어 초안의 기계 지문을 걷어 낸다.")
    ap.add_argument("input", nargs="?", default="-", help="파일, 또는 - (표준입력)")
    ap.add_argument("-o", "--out", help="고친 글을 표준출력 대신 이 파일에")
    ap.add_argument("--report", action="store_true", help="바꾼 것·제안을 stderr로")
    ap.add_argument("--json", action="store_true", help="{text, report}를 JSON으로")
    ap.add_argument("--lexicon", default=LEX, help="slop_ko.json 경로")
    args = ap.parse_args()

    raw = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8-sig").read()
    lex = load_lexicon(args.lexicon)
    clean, report = humanize(raw, lex)

    if args.json:
        print(json.dumps({"text": clean, "report": report}, indent=2, ensure_ascii=False))
        return
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(clean)
        print(f"저장: {args.out}", file=sys.stderr)
    else:
        sys.stdout.write(clean)
    if args.report:
        render_report(report)


if __name__ == "__main__":
    main()
