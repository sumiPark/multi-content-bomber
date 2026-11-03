#!/usr/bin/env python3
"""
profile_ko.py - 인스타 프로필의 "규칙으로 판정할 수 있는 부분"을 검사하고 점수를 매긴다. 한국어 전용.

원본: github.com/Jakeschincariol/instagram-agent-skill 의 ig-profile (MIT). 원본은 채점을
전부 사람(AI)의 판단에 맡기는데, 그러면 같은 프로필을 두 번 채점할 때 점수가 흔들린다.
그래서 12개 항목을 둘로 나눈다:

  기계 채점 (이 스크립트가 점수까지): 아이디 · 링크 · 하이라이트 · 고정 게시물 3개 ·
      카테고리 · 연락 · 최근 활동 · 스토리
  판단 채점 (이 스크립트는 근거만 모으고 점수는 null): 이름 칸 · 소개 첫 줄 · 소개 나머지 ·
      피드 첫 9칸 · 프로필 사진

이름 칸 · 소개는 글자 수 · 광고 금지 표현처럼 기계로 잡히는 것만 findings로 알려 주고,
읽히는지 여부는 판단 채점이 정한다. 기준은 같은 폴더 rubric_ko.json.

입력은 JSON 하나 (모르는 칸은 빼거나 null):

    {
      "handle": "fruit_cuma",
      "name": "오늘과일 | 제철 과일 산지직송",
      "bio": "첫 줄\\n둘째 줄",
      "links": ["https://..."],
      "account_type": "BUSINESS",          # BUSINESS / CREATOR / PERSONAL
      "category": "쇼핑 및 리테일",
      "contact": true,                      # 연락 버튼(메일 · 전화 · 카톡 채널) 있음
      "highlights": ["주문방법", "후기"],
      "pinned_count": 3,
      "grid_covers": ["표지 글자", ""],     # 첫 9칸 표지 문구 (없으면 빈 문자열)
      "days_since_last_post": 2,
      "unanswered_comments": 0,             # 최근 게시물에서 답 안 한 댓글 수
      "story_days_per_week": 5,             # 최근 7일 중 스토리 올린 날 (또는 story_active)
      "story_active": true,
      "role_focus": "PRODUCT"               # PRODUCT / PERSON (계정 역할)
    }

사용법
  python -I profile_ko.py profile.json
  python -I profile_ko.py profile.json --json
  python -I profile_ko.py - --json < profile.json
"""

import argparse
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUBRIC = os.path.join(HERE, "rubric_ko.json")

NAME_MAX = 30      # 이름 칸 권장 글자 수 (실제로는 더 길게도 저장된다 - 2026-11 실측 32자)
BIO_MAX = 150      # 소개 글자 수 제한

# 광고 표현 규칙에서 소개 글에 자주 걸리는 것만 추린다 (전체 규칙은 MCB 광고 문구 규칙).
BANNED = [
    (r"최고|최상|최강|가장\s*좋은", "최상급 표현"),
    (r"유일|단\s*하나뿐", "'유일' 표현"),
    (r"100\s*%|백\s*퍼", "'100%' 절대 표현"),
    (r"1\s*위|넘버\s*원|no\.?\s*1", "근거 없는 순위 표현(출처 · 기간이 함께 없으면 금지)"),
    (r"치료|완치|특효|예방|재생|염증", "질병 · 의약품 오인 표현"),
    (r"부작용\s*(없|0)|무조건|완벽", "절대 · 보장 표현"),
]

VAGUE_HIGHLIGHT = re.compile(
    r"^(일상|데일리|daily|기록|추억|잡담|random|life|faves?|favorites?|사진|기타|etc|♡|❤️?|💕|🖤|✨|\d{2,4}(년)?)$",
    re.IGNORECASE,
)
BUYER_HIGHLIGHT = re.compile(
    r"주문|구매|배송|택배|후기|리뷰|상품|제품|정보|사용법|가격|이벤트|혜택|문의|faq|q\s*&\s*a|교환|반품|사이즈|성분|about|소개",
    re.IGNORECASE,
)
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿❤️]")


def load_rubric():
    with open(RUBRIC, encoding="utf-8") as f:
        d = json.load(f)
    return {it["id"]: it for it in d["items"]}


def clen(s):
    """인스타가 세는 글자 수에 가깝게: 줄바꿈 포함, 이모지 1자."""
    return len(s or "")


def banned_hits(text):
    hits = []
    for pat, label in BANNED:
        m = re.search(pat, text or "", re.IGNORECASE)
        if m:
            hits.append(f"'{m.group(0)}' - {label}")
    return hits


def item(rub, iid, score, findings):
    return {
        "id": iid,
        "label": rub[iid]["label"],
        "max": rub[iid]["points"],
        "score": score,              # None = 판단 채점 필요
        "auto": score is not None,
        "findings": findings,
    }


# ---------------------------------------------------------------- 판단 항목 (근거만)

def check_name(p, rub):
    name = (p.get("name") or "").strip()
    handle = (p.get("handle") or "").lstrip("@")
    f = []
    if not name:
        f.append("이름 칸이 비어 있다 - 검색에 걸릴 단어가 하나도 없음")
    else:
        n = clen(name)
        f.append(f"{n}/{NAME_MAX}자")
        if n > NAME_MAX:
            f.append("30자를 넘음 - 길면 한눈에 안 읽힌다. 검색되는 단어를 앞쪽에")
        words = [w for w in re.split(r"[\s|·/,]+", name) if w]
        if len(words) <= 1:
            f.append("단어가 하나뿐 - 브랜드 이름만 있고 상품 단어가 없음")
        if not re.search(r"[가-힣]", name):
            f.append("한글이 없음 - 한국어 검색어에 안 걸림")
        if handle and name.replace(" ", "").lower() == handle.replace("_", "").replace(".", "").lower():
            f.append("아이디와 같은 글자 - 이름 칸을 검색어로 쓰지 않음")
        if EMOJI.search(name):
            f.append("이모지가 글자 자리를 차지함")
    return item(rub, "name_field", None, f)


def bio_lines(p):
    return [l.strip() for l in (p.get("bio") or "").splitlines() if l.strip()]


def check_bio_first(p, rub):
    lines = bio_lines(p)
    f = []
    if not lines:
        f.append("소개가 비어 있다")
    else:
        first = lines[0]
        f.append(f"첫 줄: {first}")
        if first.count("|") >= 2 or first.count("·") >= 2 or first.count("/") >= 2:
            f.append("막대 · 가운뎃점으로 이은 키워드 묶음 - 문장이 아님")
        if len(EMOJI.findall(first)) >= 3:
            f.append("이모지가 3개 이상")
        if clen(first) < 8:
            f.append("너무 짧음 - 누구에게 무엇을 주는지 담기 어렵다")
    return item(rub, "bio_first_line", None, f)


def check_bio_body(p, rub):
    bio = p.get("bio") or ""
    f = []
    n = clen(bio)
    f.append(f"소개 전체 {n}/{BIO_MAX}자")
    if n > BIO_MAX:
        f.append("150자를 넘음 - 저장이 안 된다")
    lines = bio_lines(p)
    if len(lines) <= 1:
        f.append("첫 줄 뒤에 증거 · 혜택 문장이 없음")
    if not re.search(r"\d", bio):
        f.append("숫자가 하나도 없음 - 증거(후기 수 · 재구매 수 등)가 있으면 숫자로")
    hits = banned_hits(bio)
    for h in hits:
        f.append(f"광고 표현 규칙 위반 가능: {h}")
    return item(rub, "bio_body", None, f)


def check_grid(p, rub):
    covers = p.get("grid_covers")
    f = []
    if covers is None:
        f.append("첫 9칸 표지 정보 없음 - 화면을 보고 판단")
    else:
        covers = list(covers)[:9]
        with_text = [c for c in covers if (c or "").strip()]
        f.append(f"첫 {len(covers)}칸 중 표지 글자 있는 칸 {len(with_text)}개")
        long_ones = [c for c in with_text if len(re.sub(r"\s", "", c)) > 14]
        if long_ones:
            f.append(f"글자가 긴 표지 {len(long_ones)}개 - 썸네일에서 안 읽힘(4~8자 권장)")
    return item(rub, "grid_legibility", None, f)


def check_photo(p, rub):
    role = (p.get("role_focus") or "").upper()
    f = []
    if role == "PRODUCT":
        f.append("상품 중심 계정 - 원 안에서 읽히는 로고인지 본다")
    elif role == "PERSON":
        f.append("사람 중심 계정 - 얼굴이 원의 60% 정도인지 본다")
    else:
        f.append("계정 역할을 모름 - 로고인지 얼굴인지 먼저 정한다")
    if p.get("profile_picture_url") is None and p.get("has_photo") is False:
        f.append("프로필 사진 없음")
    return item(rub, "photo", None, f)


# ---------------------------------------------------------------- 기계 채점 항목

def score_handle(p, rub):
    h = (p.get("handle") or "").lstrip("@")
    mx = rub["handle"]["points"]
    if not h:
        return item(rub, "handle", None, ["아이디를 모름"])
    f, pen = [], 0
    if "__" in h or h.count("_") + h.count(".") >= 3:
        f.append("밑줄 · 마침표가 많아 말로 전하기 어렵다"); pen += 2
    if re.search(r"[a-z][0-9]|[0-9][a-z]", h, re.IGNORECASE) and re.search(r"\d", h):
        f.append("글자 사이 숫자 - 듣고 따라 적기 어렵다"); pen += 2
    if len(h) > 20:
        f.append(f"{len(h)}자로 김"); pen += 1
    if p.get("shop_handle_match") is False:
        f.append("몰 이름 · 다른 채널 이름과 다름"); pen += 2
    if not f:
        f.append("읽기 쉬운 아이디")
    return item(rub, "handle", max(0, mx - pen), f)


def score_link(p, rub):
    links = [l for l in (p.get("links") or []) if (l or "").strip()]
    mx = rub["link"]["points"]
    n = len(links)
    if n == 0:
        return item(rub, "link", 0, ["링크 없음"])
    f = [f"링크 {n}개"]
    if any(re.search(r"linktr\.ee|lit\.link|inpock|link\.inpock|litt\.ly|beacons\.ai", l, re.I) for l in links):
        f.append("링크 모음 페이지 - 메뉴는 문 하나보다 덜 팔린다")
        return item(rub, "link", 4, f)
    if n == 1:
        f.append("목적지 하나 - 소개 약속과 맞는지는 눈으로 확인")
        return item(rub, "link", mx, f)
    if n == 2:
        return item(rub, "link", 6, f + ["둘부터는 메뉴"])
    return item(rub, "link", 3, f + ["3개 이상 - 고르다 떠난다"])


def score_highlights(p, rub):
    hl = p.get("highlights")
    mx = rub["highlights"]["points"]
    if hl is None:
        return item(rub, "highlights", None, ["하이라이트 정보 없음 - API로 안 나와 직접 입력해야 함"])
    hl = [h.strip() for h in hl if (h or "").strip()]
    n = len(hl)
    if n == 0:
        return item(rub, "highlights", 0, ["하이라이트 없음"])
    vague = [h for h in hl if VAGUE_HIGHLIGHT.match(h)]
    buyer = [h for h in hl if BUYER_HIGHLIGHT.search(h)]
    f = [f"{n}개 - 구매 질문 이름 {len(buyer)}개, 뜻 없는 이름 {len(vague)}개"]
    s = mx
    if n < 4:
        s -= 2; f.append("4개 미만")
    if n > 6:
        s -= 2; f.append("6개 초과 - 정리 필요")
    if vague:
        s -= min(4, 2 * len(vague)); f.append("뜻 없는 이름: " + ", ".join(vague))
    if not buyer:
        s -= 3; f.append("주문 · 배송 · 후기 같은 구매 질문 이름이 하나도 없음")
    return item(rub, "highlights", max(0, s), f)


def score_pinned(p, rub):
    n = p.get("pinned_count")
    mx = rub["pinned_three"]["points"]
    if n is None:
        return item(rub, "pinned_three", None, ["고정 게시물 정보 없음 - API로 안 나와 직접 입력해야 함"])
    if n <= 0:
        return item(rub, "pinned_three", 0, ["고정 없음 - 맨 위가 마지막에 올린 것"])
    s = {1: 4, 2: 7}.get(n, mx)
    f = [f"고정 {n}개"]
    if n >= 3:
        f.append("3개가 증거 · 사는 법 · 소개로 일이 나뉘는지는 눈으로 확인")
    return item(rub, "pinned_three", s, f)


def score_category(p, rub):
    mx = rub["category_contact"]["points"]
    at = (p.get("account_type") or "").upper()
    f, s = [], 0
    if at in ("BUSINESS", "CREATOR", "MEDIA_CREATOR"):
        s += 3; f.append("비즈니스 · 크리에이터 계정")
    elif at:
        f.append("개인 계정 - 인사이트 · 연락 버튼 없음")
    else:
        f.append("계정 종류 모름")
    if p.get("category"):
        s += 1; f.append(f"카테고리: {p['category']}")
    else:
        f.append("카테고리 모름 · 없음")
    if p.get("contact") is True:
        s += 2; f.append("연락 버튼 있음")
    elif p.get("contact") is False:
        f.append("연락 버튼 없음")
    else:
        f.append("연락 버튼 정보 없음")
    return item(rub, "category_contact", min(mx, s), f)


def score_recent(p, rub):
    mx = rub["recent_activity"]["points"]
    d = p.get("days_since_last_post")
    if d is None:
        return item(rub, "recent_activity", None, ["마지막 게시일 모름"])
    if d <= 7:
        s = 7
    elif d <= 14:
        s = 4
    elif d <= 30:
        s = 2
    else:
        s = 0
    f = [f"마지막 게시 {d}일 전"]
    u = p.get("unanswered_comments")
    if u is None:
        s += 1; f.append("답 안 한 댓글 수 모름 (부분 점수)")
    elif u == 0:
        s += 3; f.append("최근 댓글에 모두 답함")
    elif u <= 3:
        s += 1; f.append(f"답 안 한 댓글 {u}개")
    else:
        f.append(f"답 안 한 댓글 {u}개 - 문의가 쌓인 가게로 보임")
    return item(rub, "recent_activity", min(mx, s), f)


def score_story(p, rub):
    mx = rub["story_presence"]["points"]
    days = p.get("story_days_per_week")
    if days is not None:
        s = 6 if days >= 5 else 4 if days >= 3 else 2 if days >= 1 else 0
        return item(rub, "story_presence", min(mx, s), [f"최근 7일 중 {days}일 스토리"])
    act = p.get("story_active")
    if act is True:
        return item(rub, "story_presence", 4, ["지금 스토리 있음 (얼마나 자주인지는 모름)"])
    if act is False:
        return item(rub, "story_presence", 0, ["지금 스토리 없음"])
    return item(rub, "story_presence", None, ["스토리 정보 없음"])


def run(p):
    rub = load_rubric()
    items = [
        check_name(p, rub),
        check_bio_first(p, rub),
        check_bio_body(p, rub),
        score_pinned(p, rub),
        score_link(p, rub),
        score_highlights(p, rub),
        check_grid(p, rub),
        check_photo(p, rub),
        score_handle(p, rub),
        score_category(p, rub),
        score_recent(p, rub),
        score_story(p, rub),
    ]
    auto = [i for i in items if i["auto"]]
    return {
        "items": items,
        "auto_score": sum(i["score"] for i in auto),
        "auto_max": sum(i["max"] for i in auto),
        "pending": [i["id"] for i in items if not i["auto"]],
        "banned": banned_hits((p.get("name") or "") + "\n" + (p.get("bio") or "")),
    }


def render(r):
    out = []
    out.append(f"기계 채점  {r['auto_score']}/{r['auto_max']}  (판단 채점 남음: {len(r['pending'])}개 항목)")
    out.append("")
    for i in r["items"]:
        sc = f"{i['score']}/{i['max']}" if i["auto"] else f"?/{i['max']}"
        out.append(f"  {i['label']:<10} {sc:>6}   " + " · ".join(i["findings"]))
    if r["banned"]:
        out.append("")
        out.append("광고 표현 규칙 위반 가능: " + "; ".join(r["banned"]))
    return "\n".join(out)


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")    # 파이프 입력도 UTF-8로 (Windows 기본 cp949)
        sys.stdout.reconfigure(encoding="utf-8")   # -I는 PYTHONIOENCODING을 무시한다
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="인스타 프로필 기계 검사 (한국어)")
    ap.add_argument("file", help="프로필 JSON 경로, '-'면 표준입력")
    ap.add_argument("--json", action="store_true", help="JSON으로 출력")
    a = ap.parse_args()
    raw = sys.stdin.read() if a.file == "-" else open(a.file, encoding="utf-8-sig").read()
    p = json.loads(raw)
    r = run(p)
    if a.json:
        print(json.dumps(r, ensure_ascii=False))
    else:
        print(render(r))


if __name__ == "__main__":
    main()
