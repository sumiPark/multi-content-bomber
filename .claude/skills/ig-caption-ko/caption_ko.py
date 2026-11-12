#!/usr/bin/env python3
"""
caption_ko.py - 한국어 인스타 캡션을 검사하고, "... 더 보기" 전에 피드에 실제로
보이는 만큼을 상자로 보여 준다.

원본: github.com/Jakeschincariol/instagram-agent-skill 의 ig-caption/caption.py (MIT).
원본은 영어 125자를 컷으로 썼다. 한글은 글자 하나가 영문보다 두 배 가까이 넓어서
같은 컷을 쓰면 실제보다 훨씬 많이 보인다고 착각한다. 그래서 이 판은 글자 폭으로
줄을 채워 보는 방식으로 보이는 범위를 추정한다.

=== 보이는 범위 추정 (추정치다. 기기·글꼴 크기·앱 버전마다 다르다) ===
  - 피드: 아이디(굵게) 뒤에 캡션이 이어져 2줄까지 보이고, 둘째 줄 끝에 "... 더 보기".
  - 릴스 전체화면: 아이디 아래 캡션이 1줄 남짓 보이고 "... 더 보기".
  - 한 줄 폭: 390pt급 폰(아이폰 13~16 기본형) 기준, 좌우 여백 빼고 약 358pt,
    캡션 글꼴 약 14pt. 한글 한 자 ≈ 1em ≈ 14pt -> 한 줄에 한글만 약 25자,
    공백이 섞인 보통 한국어 문장이면 약 28자. 그래서 LINE_WIDTH = 28 (한글 폭 단위).
  - 글자 폭(한글 = 1.0 기준): 공백 0.3, 영문 소문자·숫자·문장부호 0.55, 영문 대문자 0.7,
    이모지 1.2. (산세리프 라틴 글자 평균 폭이 약 0.5em인 것에서 잡은 근사값)
  - 결과: 줄바꿈 없는 한국어 캡션이면 피드에서 공백 포함 약 50자 안팎, 릴스 화면에서
    약 25자 안팎이 보인다. 원본의 영어 125자를 폭으로 환산해도(125 × 0.55 ÷ 0.86 ≈ 80)
    두 줄 + 아이디 + "더 보기" 자리를 빼면 50자대로 내려온다.
  - 그래서 "첫 문장은 40자 안에서 끝내라"를 안전선(SAFE_FIRST)으로 둔다. 좁은 폰,
    긴 아이디, 큰 글꼴에서도 잘리지 않는 길이.
  --line-width, --lines, --handle로 바꿔 시험할 수 있다.

해시태그: 2025년 12월 18일부터 인스타 해시태그 상한이 게시물당 5개(원본 주석 근거:
@Creators 공지 "using fewer (up to 5) more targeted hashtags"). 이 팩의 규칙은 3개.
4~5개는 경고, 6개 이상은 실패.

사용법
  python -I caption_ko.py caption.txt
  python -I caption_ko.py caption.txt --keywords "샤인머스캣 고르는 법,제주 귤"
  python -I caption_ko.py caption.txt --handle joongdi
  python -I caption_ko.py caption.txt --json
"""

import argparse
import json
import re
import sys
import unicodedata

LIMIT = 2200             # 인스타 캡션 최대 글자 수
LINE_WIDTH = 28.0        # 한 줄 폭(한글 폭 단위). 추정 — 위 설명 참고
FEED_LINES = 2           # 피드에서 "더 보기" 전 줄 수
REELS_LINES = 1          # 릴스 전체화면에서 "더 보기" 전 줄 수
MORE_WIDTH = 5.0         # "... 더 보기"가 차지하는 폭
SAFE_FIRST = 40          # 첫 문장 안전선(공백 포함 글자 수)
HASHTAG_LIMIT = 5        # 인스타 상한 (2025-12-18~)
HASHTAG_RULE = 3         # 이 팩의 규칙

HASHTAG_RE = re.compile(r"(?:^|\s)(#[^\s#]+)")
MENTION_RE = re.compile(r"(?:^|\s)(@[A-Za-z0-9_.]+)")
LINK_RE = re.compile(r"https?://\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|co\.kr|kr|co|io|net|org|ai|app|me|ly|shop)"
                     r"(?:/\S*)?|smartstore\.naver\.com\S*|naver\.me/\S+", re.IGNORECASE)
EMOJI_RE = re.compile(r"[\U0001F300-\U0001FAFF☀-➿←-⇿]")
CONCRETE_RE = re.compile(
    r"\d[\d,.]*\s?(?:%|원|만\s?원|개|일|초|분|시간|주|개월|년|kg|g|ml|mg|브릭스|brix|명|번|가지|단계|배|위)?"
    r"|[\"“'‘「][^\"”'’」\n]{2,30}[\"”'’」]"
    r"|(?<![가-힣])(?:이틀|사흘|열흘|보름|일주일|(?:한|두|석|넉)\s?달)"
    r"|(?<![A-Za-z])[A-Za-z][A-Za-z0-9]{1,}")
GREETING_RE = re.compile(r"^\s*(?:안녕하세요|안녕하십니까|여러분\s?안녕|반갑습니다|하이[!~,. ]|헬로)")

# 댓글 키워드 자리에는 낱말뿐 아니라 이모지도 온다("댓글에 ❤️ 남겨주세요").
# 이모지는 변형 선택자(U+FE0F) · 결합 문자(U+200D)가 붙을 수 있고, 뒤에 조사가 올 수 있다.
ASK_EMOJI = r"(?:[\U0001F300-\U0001FAFF☀-➿][️‍]?){1,5}(?:을|를|만|로)?"
ASKS = [
    (re.compile(r"댓글(?:에|로|란에)?\s?[\"“'‘]?(?:[가-힣A-Za-z0-9]{1,10}|" + ASK_EMOJI + r")[\"”'’]?"
                r"\s?(?:이라고|라고)?\s?(?:남겨|달아|적어|써)"),
     "댓글 키워드"),
    (re.compile(r"(?:DM|디엠|dm|메시지)\s?(?:주세요|보내|주시면|으로|로|주시)"), "DM"),
    (re.compile(r"저장(?:해|하|각|\s?필수)"), "저장"),
    (re.compile(r"공유(?:해|하세요)|(?:친구|사람)(?:한테|에게)?\s?(?:보내|공유|태그)"), "공유·태그"),
    (re.compile(r"팔로우(?:도|를|\s?꼭)?\s?(?:하|해|부탁|필수)"), "팔로우"),
    (re.compile(r"프로필\s?(?:링크|상단|에\s?링크|에서)|링크는\s?프로필|바이오\s?링크|구매는|주문은"),
     "프로필 링크"),
    (re.compile(r"어떠세요\?|어느\s?(?:쪽|게|거)[^?\n]{0,10}\?|뭐(?:가|를)\s?[^?\n]{0,15}\?|알려\s?주세요"),
     "질문 답하기"),
    # 구매/참여 외에도 제품 안내를 확인하라는 정보성 요청은 유효하다.
    # '확인할 수 있어요' 같은 설명문은 행동 요청으로 세지 않는다.
    (re.compile(r"확인\s?(?:해\s?(?:주세|보세|두세)|하세요|하세|해요|하셔|하길)"), "정보 확인"),
]

FILLER_TAGS = {
    "#일상", "#데일리", "#소통", "#소통해요", "#맞팔", "#맞팔해요", "#선팔", "#선팔하면맞팔", "#좋아요",
    "#좋반", "#좋아요반사", "#팔로우", "#팔로우미", "#인친", "#인친해요", "#일상스타그램", "#인스타그램",
    "#릴스", "#추천", "#인기", "#팔로우환영", "#viral", "#fyp", "#explore", "#explorepage", "#foryou",
    "#trending", "#instagood", "#reels", "#reelsinstagram", "#daily", "#follow", "#like4like",
}

# 광고 심의. FAIL = 의약품으로 오인될 표현(화장품법·식품표시광고법·건강기능식품 표시광고 기준에서
# 금지). WARN = 최상급·절대 표현(근거·출처가 있어야만 쓸 수 있음).
COMPLIANCE_FAIL = re.compile(r"치료|완치|(?<![가-힣])재생(?!\s?(?:버튼|목록|시간))|염증|질병\s?(?:예방|개선)|"
                             r"부작용\s?(?:없|제로|0)|특효|약효|아토피\s?(?:개선|치료)|여드름\s?(?:치료|개선)")
COMPLIANCE_WARN = re.compile(r"최고|최상|(?<![가-힣])유일|100\s?%|백\s?퍼센트|(?<![\d])1위|최초|기적|완벽")


def char_width(c):
    if c == " ":
        return 0.3
    if unicodedata.east_asian_width(c) in "WF":
        return 1.2 if EMOJI_RE.match(c) else 1.0
    if EMOJI_RE.match(c):
        return 1.2
    if unicodedata.category(c) in ("Mn", "Cf"):
        return 0.0
    if c.isupper():
        return 0.7
    return 0.55


def visible_window(text, lines, handle, line_width=LINE_WIDTH):
    """화면 줄 단위로 캡션을 채워 보이는 만큼을 돌려준다: (보이는 글, 화면 줄 목록, 잘림 여부).
    피드는 굵은 아이디 뒤에 캡션이 이어 붙는다. handle이 빈 문자열이면(릴스 화면: 아이디가
    캡션 위 따로 한 줄) 첫 줄을 통째로 쓴다. 인스타는 어절 중간에서도 자르므로 여기도 글자 단위."""
    handle_w = (sum(char_width(c) for c in handle) * 1.1 + 0.3) if handle else 0.0  # 굵은 글씨라 조금 넓게

    def fill(limit_last):
        rows, cur, width = [], "", handle_w
        for c in text:
            if c == "\n":
                rows.append(cur)
                cur, width = "", 0.0
                if len(rows) >= lines:
                    return rows, True
                continue
            cap = line_width - (MORE_WIDTH if (limit_last and len(rows) == lines - 1) else 0)
            w = char_width(c)
            if width + w > cap:
                rows.append(cur)
                cur, width = "", 0.0
                if len(rows) >= lines:
                    return rows, True
            cur += c
            width += w
        rows.append(cur)
        return rows, False

    rows, cut = fill(False)
    if cut:
        rows, cut = fill(True)        # 잘리면 마지막 줄에 "더 보기" 자리를 비운다
    return "\n".join(rows).strip("\n"), rows, cut


def render_box(rows, truncated, title, handle="", out=sys.stdout, width=32):
    def sw(s):
        return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)

    print(f"\n  {title}", file=out)
    print("  +" + "-" * (width * 2 + 2) + "+", file=out)
    for i, row in enumerate(rows[:8] or [""]):
        shown = (f"{handle} " + row) if (handle and i == 0) else row
        if truncated and i == len(rows) - 1:
            shown += "... 더 보기"
        print(f"  | {shown}{' ' * max(0, width * 2 - sw(shown))} |", file=out)
    print("  +" + "-" * (width * 2 + 2) + "+", file=out)
    if not truncated:
        print("    (캡션 전체가 보임)", file=out)


def analyse(text, keywords=None, handle="account", line_width=LINE_WIDTH):
    stripped = text.strip()
    chars = len(stripped)
    lines = stripped.split("\n")
    first_line = lines[0].strip() if lines else ""
    first_sentence = re.split(r"(?<=[.!?])\s|\n", stripped, maxsplit=1)[0].strip()
    tags = HASHTAG_RE.findall(stripped)
    mentions = MENTION_RE.findall(stripped)
    links = LINK_RE.findall(stripped)
    emoji = EMOJI_RE.findall(stripped)
    feed, feed_rows, feed_cut = visible_window(stripped, FEED_LINES, handle, line_width)
    reels, reels_rows, reels_cut = visible_window(stripped, REELS_LINES, "", line_width)
    asks = [name for pattern, name in ASKS if pattern.search(stripped)]
    filler = [t for t in tags if t.lower() in FILLER_TAGS]
    keywords = [k.strip() for k in (keywords or []) if k.strip()]

    checks = []

    def add(name, status, detail):
        checks.append({"check": name, "status": status, "detail": detail})

    add("길이", "FAIL" if chars > LIMIT else "PASS",
        f"{chars} / {LIMIT}자" + (f", {chars - LIMIT}자 초과" if chars > LIMIT else ""))

    if not first_line:
        add("첫 줄", "FAIL", "빈 줄로 시작한다")
    elif first_line.startswith("#") or first_line.startswith("@"):
        add("첫 줄", "FAIL", "해시태그·멘션으로 시작한다. 문장 하나가 들어갈 유일한 자리다")
    elif GREETING_RE.search(first_line):
        add("첫 줄", "FAIL", "인사로 시작한다. 보이는 50자를 인사에 쓰지 마라")
    elif EMOJI_RE.match(first_line):
        add("첫 줄", "WARN", "이모지로 시작한다. 첫 글자는 말이어야 한다")
    elif feed_cut and first_sentence not in feed.replace("\n", ""):
        add("첫 줄", "WARN",
            f"첫 문장 {len(first_sentence)}자, 피드에서 {len(feed)}자쯤에서 잘린다. "
            "잘리는 자리가 궁금증이면 괜찮고, 문장 중간 조사·어미면 나쁘다")
    elif len(first_sentence) > SAFE_FIRST:
        add("첫 줄", "WARN", f"첫 문장 {len(first_sentence)}자. 안전선 {SAFE_FIRST}자를 넘어 "
                            "좁은 폰·긴 아이디에서는 잘린다")
    else:
        add("첫 줄", "PASS", f"첫 문장 {len(first_sentence)}자, 통째로 보인다 (안전선 {SAFE_FIRST}자)")

    hits = CONCRETE_RE.findall(feed)
    add("보이는 곳 구체성", "PASS" if hits else "WARN",
        f"보이는 범위에 숫자·이름·인용 {len(hits)}개"
        + (f" ({', '.join(h.strip() for h in hits[:3])})" if hits else " - 더 보기 전에 확인할 거리가 없다"))

    if len(tags) > HASHTAG_LIMIT:
        add("해시태그", "FAIL", f"{len(tags)}개, 인스타 상한 {HASHTAG_LIMIT}개 초과. "
                               f"넘는 건 안 먹히고 옛날 캡션처럼 보인다. {HASHTAG_RULE}개로")
    elif len(tags) > HASHTAG_RULE:
        add("해시태그", "WARN", f"{len(tags)}개. 이 팩 규칙은 {HASHTAG_RULE}개, 주제 라벨로만"
                               + (f". 그중 의미 없는 태그 {len(filler)}개 ({', '.join(filler[:3])})"
                                  if filler else ""))
    elif filler:
        add("해시태그", "WARN", f"{len(tags)}개 중 {len(filler)}개가 의미 없는 태그 "
                               f"({', '.join(filler[:3])}). 아무것도 설명하지 않는다")
    else:
        add("해시태그", "PASS", f"{len(tags)}개" + (f": {' '.join(tags)}" if tags else ""))

    if not tags:
        add("태그 위치", "PASS", "둘 태그 없음")
    elif any(t in feed for t in tags):
        add("태그 위치", "WARN", "보이는 범위에 해시태그가 있다. 라벨에 피드 자리를 쓰는 중")
    else:
        add("태그 위치", "PASS", "태그가 더 보기 아래에 있다")

    add("링크", "WARN" if links else "PASS",
        f"캡션에 링크 {len(links)}개. 캡션 링크는 안 눌린다. 프로필이나 DM으로"
        if links else "죽은 링크 없음")

    if len(asks) == 1:
        add("요청 하나", "PASS", f"행동 요청 하나: {asks[0]}")
    elif not asks:
        add("요청 하나", "WARN", "행동 요청이 없다. 이 게시물이 무엇을 위한 건지 정하라")
    else:
        add("요청 하나", "WARN", f"요청 {len(asks)}개 ({', '.join(asks)}). 두 개는 없는 것과 같다")

    density = len(emoji) * 100 / max(chars, 1)
    add("이모지", "WARN" if density > 4 else "PASS",
        f"{len(emoji)}개, 100자당 {density:.1f}" + (" - 장식으로 읽힌다" if density > 4 else ""))

    fail_hits = sorted(set(COMPLIANCE_FAIL.findall(stripped)))
    warn_hits = sorted(set(COMPLIANCE_WARN.findall(stripped)))
    if fail_hits:
        add("광고 심의", "FAIL", f"의약품 오인 표현: {', '.join(fail_hits)}. 화장품·건기식·식품 광고에서 금지")
    elif warn_hits:
        add("광고 심의", "WARN", f"최상급·절대 표현: {', '.join(warn_hits)}. 근거·출처 없으면 빼라")
    else:
        add("광고 심의", "PASS", "금지·위험 표현 없음")

    if keywords:
        def norm(s):
            return re.sub(r"\s+", "", s.lower())      # 한국어 검색어는 띄어쓰기가 제각각이다
        body, win = norm(stripped), norm(feed)
        found = [k for k in keywords if norm(k) in body]
        missing = [k for k in keywords if norm(k) not in body]
        in_window = [k for k in found if norm(k) in win]
        tag_only = [k for k in found if norm(k) not in norm(re.sub(r"#\S+", "", stripped))]
        status = "PASS" if not missing and not tag_only else ("WARN" if found else "FAIL")
        add("검색어", status,
            f"{len(found)}/{len(keywords)}개 있음"
            + (f", 보이는 범위에 {len(in_window)}개" if found else "")
            + (f". 없음: {', '.join(missing)}" if missing else "")
            + (f". 해시태그에만 있음: {', '.join(tag_only)} - 문장 속 말로 넣어라" if tag_only else ""))

    fails = sum(1 for c in checks if c["status"] == "FAIL")
    warns = sum(1 for c in checks if c["status"] == "WARN")
    verdict = "FIX" if fails else ("REVIEW" if warns else "READY")

    return {
        "characters": chars, "limit": LIMIT,
        "visible_feed": feed, "feed_rows": feed_rows, "feed_truncated": feed_cut,
        "visible_feed_chars": len(feed.replace("\n", "")),
        "visible_reels": reels, "reels_rows": reels_rows, "reels_truncated": reels_cut,
        "visible_reels_chars": len(reels.replace("\n", "")), "handle": handle,
        "first_sentence_chars": len(first_sentence),
        "hashtags": tags, "mentions": mentions, "links": links,
        "emoji": len(emoji), "asks": asks,
        "checks": checks, "verdict": verdict,
    }


VERDICT_KO = {"READY": "올려도 됨", "REVIEW": "검토", "FIX": "고쳐야 함"}
STATUS_KO = {"PASS": "통과", "WARN": "경고", "FAIL": "실패"}


def render(a, out=sys.stdout):
    head = (f"캡션 검사  ·  {a['characters']} / {a['limit']}자  ·  "
            f"해시태그 {len(a['hashtags'])}개  ·  요청 {len(a['asks'])}개")
    print("\n" + head, file=out)
    print("=" * 66, file=out)
    render_box(a["feed_rows"], a["feed_truncated"],
               f"피드에 보이는 만큼 (아이디 뒤 2줄, 캡션 약 {a['visible_feed_chars']}자, 추정)",
               handle=a["handle"], out=out)
    render_box(a["reels_rows"], a["reels_truncated"],
               f"릴스 화면에 보이는 만큼 (1줄, 약 {a['visible_reels_chars']}자, 추정)", out=out)
    print("", file=out)
    for c in a["checks"]:
        name = c["check"]
        sw = sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in name)
        print(f"  {STATUS_KO[c['status']]}  {name}{' ' * max(1, 18 - sw)}{c['detail']}", file=out)
    print("-" * 66, file=out)
    print(f"  판정  {a['verdict']} ({VERDICT_KO[a['verdict']]})\n", file=out)


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")    # 파이프 입력도 UTF-8로 (Windows 기본 cp949)
        sys.stdout.reconfigure(encoding="utf-8")   # Windows 콘솔에서 한글 깨짐 방지
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="한국어 인스타 캡션 검사.")
    ap.add_argument("input", nargs="?", default="-", help="캡션 파일, 또는 - (표준입력)")
    ap.add_argument("--keywords", default="", help="찾히고 싶은 검색어, 쉼표로 구분")
    ap.add_argument("--handle", default="account", help="계정 아이디(@ 없이). 첫 줄 폭 계산용")
    ap.add_argument("--line-width", type=float, default=LINE_WIDTH,
                    help=f"한 줄 폭, 한글 글자 단위 (기본 {LINE_WIDTH:g}, 추정)")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    raw = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8-sig").read()
    a = analyse(raw, keywords=args.keywords.split(","), handle=args.handle.lstrip("@"),
                line_width=args.line_width)
    if args.json:
        print(json.dumps(a, indent=2, ensure_ascii=False))
    else:
        render(a)
    sys.exit(0 if a["verdict"] == "READY" else 1)


if __name__ == "__main__":
    main()
