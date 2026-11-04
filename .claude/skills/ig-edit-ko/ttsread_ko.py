#!/usr/bin/env python3
"""TTS 읽기용 원고에 남은 숫자와 기호를 말하는 대로 바꾼다. 한 줄이 한 문장이다.

사용: ttsread_ko.py [--json] <파일>
남은 영문과 숫자는 flags로 알려 준다.
"""
import json
import re
import sys

NATIVE_UNITS = ("시간", "개월", "개", "번", "살", "잔", "명", "가지", "장", "병", "시", "마리", "권", "벌", "켤레", "봉지", "포")
NATIVE_ONES = {1: "한", 2: "두", 3: "세", 4: "네", 5: "다섯", 6: "여섯", 7: "일곱", 8: "여덟", 9: "아홉"}
NATIVE_TENS = {1: "열", 2: "스물", 3: "서른", 4: "마흔", 5: "쉰", 6: "예순", 7: "일흔", 8: "여든", 9: "아흔"}
DIGITS = "영일이삼사오육칠팔구"
SYMBOLS = {"%": "퍼센트", "℃": "도", "㎝": "센티미터", "cm": "센티미터", "kg": "킬로그램", "ml": "밀리리터", "g": "그램", "W": "와트", "x": " 곱하기 ", "×": " 곱하기 "}


def sino(n: int) -> str:
    if n == 0:
        return "영"
    out = ""
    for unit_value, unit in ((100000000, "억"), (10000, "만")):
        if n >= unit_value:
            head = n // unit_value
            out += ("" if head == 1 and unit == "만" else sino(head)) + unit
            n %= unit_value
    for unit_value, unit in ((1000, "천"), (100, "백"), (10, "십")):
        if n >= unit_value:
            head = n // unit_value
            out += ("" if head == 1 else DIGITS[head]) + unit
            n %= unit_value
    if n:
        out += DIGITS[n]
    return out


def native(n: int) -> str | None:
    if n < 1 or n >= 100:
        return None
    if n == 20:
        return "스무"
    return NATIVE_TENS.get(n // 10, "") + NATIVE_ONES.get(n % 10, "")


def read_number(match: re.Match) -> str:
    raw, unit = match.group(1), match.group(2) or ""
    if "." in raw:
        head, tail = raw.split(".", 1)
        return sino(int(head.replace(",", ""))) + "점" + "".join(DIGITS[int(c)] for c in tail) + " " + unit
    n = int(raw.replace(",", ""))
    # 개월은 한자어(3개월 = 삼 개월)다
    if unit and unit != "개월" and unit.startswith(NATIVE_UNITS):
        spoken = native(n)
        if spoken:
            return f"{spoken} {unit}"
    return f"{sino(n)} {unit}".strip() if unit else sino(n)


def convert(line: str) -> tuple[str, list[str]]:
    flags = []
    text = line
    for sym, word in SYMBOLS.items():
        text = re.sub(rf"(?<=\d)\s*{re.escape(sym)}(?![A-Za-z])", word, text)
    text = re.sub(r"(\d[\d,]*(?:\.\d+)?)\s*([가-힣]{0,3})", read_number, text)
    latin = re.findall(r"[A-Za-z]{2,}", text)
    if latin:
        flags.append("영문이 남았어요: " + ", ".join(latin))
    if re.search(r"\d", text):
        flags.append("숫자가 남았어요")
    return re.sub(r"\s+", " ", text).strip(), flags


def main() -> None:
    # -I로 실행하면 PYTHONIOENCODING을 읽지 않아 직접 맞춘다(Windows 콘솔은 cp949)
    sys.stdout.reconfigure(encoding="utf-8")
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    with open(args[0], encoding="utf-8") as f:
        lines = [ln.rstrip("\n") for ln in f if ln.strip()]
    result = [{"source": ln, "text": t, "flags": fl} for ln in lines for t, fl in [convert(ln)]]
    if as_json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        for r in result:
            print(r["text"])


if __name__ == "__main__":
    main()
