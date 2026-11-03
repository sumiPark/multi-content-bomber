#!/usr/bin/env python3
"""
hookscore_ko.py - 릴스 첫 줄(훅)을 강한 훅의 다섯 가지 공통점으로 채점하고,
여러 개를 서로 비교해 순위를 매긴다. 한국어 전용.

원본: github.com/Jakeschincariol/instagram-agent-skill 의 ig-reel/hookscore.py (MIT).
원본은 영어 단어 정규식([A-Za-z0-9...])으로 단어를 세서 한국어 훅은 단어 0개로
채점됐다. 이 판은 같은 다섯 축을 한국어 기준으로 다시 짰다.

다섯 축 (각 0~100, 높을수록 좋음)
  LENGTH     길이     어절 수 + 음절로 추정한 말하는 시간. 3초 안에 끝나야 한다.
  SPECIFICITY 구체성  숫자+단위, 따옴표 인용, 영문 브랜드·성분명, 품종·산지·성분 사전.
  STAKES     긴장     잃을 것, 부정, 반전. 아무도/절대/몰랐/손해/하지 마/차이 ...
  FRONTLOAD  앞쪽 배치 핵심 어절이 앞 3어절 안에 있는가. 인사·군말로 시작하면 감점.
  ADDRESS    시청자 호명 여러분/~분들/~세요/~죠?/혹시/아직도 ... 누구에게 하는 말인가.

이것이 아닌 것: 조회수 예측기. 원본 저자도 밝혔듯 "진짜 훅 vs 일부러 못 쓴 훅"은
잘 가르지만, 괜찮은 훅 둘 중 어느 쪽이 더 퍼질지는 못 가른다. 그건 얼굴, 편집,
소리, 그리고 인스타가 누구에게 보여 주느냐가 정한다. 이 한국어판은 실제 한국어
릴스 코퍼스로 검증한 적이 없다. 인사·서두·숫자 없는 훅·너무 긴 훅을 걸러 내는
용도로만 믿고, 순위는 시청 지속 그래프를 더 믿어라.

사용법
  python -I hookscore_ko.py hooks.txt              # 한 줄에 훅 하나, 순위
  python -I hookscore_ko.py --hook "아무도 안 알려주는 세안 마무리 3초"
  python -I hookscore_ko.py hooks.txt --json
  python -I hookscore_ko.py hooks.txt --sps 7      # 말속도(음절/초) 직접 지정
"""

import argparse
import json
import re
import statistics
import sys

# ---------------------------------------------------------------------------
# 상수
# ---------------------------------------------------------------------------

# 말속도(음절/초). 한국어 성인 발화속도는 연구마다 다르지만 대략 낭독 4~5,
# 자유 발화 5~6음절/초 안팎으로 보고된다(정확한 값 아님, 대략치). 릴스·숏폼은
# 편집으로 숨 쉬는 틈을 잘라 내 더 빠르게 들려서 6.5~7음절/초로 추정했다.
# 그중 낮은 쪽(6.5)을 기본값으로 둔다: 시간을 약간 길게 잡아야 "3초 안" 판정이
# 실제보다 관대해지지 않는다. 본인 말속도를 재 보고 --sps로 바꿔 쓰는 게 맞다.
SYLLABLES_PER_SEC = 6.5

WORDS_MIN, WORDS_MAX = 4, 10          # 적정 어절 수
SECS_MIN, SECS_MAX = 1.5, 3.5         # 적정 말 길이(초). 3초 안팎이 목표
MAX_CHARS = 32                        # 공백 뺀 글자 수. 넘으면 화면 문구로 두 줄을 넘긴다

HANGUL_RE = re.compile(r"[가-힣]")
NUM_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")
LATIN_RE = re.compile(r"[A-Za-z][A-Za-z0-9+\-']*")
HASHTAG_RE = re.compile(r"(?:^|\s)#\S+")
EMOJI_RE = re.compile(r"[\U0001F300-\U0001FAFF☀-➿]")
QUOTE_RE = re.compile(r"[\"“'‘「『][^\"”'’」』]{2,40}[\"”'’」』]")

# 숫자 뒤에 붙는 단위. 숫자+단위가 붙어 있으면 "확인 가능한 무엇"이다.
UNIT = (r"(?:만\s?원|천\s?원|원|만|천|%|퍼센트|프로|개월|개|일|초|분|시간|주|달|년|"
        r"kg|g|ml|mL|l|L|mg|cm|brix|Brix|BRIX|브릭스|위|등|배|번|회|가지|단계|살|세|명|"
        r"병|통|박스|장|알|포|팩|도|건|평|kcal|칼로리|인분|봉|입|과)")
DIGIT_UNIT_RE = re.compile(r"\d[\d,]*(?:\.\d+)?\s?" + UNIT + r"?")

# 한글 수사. "한"·"하나"는 일부러 뺐다: "한번 써 보세요"처럼 군말일 때가 훨씬 많다.
# 고유어 수사는 뒤에 셀 단위(개, 가지, 번 ...)가 붙을 때만 숫자로 친다("세안"의 '세',
# "네~"의 '네'가 숫자로 잡히지 않게).
NATIVE_NUM_RE = re.compile(
    r"(?<![가-힣])(?:두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰)\s?"
    r"(?:개|가지|번|명|병|살|시간|달|박스|통|알|포|장|단계|줄|컷|군데|봉|팩|송이|조각)"
    # 기간을 나타내는 고유어·관용 표현도 숫자다(이틀, 일주일, 한 달).
    r"|(?<![가-힣])(?:이틀|사흘|나흘|닷새|엿새|열흘|보름|일주일|(?:한|두|석|넉)\s?달|반년|일\s?년)(?![가-힣]{2})")
# 한자어 수사. 십·백·천·만이 들어간 묶음이거나, 뜻이 헷갈리지 않는 단위가 붙을 때만.
# ("이 분"=이 사람, "이 일"=이 일거리 같은 오탐을 막으려고 분·일·원 단일 수사는 뺐다.)
SINO_NUM_RE = re.compile(
    r"(?<![가-힣])(?:[일이삼사오육칠팔구]?십|[일이삼사오육칠팔구]?백|[일이삼사오육칠팔구]?천|"
    r"[일이삼사오육칠팔구십백천]+만)[일이삼사오육칠팔구십백천]*\s?"
    r"(?:만\s?원|원|개|명|번|초|분|일|년|퍼센트|프로|브릭스|킬로|그램|배|위)"
    r"|(?<![가-힣])[이삼사오육칠팔구]\s?(?:초|년|개월|퍼센트|프로|브릭스|킬로|그램|주)(?![가-힣])")

# 구체 명사 사전 — 품종·산지·성분처럼 "그 자체로 확인 가능한" 이름.
# 일반 범주어(토너, 크림, 귤, 사과)는 영어판의 "product"와 같아서 넣지 않았다.
# 상품군이 늘면 여기에 더 넣어라. 어절에서 조사를 떼고 끝이 이 이름과 맞으면 센다.
CONCRETE_NOUNS = {
    # 과일 품종 (오늘과일)
    "샤인머스캣", "거봉", "캠벨", "캠벨얼리", "부사", "홍로", "감홍", "시나노골드", "아리수",
    "한라봉", "천혜향", "레드향", "황금향", "카라향", "청견", "설향", "금실", "킹스베리",
    "죽향", "신비복숭아", "황도", "백도", "납작복숭아", "애플망고", "골드키위", "대석",
    "꿀참외", "흑수박", "망고스틴", "대봉", "부유", "청귤", "하우스귤", "노지귤", "타이벡",
    # 산지
    "제주", "제주산", "서귀포", "성주", "나주", "청송", "영동", "충주", "상주", "김천", "고창",
    "논산", "해남", "영천", "장수", "국내산", "국산",
    # 화장품 성분 (리유코스메틱)
    "나이아신아마이드", "히알루론산", "세라마이드", "판테놀", "병풀", "시카", "레티놀",
    "펩타이드", "스쿠알란", "어성초", "티트리", "아데노신", "알부틴", "글루타치온", "PHA",
    "AHA", "BHA", "마데카소사이드", "콜라겐", "비타민C",
    # 건강기능식품·식품 원료 (리유코스메틱·쿠마마켓)
    "유산균", "프로바이오틱스", "루테인", "오메가3", "밀크씨슬", "비오틴", "마그네슘",
    "비타민D", "아연", "홍삼", "흑마늘", "콤부차", "그릭요거트",
}

# 원본의 STAKES. 한국어는 어미·조사가 붙어서 단어 집합 대신 어간 정규식으로 찾는다.
STAKE_PATTERNS = [
    r"아무도", r"절대", r"몰랐", r"모르(?:는|면|고|시|죠|세요)", r"몰라", r"후회", r"실수",
    r"손해", r"망(?:했|한|하|치|쳤|가)", r"그만", r"지\s?마(?:세요|요|라)?(?=$|[\s.!?,])",
    r"(?<![가-힣])왜", r"진짜", r"차이", r"비밀", r"이거\s?하나", r"하나만", r"대부분",
    r"아직도", r"버리(?:세요|지|는|면)|버렸", r"낭비", r"날리|날렸|날아가", r"속았|속지|속는",
    r"함정", r"잘못", r"틀렸|틀린|틀리", r"거짓|가짜", r"사실은|알고\s?보니", r"반전",
    r"문제", r"위험", r"경고", r"주의", r"놓치", r"소용\s?없", r"(?<![가-힣])헛",
    r"안\s?하면|하면\s?안", r"없이", r"대신", r"말고", r"처음", r"마지막", r"결국",
    r"이미", r"벌써", r"오히려", r"반대", r"(?i)\bvs\b", r"비교", r"달라|다르|다른\s?점",
    r"바꿨|바꾸|바뀌", r"끊었|끊고", r"포기", r"실패", r"최악", r"(?<![가-힣])싫",
    r"비싸|비싼", r"아깝|아까워", r"공짜|무료|반값", r"만에", r"단점", r"몰래",
    # 쇼핑몰 쪽 손해 단어 (과일·식품 배송, 화장품 반품)
    r"반품|환불|클레임|불량", r"끼리만|만\s?아는|밖에서는", r"상했|상한|무른|물러|터졌|곰팡이|시들",
    # 부정: 어절로 선 "안"·"못", 그리고 "않"·"없"
    r"(?<![가-힣])안(?=\s|$)", r"(?<![가-힣])못(?=\s|$)", r"않", r"없",
]
STAKE_RES = [re.compile(p) for p in STAKE_PATTERNS]
PRICE_RE = re.compile(r"\d[\d,]*\s?(?:만\s?)?(?:천\s?)?원")

# 첫 1~2초를 아무 말도 안 하고 쓰는 시작. 첫 어절(또는 첫 두 어절)이 이걸로 시작하면 감점.
WEAK_OPENERS = [
    "안녕", "반갑", "오늘은", "오늘 소개", "자,", "자 ", "음 ", "음,", "어 ", "어,", "아 ", "아,", "그래서", "그러니까",
    "일단", "요즘", "이번에", "이번 영상", "이 영상", "영상", "저는", "저희는", "제가 오늘",
    "여러분 오늘", "다들 안녕", "솔직히", "그냥", "사실", "좋은 제품", "드디어 소개", "잠깐",
]

# 호명. 2인칭이 직접 나오면 100, 청유·명령·질문·콜아웃이면 90, 1인칭만 있으면 70.
# 아무 인칭도 없으면 55: 한국어는 주어 생략이 기본이라 영어판처럼 35까지 깎으면
# "아무도 안 알려주는 세안 마무리 3초" 같은 멀쩡한 명사형 훅이 다 떨어진다.
ADDRESS_2P = re.compile(
    r"여러분|(?<![가-힣])(?:너|니|네)(?:는|도|만|가|랑|희|한테)?(?=\s|$|[,.!?])|니가|네가|당신|"
    r"님들|언니들|형님들|(?<![가-힣])자기(?:야|들)?(?=\s|$|[,.!?])")
ADDRESS_IMPLIED = re.compile(
    r"(?:인|이신|하는|하시는|있는|없는|쓰는|드시는|키우는)\s?분(?:들)?(?=\s|$|[,.!?께은이])|분들|"
    r"(?:라면|다면)(?=[\s,]|$)|아직도|혹시|다들|"
    r"(?:세요|십시오|해\s?봐|해봐|보세요|하자|해라|마라)(?=$|[\s.!?,~])|"
    r"(?:죠|나요|까요|니|냐|어요|아요|에요|예요|가요|래요|게요)\?|"
    r"(?:나요|까요|죠|을까|ㄹ까|는지)(?=$|[\s.!~])|\?")
ADDRESS_1P = re.compile(
    r"(?<![가-힣])(?:저|제|나|내)(?:는|가|도|만|한테)?(?=\s|$)|제가|내가|저희|우리|"
    r"드릴게요|드려요|드립니다|해\s?봤|써\s?봤|먹어\s?봤|발라\s?봤")
GREETING_RE = re.compile(r"안녕하세요|안녕하십니까|반갑습니다")

DEALBREAKERS = [
    (re.compile(r"^\s*(?:스크롤\s?(?:멈|내리지|넘기지)|잠깐만?요?[!,. ]|넘기지\s?마|멈춰)"),
     "\"스크롤 멈춰/잠깐만요\"로 시작. 주목해 달라고 하는 건 아직 주목받을 거리가 없다는 뜻이다."),
    (re.compile(r"(?:이번|오늘)\s?영상(?:에서는|은|에선|에서)?|소개해\s?드릴게요|소개해\s?드리려고|"
                r"소개할게요|소개합니다|알아보겠습니다|알아볼게요|알려\s?드리려고\s?(?:해요|합니다)"),
     "영상 서두(\"오늘은 ~ 소개해 드릴게요\"). 지우고 결론부터 말하라."),
    (re.compile(r"^\s*(?:안녕하세요|안녕하십니까|안녕[!,. ]|여러분\s?안녕|반갑습니다|하이[!,. ]|헬로)"),
     "인사로 시작. 피드에 인사받으러 온 사람은 없다."),
    (HASHTAG_RE, "훅에 해시태그. 해시태그는 캡션 맨 아래에, 쓴다면."),
    (EMOJI_RE, "훅에 이모지. 훅 크기 화면 문구에는 말이 들어갈 자리밖에 없다."),
    (re.compile(r"치료|완치|(?<![가-힣])재생(?!\s?(?:버튼|목록))|염증|최고|최상|(?<![가-힣])유일|"
                r"100\s?%|백\s?퍼센트|부작용\s?(?:없|제로|0)|질병\s?예방|특효|기적"),
     "광고 심의 위험 표현(치료·완치·재생·염증·최고·유일·100%·부작용 없음·질병 예방 등). "
     "화장품·건강기능식품·식품 광고에서 쓰면 안 된다. 사실·근거 있는 표현으로 바꿔라."),
]


def clamp(n):
    return max(0.0, min(100.0, n))


# ---------------------------------------------------------------------------
# 어절·음절
# ---------------------------------------------------------------------------

def eojeol(text):
    """어절 = 공백으로 나뉜 덩어리. 문장부호만 있는 조각은 뺀다."""
    out = []
    for tok in text.split():
        if re.search(r"[가-힣A-Za-z0-9]", tok):
            out.append(tok)
    return out


_DIGIT = "영일이삼사오육칠팔구"


def _sino_group(g):
    """0~9999를 한자어로 읽을 때 음절 수. 천·백·십 앞의 '일'은 안 읽는다(백, 천)."""
    n = 0
    for unit, d in zip((1000, 100, 10, 1), (g // 1000 % 10, g // 100 % 10, g // 10 % 10, g % 10)):
        if not d:
            continue
        if unit == 1:
            n += 1
        else:
            n += 1 if d == 1 else 2
    return n


def number_syllables(token):
    """'18,000' -> 만팔천(3), '3' -> 삼(1), '1.5' -> 일점오(3)."""
    token = token.replace(",", "")
    whole, _, frac = token.partition(".")
    try:
        v = int(whole or "0")
    except ValueError:
        return len(token)
    if v == 0:
        n = 1
    else:
        n, unit_i = 0, 0
        while v:
            g = v % 10000
            if g:
                if unit_i == 0:
                    n += _sino_group(g)
                else:
                    # 만·억·조 단위. '일만'이 아니라 '만'으로 읽는다.
                    n += (0 if g == 1 else _sino_group(g)) + 1
            v //= 10000
            unit_i += 1
    if frac:
        n += 1 + len(frac)                       # '점' + 소수 자리
    return n


# 영문 단위·약어를 한국어로 읽을 때의 음절 수.
LATIN_SPOKEN = {"kg": 3, "g": 2, "mg": 4, "ml": 3, "l": 2, "cm": 3, "brix": 3,
                "kcal": 4, "x": 1, "k": 1, "vs": 3, "spf": 5, "pa": 2}


def latin_syllables(word):
    low = word.lower()
    if low in LATIN_SPOKEN:
        return LATIN_SPOKEN[low]
    if word.isupper() and len(word) <= 5:
        return round(len(word) * 1.5)             # 약어는 알파벳을 하나씩 읽는다(에스피에프)
    return max(1, round(len(word) * 0.6))         # 한국어로 읽으면 음절이 늘어난다(brand=브랜드)


def syllables(text):
    """말할 때의 음절 수 추정: 한글 음절 + 숫자 읽기 + 영문 읽기 + 기호(%, ~)."""
    t = re.sub(r"(?<=\d),(?=\d)", "", text)
    n = len(HANGUL_RE.findall(t))
    for m in NUM_RE.finditer(t):
        n += number_syllables(m.group(0))
    for m in LATIN_RE.finditer(t):
        n += latin_syllables(m.group(0))
    n += t.count("%") * 3                          # 퍼센트
    return n


def speak_seconds(text, sps=SYLLABLES_PER_SEC):
    return syllables(text) / sps


# ---------------------------------------------------------------------------
# 신호 찾기 (beats_ko.py, swipe_ko.py도 쓴다)
# ---------------------------------------------------------------------------

JOSA = ("에서는", "으로는", "이라고", "까지", "부터", "보다", "처럼", "이랑", "하고", "에서",
        "으로", "에게", "한테", "이에요", "예요", "입니다", "이다", "은", "는", "이", "가",
        "을", "를", "에", "로", "와", "과", "도", "만", "의", "랑", "요", "야")


def strip_josa(tok):
    tok = re.sub(r"[^\w가-힣]+$", "", tok)
    tok = re.sub(r"^[^\w가-힣]+", "", tok)
    for j in JOSA:
        if tok.endswith(j) and len(tok) - len(j) >= 2:
            return tok[: -len(j)]
    return tok


def _noun_hit(tok):
    stem = strip_josa(tok)
    for noun in CONCRETE_NOUNS:
        if stem == noun or (len(noun) >= 2 and stem.endswith(noun)):
            return noun
    return None


def concrete_markers(text):
    """확인 가능한 것들: 숫자(+단위), 한글 수사+단위, 따옴표 인용, 영문 고유명, 사전 명사."""
    t = re.sub(r"(?<=\d),(?=\d)", "", text)
    found = []
    found += [m.group(0).strip() for m in DIGIT_UNIT_RE.finditer(t)]
    found += [m.group(0).strip() for m in NATIVE_NUM_RE.finditer(t)]
    found += [m.group(0).strip() for m in SINO_NUM_RE.finditer(t)]
    found += [m.group(0) for m in QUOTE_RE.finditer(t)]
    for m in LATIN_RE.finditer(t):
        w = m.group(0)
        if w.lower() in LATIN_SPOKEN and w.lower() not in ("spf", "pa"):
            continue                               # 단위는 숫자 쪽에서 이미 셌다
        if len(w) >= 2:
            found.append(w)                        # 한국어 문장 속 영문 = 대개 브랜드·성분·상품명
    for tok in eojeol(t):
        hit = _noun_hit(tok)
        if hit and hit not in found:
            found.append(hit)
    # 같은 걸 두 번 세지 않는다("3초"와 "3")
    uniq = []
    for f in found:
        if not any(f != u and f in u for u in found) and f not in uniq:
            uniq.append(f)
    return uniq


def stake_markers(text):
    found = []
    for r in STAKE_RES:
        m = r.search(text)
        if m:
            found.append(m.group(0).strip())
    if PRICE_RE.search(text):
        found.append("가격")
    return sorted(set(found), key=found.index)


# "건성인 분들,"처럼 시청자를 바로 좁히는 콜아웃도 앞에 오면 핵심으로 친다(공식 #14).
CALLOUT_RE = re.compile(r"(?:인|이신|하는|하시는|있는|없는|쓰는|드시는)\s?분(?:들)?(?=\s|$|[,.!?])|"
                        r"분들|님들|(?:라면|다면)(?=[\s,]|$)")


def payload_index(text):
    """핵심 신호가 처음 나오는 어절 번호(0부터). "바르지 마세요"·"세 번"처럼 어절을
    걸치는 표지도 잡으려고 문장 전체에서 위치를 찾은 뒤 어절 번호로 바꾼다."""
    starts = []
    for r in STAKE_RES + [NUM_RE, NATIVE_NUM_RE, SINO_NUM_RE, LATIN_RE, QUOTE_RE, CALLOUT_RE,
                          re.compile(r"[\"“'‘「]")]:
        m = r.search(text)
        if m:
            starts.append(m.start())
    pos = 0
    for i, tok in enumerate(text.split()):
        pos = text.index(tok, pos)
        if _noun_hit(tok):
            starts.append(pos)
            break
        pos += len(tok)
    if not starts:
        return None
    before = text[:min(starts)]
    n = len(before.split())
    if before and not before[-1].isspace():
        n -= 1                                     # 어절 중간에서 시작한 표지는 그 어절 번호
    return max(n, 0)


# ---------------------------------------------------------------------------
# 다섯 축
# ---------------------------------------------------------------------------

def check_length(text, sps=SYLLABLES_PER_SEC):
    """손가락이 움직이기 전에 끝나야 한다. 2~3초."""
    w = eojeol(text)
    n = len(w)
    syl = syllables(text)
    secs = syl / sps
    chars = len(re.sub(r"\s", "", text))
    if WORDS_MIN <= n <= WORDS_MAX:
        ws = 100.0
    elif n < WORDS_MIN:
        ws = clamp(100 - (WORDS_MIN - n) * 20)
    else:
        ws = clamp(100 - (n - WORDS_MAX) * 12)
    if SECS_MIN <= secs <= SECS_MAX:
        ts = 100.0
    elif secs < SECS_MIN:
        ts = clamp(100 - (SECS_MIN - secs) * 40)
    else:
        ts = clamp(100 - (secs - SECS_MAX) * 30)
    score = ws * 0.4 + ts * 0.6                    # 어절 수보다 말하는 시간이 더 중요
    if chars > MAX_CHARS:
        score -= 12
    return clamp(score), (f"{n}어절, {syl}음절, 공백 뺀 {chars}자, 말하면 약 {secs:.1f}초 "
                          f"(목표 {WORDS_MIN}~{WORDS_MAX}어절, {SECS_MAX:.1f}초 이내)")


def check_specificity(text):
    """구체적인 것 하나가 추상적인 것 셋을 이긴다."""
    found = concrete_markers(text)
    hits = len(found)
    score = 15.0 if hits == 0 else clamp(45 + hits * 30)
    return score, (f"구체 신호 {hits}개" + (f": {', '.join(found[:4])}" if found else
                   " - 숫자도 이름도 없다. 확인할 수 있는 게 없다"))


def check_stakes(text):
    """긴장, 대가, 부정. 보는 사람이 잃을 수도 있는 것."""
    markers = stake_markers(text)
    n = len(markers)
    score = {0: 20.0, 1: 70.0}.get(n, 100.0)
    return score, (f"긴장 표지 {n}개" + (f": {', '.join(markers[:4])}" if markers else
                   " - 이 줄에는 걸린 게 없다"))


def check_frontload(text):
    """핵심 어절이 아홉 번째에 있으면 안 된다."""
    w = eojeol(text)
    if not w:
        return 0.0, "비어 있음"
    head = " ".join(w[:2]) + " "
    hit_opener = next((weak for weak in WEAK_OPENERS if head.startswith(weak)), None)
    penalty = 30 if hit_opener else 0
    payload = payload_index(text)
    if payload is None:
        base, where = 30.0, "핵심 어절이 어디에도 없다"
    elif payload <= 2:
        base, where = 100.0, f"핵심이 {payload + 1}번째 어절"
    elif payload <= 4:
        base, where = 70.0, f"핵심이 {payload + 1}번째 어절, 더 앞으로"
    else:
        base, where = 40.0, f"핵심이 {payload + 1}번째 어절, 너무 늦다"
    detail = where + (f"; 약한 시작 \"{hit_opener.strip()}\"" if hit_opener else "")
    return clamp(base - penalty), detail


def check_address(text):
    """한 사람에게 하는 말인가, 허공에 하는 말인가."""
    t = GREETING_RE.sub(" ", text)                 # '안녕하세요'의 '~세요'는 호명이 아니다
    m = ADDRESS_2P.search(t)
    if m:
        return 100.0, f"시청자를 직접 부른다 (\"{m.group(0)}\")"
    m = ADDRESS_IMPLIED.search(t)
    if m:
        return 90.0, f"청유·질문·콜아웃으로 시청자를 겨눈다 (\"{m.group(0).strip()}\")"
    m = ADDRESS_1P.search(t)
    if m:
        return 70.0, f"1인칭, 시청자는 안 부른다 (\"{m.group(0)}\")"
    return 55.0, "인칭 없음 (한국어는 주어 생략이 흔해 크게 깎지 않음)"


CHECKS = ["LENGTH", "SPECIFICITY", "STAKES", "FRONTLOAD", "ADDRESS"]
CHECK_KO = {"LENGTH": "길이", "SPECIFICITY": "구체성", "STAKES": "긴장",
            "FRONTLOAD": "앞쪽 배치", "ADDRESS": "호명"}


def run(text, sps=SYLLABLES_PER_SEC):
    results = {
        "LENGTH": check_length(text, sps),
        "SPECIFICITY": check_specificity(text),
        "STAKES": check_stakes(text),
        "FRONTLOAD": check_frontload(text),
        "ADDRESS": check_address(text),
    }
    flags = [msg for pattern, msg in DEALBREAKERS if pattern.search(text)]
    scores = [results[c][0] for c in CHECKS]
    # 가장 약한 축이 훅 전체를 깎는다(원본과 같은 가중치): 하나만 나빠도 손가락은 넘긴다.
    overall = statistics.mean(scores) * 0.6 + min(scores) * 0.4 - len(flags) * 15
    overall = clamp(overall)
    verdict = "STRONG" if overall >= 70 and min(scores) >= 55 and not flags else (
        "OK" if overall >= 50 else "WEAK")
    return results, overall, verdict, flags


VERDICT_KO = {"STRONG": "강함", "OK": "보통", "WEAK": "약함"}


def bar(score, width=24):
    filled = round(score / 100 * width)
    return "#" * filled + "." * (width - filled)


def pad(s, width):
    """한글은 터미널에서 두 칸을 차지해서 f"{s:<8}"로는 줄이 안 맞는다."""
    import unicodedata
    w = sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)
    return s + " " * max(0, width - w)


def render_one(text, results, overall, verdict, flags, out=sys.stdout):
    print("\n훅 점수 (HOOK SCORE)", file=out)
    print("=" * 62, file=out)
    print(f"  \"{text.strip()}\"\n", file=out)
    for name in CHECKS:
        score, detail = results[name]
        print(f"  {pad(CHECK_KO[name], 10)} {bar(score)} {score:5.1f}", file=out)
        print(f"  {'':<10} {detail}", file=out)
    print("-" * 62, file=out)
    print(f"  {pad('총점', 10)} {bar(overall)} {overall:5.1f}   {verdict} ({VERDICT_KO[verdict]})", file=out)
    for f in flags:
        print(f"\n  치명적 감점  {f}", file=out)
    if verdict != "STRONG":
        weakest = min(CHECKS, key=lambda c: results[c][0])
        print(f"\n  가장 약한 축: {CHECK_KO[weakest]}. 그것부터 고치고 다시 돌려라.", file=out)
    print("", file=out)


def render_table(rows, out=sys.stdout):
    print("\n훅 순위\n" + "=" * 78, file=out)
    for i, r in enumerate(rows, 1):
        mark = "->" if i == 1 else "  "
        hook = r["hook"] if len(r["hook"]) <= 40 else r["hook"][:38] + "..."
        print(f"{mark} {r['score']:5.1f} {r['verdict']:<7} {hook}", file=out)
        w = r["weakest"]
        print(f"        가장 약한 축: {CHECK_KO[w]} ({r['checks'][w]['score']:.0f})", file=out)
        for f in r["flags"]:
            print(f"        치명적 감점: {f}", file=out)
    print("\n1등을 찍어라. 1등이 50점 아래면 이 중에 훅은 없다.\n", file=out)


def main():
    try:
        sys.stdin.reconfigure(encoding="utf-8")    # 파이프 입력도 UTF-8로 (Windows 기본 cp949)
        sys.stdout.reconfigure(encoding="utf-8")   # Windows 콘솔(cp949)에서 한글이 깨지지 않게
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(description="릴스 훅을 다섯 축으로 채점한다(한국어).")
    ap.add_argument("input", nargs="?", default="-", help="한 줄에 훅 하나인 파일, 또는 - (표준입력)")
    ap.add_argument("--hook", help="훅 한 줄을 바로 채점")
    ap.add_argument("--sps", type=float, default=SYLLABLES_PER_SEC,
                    help=f"말속도, 음절/초 (기본 {SYLLABLES_PER_SEC})")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if args.hook:
        lines = [args.hook]
    else:
        raw = sys.stdin.read() if args.input == "-" else open(args.input, encoding="utf-8-sig").read()
        lines = [l.strip() for l in raw.splitlines() if l.strip() and not l.lstrip().startswith("#")]
    if not lines:
        print("채점할 훅이 없다", file=sys.stderr)
        sys.exit(2)

    payload = []
    for line in lines:
        results, overall, verdict, flags = run(line, args.sps)
        payload.append({
            "hook": line,
            "checks": {k: {"score": round(v[0], 1), "detail": v[1]} for k, v in results.items()},
            "weakest": min(CHECKS, key=lambda c: results[c][0]),
            "flags": flags,
            "score": round(overall, 1),
            "verdict": verdict,
        })

    if args.json:
        print(json.dumps(payload if len(payload) > 1 else payload[0], indent=2, ensure_ascii=False))
        return

    if len(payload) == 1:
        results, overall, verdict, flags = run(lines[0], args.sps)
        render_one(lines[0], results, overall, verdict, flags)
    else:
        render_table(sorted(payload, key=lambda r: -r["score"]))

    sys.exit(0 if max(p["score"] for p in payload) >= 70 else 1)


if __name__ == "__main__":
    main()
