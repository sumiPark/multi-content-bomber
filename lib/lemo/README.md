# lemo 제작 경로 (코드 기반 애니메이션)

**AI 자동 영상의 기본 영상 단계다(2026-11-11).** `lib/auto-video/make.ts`가 장면표를 저장한 뒤 `lib/auto-video/lemo.ts` → `run.ts`로 먼저 만들고, 제작 방식 선택(select.ts)이 기존 방식을 고르거나 lemo가 실패하면 사진 · 스톡 컷으로 만든다(실패는 경고로 남아 자동 발행을 멈춘다). 러너 변수 `AUTO_VIDEO_ENGINE=kit`이면 lemo를 부르지 않는다. 수동 실행(`worker/lemo-video.ts`, `lemo-video.yml`)도 같은 `run.ts`를 쓴다.

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

## 흐름

```
제작 요청 → 대본 · 소재 분석 → 제작 방식 선택(select.ts, 기록) → 캐릭터 · 자산 준비(characters.ts: 계정 라이브러리 재사용 또는 새로 만들고 시트 렌더 · 검수)
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
