# 라이선스 고지 — ig-reel-ko · ig-human-ko · ig-caption-ko · ig-viral-ko

이 폴더의 `ig-reel-ko/`, `ig-human-ko/`, `ig-caption-ko/`, `ig-viral-ko/`는
**instagram-agent-skill**(github.com/Jakeschincariol/instagram-agent-skill)의
`ig-reel`, `ig-human`, `ig-caption`, `ig-viral` 스킬을 **한국어로 각색**한 것이다.
원본은 MIT 라이선스로 배포된다.

## 무엇을 바꿨나 (한국어 각색)

- SKILL.md, 주석, 출력 메시지를 한국어로 다시 썼다(직역이 아니라 한국 릴스·쇼핑몰 맥락으로).
- `hooks.json` → `hooks_ko.json`: 26개 훅 공식을 한국어 릴스 훅으로 각색하고, 예시를
  과일·식품·화장품·의류 상품군으로 바꾸고, 분류 정규식을 한국어로 새로 썼다.
- `hookscore.py` → `hookscore_ko.py`, `beats.py` → `beats_ko.py`: 영어 단어 대신
  어절·음절, wpm 대신 음절/초, 한국어 숫자·단위·긴장·호명 신호, 광고 심의 표현 감점.
- `slop.json` → `slop_ko.json`, `detect.py`·`humanize.py` → `detect_ko.py`·`humanize_ko.py`:
  한국어 AI 말투 사전(번역투, 상투어, 어미 반복 등), 자동 치환은 안전한 것으로 축소.
- `caption.py` → `caption_ko.py`: 한글 글자 폭 기반 "더 보기" 컷 추정, 한국어 요청·해시태그·
  검색어·광고 심의 검사.
- `swipe.py` → `swipe_ko.py`: 한국어 공식·채점 사용, 한국어 열 이름·"1.2만" 같은 숫자 입력.

원본 파일(`~/.claude/skills/ig-*`)은 수정하지 않았다.

## 원본 MIT 라이선스

> 아래 저작권 줄은 원본 저장소의 LICENSE 파일 문구로 맞춰야 한다. 로컬 설치본에는 LICENSE
> 파일이 들어 있지 않아 저장소 소유자 이름으로 적어 두었다.

```
MIT License

Copyright (c) 2026 Jake Schincariol

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

한국어 각색분도 같은 MIT 조건을 따른다.
