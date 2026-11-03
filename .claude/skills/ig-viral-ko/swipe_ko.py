#!/usr/bin/env python3
"""
swipe_ko.py - 모아 온 릴스를 "자기 계정 평소보다 몇 배 터졌나"로 줄 세우고, 훅마다
공식 이름을 붙이고, 스와이프 파일(따라 찍을 공식 목록)을 쓴다. 한국어 전용.

원본: github.com/Jakeschincariol/instagram-agent-skill 의 ig-viral/swipe.py (MIT).
훅 분류는 ../ig-reel-ko/hooks_ko.json의 한국어 정규식, 채점은 ../ig-reel-ko/hookscore_ko.py.

이 스크립트가 바로잡는 것 하나: 조회수 숫자 자체는 근거가 아니다. 팔로워 200만 계정의
40만 회는 조용한 날이다. 팔로워 4천 계정의 40만 회는 뭔가를 찾은 거다. 그래서 그 계정의
최근 중앙값 대비 배수로 줄 세운다. 그게 "터졌다"의 유일하게 베낄 수 있는 정의다.

입력은 직접 둘러보며 채운 탭 구분 파일(TSV). 한 줄에 릴스 하나, 첫 줄은 열 이름:

    account   followers   median   views    hook
    @someone  48000       11000    412000   아무도 안 알려주는 귤 고르는 법

열 이름은 한국어도 된다: 계정, 팔로워, 중앙값, 조회수, 훅.
`median`은 그 계정 최근 릴스 12개쯤의 가운데 조회수. 이게 더 좋은 기준이다.
followers만 있으면 median을 비워 두면 되고, 스크립트가 그렇다고 알려 준다.
'#'로 시작하는 줄은 주석으로 건너뛴다.

사용법
  python -I swipe_ko.py captured.tsv                       # ~/.claude/instagram/swipe.md 에 기록
  python -I swipe_ko.py captured.tsv --out other.md
  python -I swipe_ko.py captured.tsv --no-write            # 화면에만
  python -I swipe_ko.py captured.tsv --json
"""

import argparse
import json
import os
import re
import statistics
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REEL_KO = os.path.normpath(os.path.join(HERE, "..", "ig-reel-ko"))
HOOKS = os.path.join(REEL_KO, "hooks_ko.json")
DEFAULT_OUT = os.path.join("~", ".claude", "instagram", "swipe.md")

try:                                              # 선택: 훅 채점도 같이
    sys.path.insert(0, REEL_KO)                   # python -I 라도 명시적으로 넣는다
    from hookscore_ko import concrete_markers, eojeol, syllables  # noqa: E402
    from hookscore_ko import run as score_hook    # noqa: E402
except Exception:                                 # ig-viral-ko만 따로 복사된 경우
    score_hook = None

    def eojeol(t):
        return t.split()

    def syllables(t):
        return len(re.findall(r"[가-힣]", t))

    def concrete_markers(t):
        return re.findall(r"\d[\d,.]*", t)

COL_ALIASES = {
    "account": "account", "계정": "account", "아이디": "account",
    "followers": "followers", "팔로워": "followers",
    "median": "median", "중앙값": "median", "평소": "median",
    "views": "views", "조회수": "views", "조회": "views",
    "hook": "hook", "훅": "hook", "첫줄": "hook", "첫 줄": "hook",
}


def load_formulas(path):
    try:
        d = json.load(open(path, encoding="utf-8"))
    except Exception:
        return None
    by_id = {h["id"]: h for h in d["hooks"]}
    order = d.get("classify_order") or sorted(by_id)
    return [(by_id[i]["id"], by_id[i]["name"], re.compile(by_id[i]["match"], re.IGNORECASE))
            for i in order if i in by_id]


def classify(hook, formulas):
    if not formulas:
        return None, "미분류"
    for fid, name, pattern in formulas:
        if pattern.search(hook):
            return fid, name
    return None, "미분류"


def to_int(s):
    """'1.2만', '41만', '412,000', '3.4K' 모두 숫자로."""
    s = (s or "").strip().replace(",", "")
    if not s:
        return None
    m = re.match(r"^([\d.]+)\s*(만|천|억|[kKmM])?", s)
    if not m:
        return None
    v = float(m.group(1))
    mult = {"천": 1e3, "만": 1e4, "억": 1e8, "k": 1e3, "K": 1e3, "m": 1e6, "M": 1e6}.get(m.group(2), 1)
    return int(v * mult)


def read_rows(path):
    raw = sys.stdin.read() if path == "-" else open(path, encoding="utf-8-sig").read()
    lines = [l for l in raw.splitlines() if l.strip() and not l.lstrip().startswith("#")]
    if not lines:
        return []
    head = [COL_ALIASES.get(c.strip().lower(), c.strip().lower()) for c in lines[0].split("\t")]
    if "views" in head and "hook" in head:
        cols, body = head, lines[1:]
    else:
        cols, body = ["account", "followers", "views", "hook"], lines
    rows = []
    for line in body:
        cells = line.split("\t")
        if len(cells) < len(cols):
            cells += [""] * (len(cols) - len(cells))
        r = dict(zip(cols, [c.strip() for c in cells]))
        r["views"] = to_int(r.get("views"))
        for k in ("followers", "median"):
            r[k] = to_int(r.get(k))
        if r["views"] and r.get("hook"):
            rows.append(r)
    return rows


def analyse(rows, formulas):
    used_median = any(r.get("median") for r in rows)
    for r in rows:
        base = r.get("median") or r.get("followers") or 0
        r["baseline"] = base
        r["outlier"] = round(r["views"] / base, 2) if base else None
        r["formula_id"], r["formula"] = classify(r["hook"], formulas)
        r["eojeol"] = len(eojeol(r["hook"]))
        r["syllables"] = syllables(r["hook"])
        r["concrete"] = len(concrete_markers(r["hook"]))
        if score_hook:
            _, overall, verdict, _ = score_hook(r["hook"])
            r["hook_score"], r["hook_verdict"] = round(overall, 1), verdict
        else:
            r["hook_score"], r["hook_verdict"] = None, None
    ranked = sorted(rows, key=lambda r: -(r["outlier"] or 0))
    third = max(1, len(ranked) // 3)
    top, bottom = ranked[:third], ranked[-third:]

    def med(items, key):
        vals = [i[key] for i in items if i.get(key) is not None]
        return round(statistics.median(vals), 1) if vals else None

    def share(items, key):
        return round(sum(1 for i in items if i.get(key)) / len(items), 2) if items else None

    def counts(items):
        c = {}
        for r in items:
            c[r["formula"]] = c.get(r["formula"], 0) + 1
        return sorted(c.items(), key=lambda kv: -kv[1])

    return {
        "baseline": "계정 중앙값" if used_median else "팔로워 수",
        "n": len(ranked),
        "accounts": len({r.get("account", "") for r in ranked}),
        "third": third,
        "reels": ranked,
        "outliers": [r for r in ranked if (r["outlier"] or 0) >= 3],
        "top_formulas": counts(top),
        "bottom_formulas": counts(bottom),
        "top_hook_score": med(top, "hook_score"),
        "bottom_hook_score": med(bottom, "hook_score"),
        "top_eojeol": med(top, "eojeol"),
        "bottom_eojeol": med(bottom, "eojeol"),
        "top_syllables": med(top, "syllables"),
        "bottom_syllables": med(bottom, "syllables"),
        "top_concrete_share": share(top, "concrete"),
        "bottom_concrete_share": share(bottom, "concrete"),
        "unclassified": [r for r in ranked if r["formula"] == "미분류"],
    }


def pad(s, width):
    """한글은 터미널에서 두 칸이라 f"{s:<12}"로는 열이 안 맞는다."""
    import unicodedata
    w = sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)
    return s + " " * max(0, width - w)


def fmt_mult(r):
    return f"{r['outlier']:.1f}배" if r["outlier"] else "?"


def render(a, out=sys.stdout):
    head = (f"스와이프 파일  ·  릴스 {a['n']}개  ·  계정 {a['accounts']}개  ·  "
            f"기준: {a['baseline']}")
    print("\n" + head, file=out)
    print("=" * 78, file=out)
    for r in a["reels"]:
        score = f"{r['hook_score']:.0f}" if r["hook_score"] is not None else " -"
        fid = f"#{r['formula_id']:<2}" if r["formula_id"] else "-  "
        print(f"  {fmt_mult(r):>7}  훅 {score:>3}  {fid} {pad(r['formula'][:10], 20)} "
              f"{r.get('account', '')[:16]:<16} {r['views']:>9,}", file=out)
        print(f"           \"{r['hook'][:60]}\"", file=out)
    print("-" * 78, file=out)
    print(f"이번 묶음에서 먹히는 것 (상위 1/3 = {a['third']}개 vs 하위 1/3 = {a['third']}개)", file=out)
    if a["top_formulas"]:
        print("  상위 공식:        " + ", ".join(f"{n} x{c}" for n, c in a["top_formulas"][:4]), file=out)
    if a["bottom_formulas"]:
        print("  하위 공식:        " + ", ".join(f"{n} x{c}" for n, c in a["bottom_formulas"][:4]), file=out)
    if a["top_hook_score"] is not None:
        print(f"  훅 점수 중앙값:   상위 {a['top_hook_score']:.0f}  vs  하위 {a['bottom_hook_score']:.0f}",
              file=out)
    print(f"  훅 길이 중앙값:   상위 {a['top_eojeol']}어절/{a['top_syllables']}음절  vs  "
          f"하위 {a['bottom_eojeol']}어절/{a['bottom_syllables']}음절", file=out)
    print(f"  숫자·이름 든 훅:  상위 {a['top_concrete_share']:.0%}  vs  하위 {a['bottom_concrete_share']:.0%}",
          file=out)
    print(f"\n미분류 {len(a['unclassified'])}개 / {a['n']}개 — 손으로 읽어라. "
          "hooks_ko.json에 아직 없는 공식이 숨어 있는 자리다.", file=out)
    for r in a["unclassified"]:
        print(f"  {fmt_mult(r):>7}  {r.get('account', '')[:16]:<16} \"{r['hook'][:60]}\"", file=out)
    print("\n  손으로 모은 묶음은 근거지 증명이 아니다. 12개로는 아무것도 안 보이고, "
          "\n  계정 6개에 걸친 40개쯤부터 뭔가 보인다. 믿기 전에 더 모아라.\n", file=out)


def to_markdown(a, source):
    lines = ["# 스와이프 파일", "",
             f"출처 파일: `{source}` · 릴스 {a['n']}개 · 계정 {a['accounts']}개 · "
             f"{a['baseline']} 대비 배수로 정렬.", "",
             "> 영상이 아니라 공식만 베낀다. 각 행은 원래 계정을 표기한다.", "",
             "## 상위 1/3 vs 하위 1/3", "",
             "- 상위 공식: " + (", ".join(f"{n} x{c}" for n, c in a["top_formulas"]) or "-"),
             "- 하위 공식: " + (", ".join(f"{n} x{c}" for n, c in a["bottom_formulas"]) or "-"),
             f"- 훅 점수 중앙값: 상위 {a['top_hook_score']} / 하위 {a['bottom_hook_score']}",
             f"- 훅 길이 중앙값: 상위 {a['top_eojeol']}어절 / 하위 {a['bottom_eojeol']}어절",
             f"- 숫자·이름 든 훅 비율: 상위 {a['top_concrete_share']:.0%} / "
             f"하위 {a['bottom_concrete_share']:.0%}", "",
             "## 릴스 (배수 순)", ""]
    for r in a["reels"]:
        lines += [f"### {fmt_mult(r)}  {r['formula']}  ({r.get('account', '')})",
                  f"- 조회수 {r['views']:,} · 기준 {r['baseline']:,}",
                  f"- 훅 점수 {r['hook_score']} · {r['eojeol']}어절 {r['syllables']}음절",
                  f"- 훅: \"{r['hook']}\"", ""]
    lines += [f"## 미분류 ({len(a['unclassified'])}개)", ""]
    lines += [f"- {fmt_mult(r)} {r.get('account', '')}: \"{r['hook']}\"" for r in a["unclassified"]] or ["- 없음"]
    return "\n".join(lines) + "\n"


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")    # 파이프 입력도 UTF-8로 (Windows 기본 cp949)
        sys.stdout.reconfigure(encoding="utf-8")   # Windows 콘솔에서 한글 깨짐 방지
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="모은 릴스를 계정 평소 대비 배수로 줄 세운다(한국어).")
    ap.add_argument("input", nargs="?", default="-", help="TSV 파일, 또는 - (표준입력)")
    ap.add_argument("--hooks", default=HOOKS, help="ig-reel-ko/hooks_ko.json 경로")
    ap.add_argument("--out", default=DEFAULT_OUT, help=f"스와이프 파일 경로 (기본 {DEFAULT_OUT})")
    ap.add_argument("--no-write", action="store_true", help="파일로 쓰지 않고 화면에만")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    rows = read_rows(args.input)
    if not rows:
        print("쓸 수 있는 행이 없다. 최소한 views와 hook 열이 있는 탭 구분 파일이 필요하다.",
              file=sys.stderr)
        sys.exit(2)
    formulas = load_formulas(args.hooks)
    a = analyse(rows, formulas)
    if not formulas:
        print("참고: hooks_ko.json을 못 찾아 공식 이름을 못 붙였다. --hooks로 경로를 줘라.", file=sys.stderr)
    if score_hook is None:
        print("참고: hookscore_ko.py를 못 불러와 훅 점수를 건너뛰었다.", file=sys.stderr)

    if args.json:
        print(json.dumps(a, indent=2, ensure_ascii=False))
    else:
        render(a)
    if not args.no_write:
        path = os.path.expanduser(args.out)
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(to_markdown(a, os.path.basename(args.input)))
        print(f"저장: {path}", file=sys.stderr)


if __name__ == "__main__":
    main()
