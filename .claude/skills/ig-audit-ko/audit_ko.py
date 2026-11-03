#!/usr/bin/env python3
"""
audit_ko.py - 이미 올린 게시물을 "그 계정 평소보다 몇 배였나"로 줄 세우고, 잘된 것과 안된 것을
가르는 차이를 찾는다. 한국어 전용.

원본: github.com/Jakeschincariol/instagram-agent-skill 의 ig-audit (MIT). 원본은 계산을 AI에
맡기는데, 이 스크립트가 숫자를 먼저 계산하고 AI는 해석만 한다 - 같은 데이터면 같은 표가 나온다.
훅 공식 분류는 ../ig-reel-ko/hooks_ko.json.

조회수 자체는 가장 덜 쓸모 있는 숫자다. 대부분 팔로워 수로 정해진다. 그래서:

  배수          조회 ÷ 그 계정 조회 중앙값        진짜 터졌나, 평범한 날이었나
  공유/도달     공유 ÷ 도달 (1,000명당)          얻을 수 있는 가장 강한 신호. 자기 이름을 걸고 보낸 것
  저장/도달     저장 ÷ 도달 (1,000명당)          나중에 다시 볼 만했나
  팔로우/도달   팔로우 ÷ 도달 (1,000명당)        관심이 프로필에서 팔로우로 바뀌었나 (있을 때만)
  3초 유지      3초 시청자 ÷ 시작한 시청자       훅 점수 (API에 없음 - 직접 넣었을 때만)
  비팔로워 도달 도달 중 비팔로워 %               밖으로 퍼졌나 (API에 없음 - 직접 넣었을 때만)

입력은 JSON 배열 또는 TSV(첫 줄 열 이름). 열:
  id, posted_at(ISO), format(REELS/FEED/CAROUSEL_ALBUM/IMAGE/VIDEO), views, reach, likes,
  comments, saves, shares, follows, watch_sec(평균 시청 초), length_sec(영상 길이),
  hold3s(%), nonfollower(%), hook(첫 줄 - 없으면 caption 첫 줄), caption, slot(예: "08시 AI")
TSV 열 이름은 한국어도 된다: 조회수, 도달, 저장, 공유, 팔로우, 길이, 훅, 칸 ...

사용법
  python -I audit_ko.py posts.json
  python -I audit_ko.py posts.tsv --json
  python -I audit_ko.py posts.json --min-age-days 3 --now 2026-11-03T12:00:00+09:00
"""

import argparse
import json
import os
import re
import statistics
import sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
HOOKS = os.path.normpath(os.path.join(HERE, "..", "ig-reel-ko", "hooks_ko.json"))
KST = timezone(timedelta(hours=9))
WEEKDAYS = ["월", "화", "수", "목", "금", "토", "일"]

COL_ALIASES = {
    "아이디": "id", "게시물": "id",
    "올린날": "posted_at", "올린 시각": "posted_at", "날짜": "posted_at",
    "형식": "format", "종류": "format",
    "조회수": "views", "조회": "views",
    "도달": "reach",
    "좋아요": "likes",
    "댓글": "comments",
    "저장": "saves", "saved": "saves",
    "공유": "shares", "보내기": "shares",
    "팔로우": "follows",
    "평균시청": "watch_sec", "시청": "watch_sec",
    "길이": "length_sec",
    "3초유지": "hold3s", "3초": "hold3s",
    "비팔로워": "nonfollower",
    "훅": "hook", "첫줄": "hook", "첫 줄": "hook",
    "캡션": "caption",
    "칸": "slot", "편성": "slot",
}
NUM_COLS = ("views", "reach", "likes", "comments", "saves", "shares", "follows",
            "watch_sec", "length_sec", "hold3s", "nonfollower")


def to_num(v):
    """'1.2만', '41만', '4,100', '3.4K', '62%' 모두 숫자로."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").rstrip("%")
    if not s:
        return None
    m = re.match(r"^([\d.]+)\s*(만|천|억|[kKmM])?$", s)
    if not m:
        return None
    mult = {"천": 1e3, "만": 1e4, "억": 1e8, "k": 1e3, "K": 1e3, "m": 1e6, "M": 1e6}.get(m.group(2), 1)
    return float(m.group(1)) * mult


def read_posts(path):
    raw = sys.stdin.read() if path == "-" else open(path, encoding="utf-8-sig").read()
    raw = raw.strip()
    if raw.startswith("["):
        rows = json.loads(raw)
    else:
        lines = [l for l in raw.splitlines() if l.strip() and not l.lstrip().startswith("#")]
        if not lines:
            return []
        head = [COL_ALIASES.get(c.strip(), c.strip().lower()) for c in lines[0].split("\t")]
        rows = []
        for line in lines[1:]:
            cells = line.split("\t") + [""] * len(head)
            rows.append({h: c.strip() for h, c in zip(head, cells)})
    out = []
    for r in rows:
        p = dict(r)
        for k in NUM_COLS:
            p[k] = to_num(r.get(k))
        if not p.get("hook"):
            cap = (r.get("caption") or "").strip()
            p["hook"] = cap.splitlines()[0].strip() if cap else ""
        out.append(p)
    return out


def parse_time(s):
    if not s:
        return None
    try:
        t = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=KST)
    except ValueError:
        return None


def load_formulas():
    try:
        d = json.load(open(HOOKS, encoding="utf-8"))
    except Exception:
        return None
    by_id = {h["id"]: h for h in d["hooks"]}
    order = d.get("classify_order") or sorted(by_id)
    return [(i, by_id[i]["name"], re.compile(by_id[i]["match"], re.IGNORECASE)) for i in order if i in by_id]


def classify(hook, formulas):
    if not formulas or not hook:
        return "미분류"
    for _, name, pat in formulas:
        if pat.search(hook):
            return name
    return "미분류"


def per_k(a, b):
    if a is None or not b:
        return None
    return a / b * 1000


def length_bucket(sec):
    if sec is None:
        return None
    if sec < 15:
        return "15초 미만"
    if sec < 30:
        return "15~30초"
    if sec < 60:
        return "30~60초"
    return "60초 이상"


FORMAT_KO = {"REELS": "릴스", "VIDEO": "릴스", "CAROUSEL_ALBUM": "캐러셀", "IMAGE": "사진", "FEED": "피드"}


def confidence(n):
    if n >= 30:
        return "패턴을 볼 수 있음"
    if n >= 10:
        return "약한 신호 - 단정하지 말 것"
    return "판단 보류 - 게시물이 너무 적음"


def mean(xs):
    xs = [x for x in xs if x is not None]
    return statistics.mean(xs) if xs else None


def group_compare(posts, key, label, min_n=3):
    groups = {}
    for p in posts:
        k = p.get(key)
        if k and k != "미분류":            # 미분류 묶음은 공식이 아니다
            groups.setdefault(k, []).append(p)
    if len(groups) < 2:
        return None
    rows = []
    for k, ps in groups.items():
        rows.append({
            "group": k,
            "n": len(ps),
            "mean_multiple": round(mean([p["multiple"] for p in ps]), 2),
            "sends_per_k": round(mean([p["sends_per_k"] for p in ps]) or 0, 2),
            "thin": len(ps) < min_n,
        })
    rows.sort(key=lambda r: -r["mean_multiple"])
    solid = [r for r in rows if not r["thin"]]
    gap = round(solid[0]["mean_multiple"] - solid[-1]["mean_multiple"], 2) if len(solid) >= 2 else None
    return {"by": label, "rows": rows, "gap": gap}


def run(posts, min_age_days=3, now=None):
    now = now or datetime.now(KST)
    notes = []
    young = []
    usable = []
    for p in posts:
        t = parse_time(p.get("posted_at"))
        p["_t"] = t
        if t and (now - t) < timedelta(days=min_age_days):
            young.append(p)
            continue
        if p.get("views") is None:
            continue
        usable.append(p)
    if young:
        notes.append(f"올린 지 {min_age_days}일 안 된 게시물 {len(young)}개는 숫자가 아직 커지는 중이라 뺐다")
    if not usable:
        return {"n": 0, "notes": notes + ["계산할 게시물이 없다"], "top": [], "bottom": [], "groups": []}

    med = statistics.median([p["views"] for p in usable]) or 1
    formulas = load_formulas()
    for p in usable:
        p["multiple"] = round(p["views"] / med, 2)
        p["sends_per_k"] = per_k(p.get("shares"), p.get("reach"))
        p["saves_per_k"] = per_k(p.get("saves"), p.get("reach"))
        p["follows_per_k"] = per_k(p.get("follows"), p.get("reach"))
        p["formula"] = classify(p.get("hook"), formulas)
        p["format_ko"] = FORMAT_KO.get((p.get("format") or "").upper(), p.get("format") or None)
        p["length"] = length_bucket(p.get("length_sec"))
        p["weekday"] = WEEKDAYS[p["_t"].astimezone(KST).weekday()] + "요일" if p["_t"] else None

    # 배수 먼저, 같으면 공유/도달
    ranked = sorted(usable, key=lambda p: (-p["multiple"], -(p["sends_per_k"] or 0)))
    k = min(5, len(ranked) // 2) or 1
    top, bottom = ranked[:k], ranked[-k:][::-1] if len(ranked) > k else []

    def slim(p):
        return {
            "id": p.get("id"),
            "posted_at": p.get("posted_at"),
            "hook": (p.get("hook") or "")[:60],
            "format": p["format_ko"],
            "slot": p.get("slot"),
            "views": int(p["views"]),
            "multiple": p["multiple"],
            "sends_per_k": round(p["sends_per_k"], 2) if p["sends_per_k"] is not None else None,
            "saves_per_k": round(p["saves_per_k"], 2) if p["saves_per_k"] is not None else None,
            "follows_per_k": round(p["follows_per_k"], 2) if p["follows_per_k"] is not None else None,
            "watch_sec": p.get("watch_sec"),
            "hold3s": p.get("hold3s"),
            "nonfollower": p.get("nonfollower"),
            "formula": p["formula"],
        }

    # 차이를 가르는 순서: 3초 유지 → 훅 공식 → 형식 → 길이 → 칸 → 요일(맨 마지막)
    groups = []
    if any(p.get("hold3s") is not None for p in top + bottom):
        t3 = mean([p.get("hold3s") for p in top])
        b3 = mean([p.get("hold3s") for p in bottom])
        if t3 is not None and b3 is not None:
            groups.append({"by": "3초 유지", "top_mean": round(t3, 1), "bottom_mean": round(b3, 1),
                           "gap": round(t3 - b3, 1)})
    for key, label in (("formula", "훅 공식"), ("format_ko", "형식"), ("length", "길이"),
                       ("slot", "편성 칸"), ("weekday", "요일")):
        g = group_compare(usable, key, label)
        if g:
            groups.append(g)
    if any(g["by"] == "편성 칸" for g in groups):
        notes.append("편성 칸은 시간대와 방식(AI 자동 · 직접 촬영)이 묶여 있다 - 칸 차이를 시간대 효과로만 읽지 말 것")
    notes.append("요일 · 시각은 원인인 경우가 거의 없다 - 다른 차이가 없을 때만 본다")
    if not any(p.get("hold3s") is not None for p in usable):
        notes.append("3초 유지율이 없다 (API에 없음) - 훅이 문제인지는 인사이트 화면 유지율 그래프로 확인")

    # 조회는 나오는데 팔로우가 없으면 훅 문제가 아니라 프로필 문제
    diagnosis = None
    nf = [p for p in usable if p.get("nonfollower") is not None and p.get("follows_per_k") is not None]
    if nf:
        hi_reach = [p for p in nf if p["nonfollower"] >= 40]
        if hi_reach and mean([p["follows_per_k"] for p in hi_reach]) < 2:
            diagnosis = "비팔로워 도달은 높은데 팔로우가 거의 없다 - 훅이 아니라 프로필 문제. /ig-profile-ko 먼저"
    elif all(p.get("follows_per_k") is None for p in usable):
        notes.append("게시물별 팔로우 수가 없다 - 프로필 문제인지 훅 문제인지는 계정 팔로워 증감과 같이 본다")

    return {
        "n": len(usable),
        "median_views": int(med),
        "period": [min((p["_t"] for p in usable if p["_t"]), default=None),
                   max((p["_t"] for p in usable if p["_t"]), default=None)],
        "confidence": confidence(len(usable)),
        "top": [slim(p) for p in top],
        "bottom": [slim(p) for p in bottom],
        "groups": groups,
        "diagnosis": diagnosis,
        "notes": notes,
    }


def fmt_k(v):
    return "-" if v is None else f"{v:.1f}"


def render(r):
    if not r["n"]:
        return "\n".join(r["notes"])
    p0, p1 = r["period"]
    span = f"{p0.astimezone(KST):%m-%d} ~ {p1.astimezone(KST):%m-%d}" if p0 and p1 else "기간 모름"
    out = [f"분석  ·  게시물 {r['n']}개  ·  {span}  ·  조회 중앙값 {r['median_views']:,}  ·  {r['confidence']}", ""]
    for title, rows in (("배수 상위", r["top"]), ("배수 하위", r["bottom"])):
        out.append(title)
        for p in rows:
            out.append(f"  {p['multiple']:>5.1f}배  {p['views']:>8,}회  공유 {fmt_k(p['sends_per_k'])}‰  "
                       f"저장 {fmt_k(p['saves_per_k'])}‰  [{p['formula']}]  {p['hook']}")
        out.append("")
    out.append("가르는 차이")
    for g in r["groups"]:
        if "rows" in g:
            cells = ", ".join(f"{x['group']} {x['mean_multiple']}배(n={x['n']}{'·적음' if x['thin'] else ''})"
                              for x in g["rows"])
            out.append(f"  {g['by']}: {cells}")
        else:
            out.append(f"  {g['by']}: 상위 {g['top_mean']}% vs 하위 {g['bottom_mean']}%")
    if r["diagnosis"]:
        out += ["", "진단: " + r["diagnosis"]]
    out += [""] + ["참고: " + n for n in r["notes"]]
    return "\n".join(out)


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")    # 파이프 입력도 UTF-8로 (Windows 기본 cp949)
        sys.stdout.reconfigure(encoding="utf-8")   # -I는 PYTHONIOENCODING을 무시한다
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="게시물 성과 분석 (한국어)")
    ap.add_argument("file", help="JSON 배열 또는 TSV, '-'면 표준입력")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--min-age-days", type=int, default=3)
    ap.add_argument("--now", help="기준 시각 ISO (시험용)")
    a = ap.parse_args()
    r = run(read_posts(a.file), a.min_age_days, parse_time(a.now) if a.now else None)
    if a.json:
        print(json.dumps(r, ensure_ascii=False, default=lambda o: o.isoformat() if isinstance(o, datetime) else str(o)))
    else:
        print(render(r))


if __name__ == "__main__":
    main()
