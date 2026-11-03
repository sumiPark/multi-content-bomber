#!/usr/bin/env python3
"""
beats_ko.py - 릴스 대본을 찍기 전에 비트(한 컷에 한 생각)로 나누고 시간을 매긴다.
한국어 전용.

원본: github.com/Jakeschincariol/instagram-agent-skill 의 ig-reel/beats.py (MIT).
원본은 영어 단어 수 ÷ 분당 단어(wpm)로 시간을 쟀다. 한국어는 어절 길이가 들쭉날쭉해서
음절 수 ÷ 음절/초로 잰다(hookscore_ko.py와 같은 음절 계산, 같은 기본 말속도).

편집에서 릴스를 죽이는 네 가지를 잡는다.
  - 3초를 넘기는 훅
  - 시청자가 떠날 만큼 긴 비트(4초 초과)
  - 확인할 거리(숫자·이름·인용)가 하나도 없는 비트가 3개 연속
  - 마지막 비트가 훅의 말을 되받지 않음(루프 없음)
그리고 --target을 주면 목표 길이와의 차이.

시간은 추정이다. 편집 계획에는 충분하지만 녹음을 대신하지 않는다. 대본 하나를 소리 내어
읽으며 재 보고 --sps로 본인 속도를 넣어라.

사용법
  python -I beats_ko.py script.txt
  python -I beats_ko.py script.txt --target 20
  python -I beats_ko.py script.txt --sps 7 --target 30
  python -I beats_ko.py script.txt --json
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)                 # python -I 는 스크립트 폴더를 sys.path에 안 넣는다
from hookscore_ko import (SYLLABLES_PER_SEC, concrete_markers, eojeol,  # noqa: E402
                          strip_josa, syllables)

# 문장 끝: 마침표·물음표·느낌표, 또는 줄임표
SENT_RE = re.compile(r"[^.!?…]+(?:[.!?…]+|$)")

# 루프 비교에서 뺄 말(어느 대본에나 나오는 말)
STOPWORDS = {
    "이거", "그거", "저거", "이건", "그건", "이게", "그게", "진짜", "정말", "너무", "그냥", "이렇게",
    "그렇게", "제가", "저는", "저희", "우리", "여러분", "오늘", "하면", "해요", "있어요", "없어요",
    "돼요", "거예요", "그리고", "근데", "그래서", "하나", "이제", "지금", "바로", "같이", "보세요",
    "하세요", "주세요", "있는", "하는", "되는", "해서", "하고", "이번", "여기", "거기", "많이", "조금",
}

HOOK_WINDOW = 3.0        # 초. 이걸 넘기면 손가락은 이미 결정했다.
MAX_BEAT = 4.0           # 초. 화면 변화 없이 한 생각에 머무는 최대 시간.
ABSTRACT_RUN = 3         # 확인할 거리 없는 비트가 이만큼 연속이면 경고.


def tc(seconds):
    m, s = divmod(seconds, 60)
    return f"{int(m)}:{s:04.1f}"


def split_beats(raw, sps):
    """한 줄이 한 비트. 다만 한 줄이 너무 길면 문장 끝에서 자른다."""
    beats = []
    for line in [l.strip() for l in raw.splitlines()]:
        if not line or line.startswith("#"):
            continue
        if syllables(line) / sps <= MAX_BEAT * 1.5:
            beats.append(line)
            continue
        parts = [p.strip() for p in SENT_RE.findall(line) if p.strip()]
        buf = ""
        for part in parts:
            candidate = (buf + " " + part).strip()
            if buf and syllables(candidate) / sps > MAX_BEAT:
                beats.append(buf)
                buf = part
            else:
                buf = candidate
        if buf:
            beats.append(buf)
    return beats


def stems(text):
    """루프 비교용 어간 집합: 조사 뗀 두 음절 이상 말, 숫자+단위."""
    out = set()
    for tok in eojeol(text):
        s = strip_josa(tok)
        s = re.sub(r"[^\w가-힣]", "", s)
        if len(s) >= 2 and s not in STOPWORDS:
            out.add(s)
    return out


def find_loop(first, last):
    a, b = stems(first), stems(last)
    shared = set(a & b)
    # 조사·어미가 달라도 앞부분이 같으면 같은 말("샤인머스캣은" / "샤인머스캣")
    for x in a:
        for y in b:
            if x != y and len(x) >= 2 and len(y) >= 2 and (x.startswith(y) or y.startswith(x)):
                shared.add(min(x, y, key=len))
    return sorted(shared)


def analyse(raw, sps=SYLLABLES_PER_SEC, target=None):
    beats = split_beats(raw, sps)
    if not beats:
        return None

    rows, clock = [], 0.0
    for i, text in enumerate(beats):
        syl = syllables(text)
        dur = syl / sps
        markers = concrete_markers(text)
        rows.append({
            "n": i + 1,
            "start": round(clock, 2),
            "dur": round(dur, 2),
            "eojeol": len(eojeol(text)),
            "syllables": syl,
            "text": text,
            "concrete": len(markers),
            "markers": markers,
            "label": "",
            "flags": [],
        })
        clock += dur
    total = round(clock, 1)               # 머리말과 메모가 같은 숫자를 보이게

    # 릴스가 실제로 짜이는 자리에 이름을 붙인다.
    for r in rows:
        if r["n"] == 1 or r["start"] + r["dur"] <= HOOK_WINDOW:
            r["label"] = "훅"
    rows[-1]["label"] = "요청" if rows[-1]["label"] != "훅" else "훅/요청"
    half = total / 2
    for r in rows:
        if not r["label"] and r["start"] <= half < r["start"] + r["dur"]:
            r["label"] = "중간"

    notes = []
    if rows[0]["dur"] > HOOK_WINDOW:
        rows[0]["flags"].append(f"훅이 {rows[0]['dur']:.1f}초, {HOOK_WINDOW:.0f}초 넘김")
        notes.append(f"1번 비트는 말하는 데 {rows[0]['dur']:.1f}초 걸린다. "
                     f"{int(HOOK_WINDOW * sps)}음절 이하로 줄여라. 안 그러면 훅이 결정 뒤에 도착한다.")
    if rows[0]["concrete"] == 0:
        notes.append("1번 비트에 숫자도 이름도 없다. 확인할 거리 없는 훅이 넘겨지는 훅이다.")

    for r in rows:
        if r["dur"] > MAX_BEAT:
            r["flags"].append(f"한 비트에 {r['dur']:.1f}초")
    long_beats = [r["n"] for r in rows if r["dur"] > MAX_BEAT]
    if long_beats:
        notes.append(f"{', '.join(map(str, long_beats))}번 비트가 {MAX_BEAT:.0f}초를 넘는다. "
                     "줄을 나누거나 그 안에서 화면을 바꿔라. 멈춘 화면에서 사람이 나간다.")

    run, start = 0, None
    for r in rows:
        if r["concrete"] == 0:
            run += 1
            start = start if start is not None else r["n"]
            if run == ABSTRACT_RUN:
                notes.append(f"{start}~{r['n']}번 비트에 구체적인 게 하나도 없다. "
                             "그중 하나에 숫자, 이름, 가격을 넣어라.")
        else:
            run, start = 0, None

    loop = find_loop(rows[0]["text"], rows[-1]["text"]) if len(rows) > 1 else []
    if loop:
        notes.append(f"루프 있음: 마지막 비트가 훅의 \"{', '.join(loop[:3])}\"(을)를 되받는다. "
                     "두 번째 재생은 공짜 도달이다.")
    else:
        notes.append("루프 없음. 마지막 비트가 훅과 겹치는 말이 없어 영상이 밋밋하게 끝난다. "
                     "1번 비트의 말 하나를 되받는 게 가장 싼 재생이다.")

    if target:
        delta = total - target
        if abs(delta) <= target * 0.1:
            notes.append(f"길이 목표 안 ({total:.1f}초 / 목표 {target:.0f}초).")
        elif delta > 0:
            notes.append(f"목표보다 {delta:.1f}초 길다. 약 {int(delta * sps)}음절을 줄여라.")
        else:
            notes.append(f"목표보다 {-delta:.1f}초 짧다. 약 {int(-delta * sps)}음절을 더하거나 "
                         "짧게 찍어라. 대개 짧은 쪽이 맞다.")

    return {
        "sps": sps, "target": target,
        "total_seconds": round(total, 2),
        "total_syllables": sum(r["syllables"] for r in rows),
        "total_eojeol": sum(r["eojeol"] for r in rows),
        "beats": rows,
        "notes": notes,
    }


def render(a, out=sys.stdout):
    head = (f"비트 시트  ·  {a['total_eojeol']}어절 {a['total_syllables']}음절  ·  "
            f"약 {a['total_seconds']:.1f}초 (음절/초 {a['sps']:g})"
            + (f"  ·  목표 {a['target']:g}초" if a["target"] else ""))
    print("\n" + head, file=out)
    print("=" * 72, file=out)
    for r in a["beats"]:
        label = r["label"] or ""
        label = label + " " * max(0, 8 - 2 * len(label))      # 한글 두 칸 기준 정렬
        print(f"  {tc(r['start'])}  {r['dur']:4.1f}s  {label}{r['text']}", file=out)
        for f in r["flags"]:
            print(f"  {'':>6}  {'':>5}  {'':<8}^ {f}", file=out)
    print("-" * 72, file=out)
    for n in a["notes"]:
        print(f"  - {n}", file=out)
    print("", file=out)


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")    # 파이프 입력도 UTF-8로 (Windows 기본 cp949)
        sys.stdout.reconfigure(encoding="utf-8")   # Windows 콘솔에서 한글 깨짐 방지
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="릴스 대본을 비트 시트로 나누고 시간을 매긴다(한국어).")
    ap.add_argument("input", nargs="?", default="-", help="대본 파일, 또는 - (표준입력)")
    ap.add_argument("--sps", type=float, default=SYLLABLES_PER_SEC,
                    help=f"말속도, 음절/초 (기본 {SYLLABLES_PER_SEC})")
    ap.add_argument("--target", type=float, help="목표 길이(초)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    raw = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8-sig").read()
    a = analyse(raw, sps=args.sps, target=args.target)
    if not a:
        print("빈 대본", file=sys.stderr)
        sys.exit(2)
    if args.json:
        print(json.dumps(a, indent=2, ensure_ascii=False))
    else:
        render(a)
    sys.exit(0)


if __name__ == "__main__":
    main()
