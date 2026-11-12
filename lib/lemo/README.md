# lemo 제작 경로 (코드 기반 애니메이션)

**AI 자동 영상의 기본 영상 단계다(2026-11-11).** `lib/auto-video/make.ts`가 장면표를 저장한 뒤 `lib/auto-video/lemo.ts` → `run.ts`로 먼저 만들고, 제작 방식 선택(select.ts)은 기존 방식을 고르지 않고 구현된 lemo 스타일 중에서만 고른다(사용자 결정 2026-11-11 — 설명형 대본도 lemo). lemo가 실패할 때만 사진 · 스톡 컷으로 만든다(실패는 경고로 남아 자동 발행을 멈춘다). 러너 변수 `AUTO_VIDEO_ENGINE=kit`이면 lemo를 부르지 않는다. 수동 실행(`worker/lemo-video.ts`, `lemo-video.yml`)도 같은 `run.ts`를 쓴다.

## 역할 나누기

| 맡는 곳 | 하는 일 |
|---|---|
| lemo-opuscar 라이브러리(외부, MIT) | `core/render/video.mjs` · `still.mjs` — 헤드리스 Chromium으로 `render(t)` 페이지를 프레임마다 찍어 **무음 mp4** |
| `lib/lemo/engine/` (브라우저 JS) | 공통 엔진: `production.json`을 읽어 장면 · 카메라 · 동작 · 전환을 계산하고, 스타일 모듈과 캐릭터 모듈로 그린다 |
| `lib/lemo/engine/styles/<slug>/` | 스타일별: 선 · 질감 · 재질 · 조명 · 그리기 엔진, 그 스타일의 전환 · 움직임 |
| `lib/lemo/library/accounts/<account_key>/` | 계정 · 시리즈별: 캐릭터(명세 + 리그), 브랜드 색 · 글꼴 · 분위기, 재사용하기로 한 배경 · 소품 |
| `production.json` (영상마다) | 등장인물과 역할, 장면 · 행동 · 감정 변화, 배경 구성, 카메라, 속도와 타이밍 — `contract.ts`의 `productionSchema` |
| 기존 편집 키트(`lib/shoot/video-kit`) | 음성(Fish, 계정 목소리) · 받아쓰기 · 모션 자막 스킬 · 음악 · 효과음 · 최종 mp4 · 표지 · 완성본 검수 |

lemo 페이지는 **나레이션 자막을 그리지 않는다.** 자막은 기존 모션 자막 스킬만 얹는다. 스킬을 못 쓰면 실패로 보고하고 기본 자막으로 조용히 넘어가지 않는다.

**장면표 연결(`board-brief.ts`).** 장면표에서 말만이 아니라 장면별 화면 지시 · 화면 글자 · 자막 줄 · 강조어 · 글자 디자인(look) · 글꼴 · 끝 화면을 추려 `LemoJob.brief`로 넘긴다. 연출(direct.ts)은 그 화면을 캐릭터 · 소품 · 배치로 옮기고, 화면 글자는 장면표가 그 장면에 정한 글자만 `word` 소품으로 쓴다(그 밖의 글자는 코드가 뺀다). 합성(compose.ts)은 장면표의 자막 줄 · 강조어 · look · 글꼴을 쓰고, 장면표 없이 만드는 실행만 16자 줄바꿈 · 기본 look으로 만든다. 음악은 lemo 스타일 기준 검색어를 그대로 쓴다.

**자막 자리.** 수치는 실제 자막이 놓이는 편집 키트의 `ZONE_BOX`(`lib/shoot/video-kit/caption-style.ts`) 한 곳에서 온다. 연출은 장면마다 `caption_place`(top · lower)를 정하고 그 띠에 얼굴 · 몸 · 물건 소품 · 화면 글자를 두지 않으며(배경 층 소품인 해 · 구름은 예외), 합성은 후킹 글자와 자막을 모두 그 자리에 놓는다(`presetZones`).

## 흐름

```
제작 요청 → 대본 · 소재 분석 → 제작 방식 선택(select.ts, 기록) → 캐릭터 · 자산 준비(characters.ts: 계정 라이브러리 재사용 또는 새로 만들고 시트 렌더 · 검수. 상품 자료가 있으면 상품 배역을 하나 꼭 둔다. 시트가 세 번 모두 불합격이면 lemo 제작을 멈춘다)
→ 음성 확정(voice.ts: 새 대본은 기존 TTS, 같은 대본 비교는 기존 음성) → 장면 계획(direct.ts → production.json, 계약 검사)
→ 코드 구성(project.ts: 엔진 + 스타일 + 그 계정 캐릭터만 복사) → 렌더(render.ts) → 자동 검사(checks.ts: 빈 프레임 · 길이 · 정지 화면)
→ 합성(compose.ts → renderKitEdit, presetVoices로 음성 재사용) → 검수 → 결과 · 사용량 저장(usage.ts, lemo_productions)
```

## 비용 기록 원칙

- 실제 청구액 · API 단가 환산액 · 추정액을 나눠 적는다. 단가는 기준일과 출처를 함께 둔다(`usage.ts`).
- 모르는 비용은 0이 아니라 `null`(미상)로 둔다.
- Claude 사고 토큰은 출력 토큰에 이미 들어 있으므로 따로 더하지 않는다. 같은 요청의 중복 로그는 message id로 지운다(`scripts/claude-usage.ts`).

## 실행 환경

- `LEMO_OPUSCAR_HOME`: 라이브러리 폴더(그 안의 `node_modules`까지 통째로 필요). 로컬 기본값 `D:/ai/lemo-firstgel-test/_vendor/lemo-opuscar`, 고정 커밋 `9eb7739`.
- Node 20+, ffmpeg 7+, `node node_modules/playwright-core/cli.js install chromium-headless-shell`.
- GPU 없는 러너에서 WebGL 스타일은 `LEMO_ANGLE=swiftshader`가 필요하고 느리다.
- 라이선스: 라이브러리 코드 MIT(LemoLab). 엔진에 복사한 코드는 각 파일 머리에 출처를 적고 `engine/LICENSE-lemo-opuscar`를 함께 둔다. 데모 음성 · 데모 영상은 쓰지 않는다. 우리 영상에 LemoLab 표기를 넣지 않는다.
