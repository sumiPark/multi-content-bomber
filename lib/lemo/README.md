# lemo 제작 경로 (코드 기반 애니메이션)

**AI 자동 영상의 기본 영상 단계다(2026-11-11).** `lib/auto-video/make.ts`가 장면표를 저장한 뒤 `lib/auto-video/lemo.ts` → `run.ts`로 먼저 만들고, 제작 방식 선택(select.ts)은 기존 방식을 고르지 않고 구현된 lemo 스타일 중에서만 고른다(사용자 결정 2026-11-11 — 설명형 대본도 lemo). 캐릭터가 연기하는 스타일과 캐릭터 없이 그림 · 도형 · 글자로 설명하는 스타일(픽토그램 모션 · 수채 붓) 중에서 고른다. lemo로 끝내 못 만들면 사진 · 스톡 컷으로 넘어가지 않고 그 칸을 영상 없이 "다시 만들기 필요"(BLOCKED, `video.needsRemake`에 이유)로 둔다(2026-11-13 사용자 결정). 러너 변수 `AUTO_VIDEO_ENGINE=kit`이면 lemo를 부르지 않는다. 수동 실행(`worker/lemo-video.ts`, `lemo-video.yml`)도 같은 `run.ts`를 쓴다.

## 역할 나누기

| 맡는 곳 | 하는 일 |
|---|---|
| lemo-opuscar 라이브러리(외부, MIT) | `core/render/video.mjs` · `still.mjs` — 헤드리스 Chromium으로 `render(t)` 페이지를 프레임마다 찍어 **무음 mp4** |
| `lib/lemo/engine/` (브라우저 JS) | 공통 엔진: `production.json`을 읽어 장면 · 카메라 · 동작 · 전환을 계산하고, 스타일 모듈과 캐릭터 모듈로 그린다 |
| `lib/lemo/engine/styles/<slug>/` | 스타일별: 선 · 질감 · 재질 · 조명 · 그리기 엔진, 그 스타일의 전환 · 움직임. 캐릭터 없는 스타일은 전용 소품(`S.props`)도 |
| `lib/lemo/engine/explain.js` · `lib/lemo/explain.ts` | 캐릭터 없는 스타일이 함께 쓰는 모양 사전(아이콘 · 상품 · 화살표)과 그 장면 계획 |
| `lib/lemo/library/accounts/<account_key>/` | 계정 · 시리즈별: 캐릭터(명세 + 리그), 브랜드 색 · 글꼴 · 분위기, 재사용하기로 한 배경 · 소품 |
| `production.json` (영상마다) | 등장인물과 역할, 장면 · 행동 · 감정 변화, 배경 구성, 카메라, 속도와 타이밍 — `contract.ts`의 `productionSchema` |
| 기존 편집 키트(`lib/shoot/video-kit`) | 음성(Fish, 계정 목소리) · 받아쓰기 · 모션 자막 스킬 · 음악 · 효과음 · 최종 mp4 · 표지 · 완성본 검수 |

lemo 페이지는 **나레이션 자막을 그리지 않는다.** 자막은 기존 모션 자막 스킬만 얹는다. 스킬을 못 쓰면 실패로 보고하고 기본 자막으로 조용히 넘어가지 않는다.

**장면표 연결(`board-brief.ts`).** 장면표에서 말만이 아니라 장면별 화면 지시 · 화면 글자 · 자막 줄 · 강조어 · 글자 디자인(look) · 글꼴 · 끝 화면을 추려 `LemoJob.brief`로 넘긴다. 연출(direct.ts)은 그 화면을 캐릭터 · 소품 · 배치로 옮기고, 화면 글자는 장면표가 그 장면에 정한 글자만 `word` 소품으로 쓴다(그 밖의 글자는 코드가 뺀다). 합성(compose.ts)은 장면표의 자막 줄 · 강조어 · look · 글꼴을 쓰고, 장면표 없이 만드는 실행만 16자 줄바꿈 · 기본 look으로 만든다. 음악은 lemo 스타일 기준 검색어를 그대로 쓴다.

**자막 자리.** 수치는 실제 자막이 놓이는 편집 키트의 `ZONE_BOX`(`lib/shoot/video-kit/caption-style.ts`) 한 곳에서 온다. 연출은 장면마다 `caption_place`(top · lower)를 정하고 그 띠에 얼굴 · 몸 · 물건 소품 · 화면 글자를 두지 않으며(배경 층 소품인 해 · 구름은 예외), 합성은 후킹 글자와 자막을 모두 그 자리에 놓는다(`presetZones`).

## 흐름

```
제작 요청 → 대본 · 소재 분석 → 제작 방식 선택(select.ts, 기록. 캐릭터 없는 스타일이면 캐릭터 준비를 건너뛰고 장면 계획은 explain.ts) → 캐릭터 · 자산 준비(characters.ts: 계정 라이브러리 재사용 또는 새로 만들고 시트 렌더 · 검수. 상품 자료가 있으면 상품 배역을 하나 꼭 둔다. 시트가 세 번 모두 불합격이면 배역을 다시 정한다 — 아래 "캐릭터 실패 대응")
→ 음성 확정(voice.ts: 새 대본은 기존 TTS, 같은 대본 비교는 기존 음성) → 장면 계획(direct.ts → production.json, 계약 검사)
→ 코드 구성(project.ts: 엔진 + 스타일 + 그 계정 캐릭터만 복사) → 렌더(render.ts) → 자동 검사(checks.ts: 빈 프레임 · 길이 · 정지 화면)
→ 합성(compose.ts → renderKitEdit, presetVoices로 음성 재사용) → 검수 → 결과 · 사용량 저장(usage.ts, lemo_productions)
```

## 캐릭터 시트 검수

- 시트는 두 장을 찍는다(`engine/sheet.js`, 렌더 시각이 쪽 번호): 0.5초 = 전체 시트(방향 · 표정 · 동작), 1.5초 = 표정 확대. 명세의 `sheet`에는 첫 장이 남는다.
- 시트는 칸에 맞춰 줄여 그린다(방향 칸 키 197~300px, 전체 시트의 표정 칸 160px 안팎). **그림 속 크기는 영상 속 크기(`body.height` × scale)가 아니다.** 표정 확대 쪽은 칸이 허락하는 만큼, 영상 기본 크기를 넘지 않게 그린다.
- 검수(`characters.ts` `reviewSheet`)는 비전 모델의 판정이다. 코드가 재는 값이 아니므로, 명세 값으로 바꿀 수 없는 것은 검수자에게 미리 알려 불합격 사유에서 뺀다(`sheetGuide`): 시트 속 크기, 방향 칸의 몸 윤곽(리그는 얼굴 · 팔만 옮긴다), 사람 · 동물이 아닌 모양의 머리 : 키 값(리그가 쓰지 않는다). 이런 지적은 "리그 한계:"로 적혀 경고에만 남는다. 몸 형태 · 색이 설명과 다른 것은 그대로 불합격이다.
- 영상은 `front`와 `q`만 쓴다(`engine/timeline.js`). `side`는 시트에만 나오는 참고 칸이다.
- 표정 칸은 모두 동작 시각 0.25초로 그린다. talk는 1/6초마다 입을 여닫으므로 0~1/6초를 찍으면 neutral과 같은 그림이 된다.

## 캐릭터 실패 대응 (2026-11-13 사용자 결정 — 11-11의 "배역 하나라도 불합격이면 멈춘다"를 바꿈)

1. **처음 고를 때(select.ts).** 스타일마다 `styles.json`의 `needs_characters`로 캐릭터가 연기하는 방식인지, 캐릭터 없이 그림 · 도형 · 글자로 설명하는 방식인지가 적혀 있다. 고를 수 있는 후보에 두 방식이 모두 있으면 대본에 맞는 방식을 함께 고르고(`approachBlock`, 선택 결과의 `approach`), 캐릭터 없는 스타일은 배역을 두지 않는다. 구현된 스타일은 캐릭터 방식 2개(크레용 그림책 · 50년대 플랫 카툰)와 캐릭터 없는 방식 2개(픽토그램 모션 · 수채 붓, 2026-11-13)라 지금은 늘 방식 고르기가 들어간다. 캐릭터 없는 방식을 고르면 run.ts가 캐릭터 단계를 건너뛰고 explain.ts로 장면을 짠다(아래 "캐릭터 없이 설명하는 스타일").
2. **캐릭터 그림이 불합격하면(characters.ts).** 상품 배역을 먼저 만든다. 조연 시트가 세 번 모두 불합격하면 멈추지 않고 배역을 다시 정한다(`decideRecast`): 계정에 저장된 캐릭터(상품 캐릭터 · 이미 나오는 캐릭터 제외)로 바꾸거나(reuse), 몸 모양 6가지로 못 그리는 물건이면 화면 속 물건으로 두거나(object), 배역에서 제외한다(drop). 엔진에는 물건을 그리는 범용 소품이 없어(manifest props: 해 · 구름 · 양동이 · 별 · 화면 글자) object와 drop은 모두 cast에서 빠지고, 연출(direct.ts)에 "캐릭터로 세우지 않는 것"으로 넘어가 맞는 소품 · 장면표 화면 글자가 있을 때만 그것으로, 없으면 다른 배역의 행동 · 카메라로 보여 준다. 다시 정한 기록은 선택 결과의 `recast`와 사람이 볼 경고(자동 발행 멈춤)로 남는다. 상품 배역은 뺄 수 없어 불합격이면 `LemoCastError`로 멈춘다.
3. **캐릭터 없는 방식으로 다시 만들기.** 그래도 `LemoCastError`로 멈추면 `lib/auto-video/lemo.ts`의 `remakeWithoutCharacters`가 같은 장면표 · 음성 원고로 영상 전체를 `<out>/no-characters`에서 처음부터 다시 만든다. 스타일은 AI를 다시 부르지 않고 규칙 점수로 고르고(`select.ts chooseNoCharacterStyle`, `run.ts` `job.noCharacters`), 다시 만든 영상은 경고(자동 발행 멈춤)를 남긴다. 다시 만들기도 실패하면 두 이유를 함께 남기고 4로 간다.
4. **끝까지 안 되면.** 사진 · 스톡 컷으로 만들지 않는다. `make.ts`가 `LemoBlocked`로 멈추고, 워커가 칸을 BLOCKED로 두고 `note` · `video.needsRemake`에 이유를 남긴다. 확인 화면은 "다시 만들기 필요"와 이유를 보여 주고, 사람이 화면만 다시 · 대본부터 다시로 다시 만든다. 캐릭터가 아닌 실패(렌더 환경 · 음성 · AI 호출 한도 등)도 같은 방식으로 멈춘다.

## 캐릭터 없이 설명하는 스타일 (2026-11-13)

- **스타일:** `pictogram-motion`(픽토그램 모션 — 한 색상 다섯 톤 격자 무늬, 둥근 막대 · 원으로 된 평면 픽토그램, 띠가 맞춰지며 들어오는 등장, 아래에서 밀려 올라오는 굵은 글자, 숫자 없는 진행 눈금)과 `watercolor`(수채 붓 — 시드 고정 수채 종이, 붓 자국 · 물감 번짐으로 스스로 칠해지는 그림, 손글씨 메모). 라이브러리 `styles/<slug>/STYLE.md`의 문법과 데모 엔진 일부(격자 무늬 · 무늬 조각 · 붓 엔진)를 옮겼다(파일 머리에 출처). manifest에 `characters: false`와 스타일 전용 `props`가 있다.
- **화면 요소:** 배우 대신 스타일 전용 소품만 쓴다 — `product`(소개하는 상품), `icon`(아이콘 16개, manifest `icons` · `engine/explain.js` ICONS), `arrow`, `bullet`(목록 점), `word`(장면표가 정한 화면 글자만). 배경은 픽토그램 `grid · stage · split`, 수채 `page · wash · split`. 공용 소품(해 · 구름 · 양동이 · 별)은 캐릭터 스타일용이라 쓰지 않는다.
- **장면 계획(`explain.ts directExplainer`):** 캐릭터 영상과 같은 파이프라인이다. 음성 시각으로 코드가 장면 시각을 계산하고(direct.ts `buildProduction`), 같은 계약 · 자막 자리 검사와 장면표 밖 글자 빼기를 쓰며, 검사 문제를 되먹여 최대 두 번 다시 쓴다. 결과는 같은 `production.json`(cast · actors 빈 배열)이고 렌더 · 합성(편집 키트 · 음성 · 모션 자막 스킬)은 그대로다.
- **상품:** 상품 배역과 같은 규칙 — 실제 사진을 쓰지 않고 상품 글 자료의 용기 · 포장 · 색 단서로 모양(bottle · tube · jar · box · pouch · fruit · blob)과 색을 정해(`product_look` → `style.params.product_*`) 비슷한 결로 그린다. 글자 · 로고는 그리지 않는다. 추정한 모양 · 색은 검수 경고로 남겨 사람이 확인한다.
- **엔진 변경 범위:** `main.js`는 스타일 전용 소품(`S.props`)과 글꼴 기다리기(`S.ready`)만 먼저 찾고, 없으면 예전과 같다. 기존 두 스타일의 고정 장면 데이터(fixtures) 정지 화면은 변경 전후 파일이 같다(2026-11-13 확인). 굵은 글자 글꼴은 저장소의 Pretendard ExtraBold(OFL)를 `engine/fonts`에 복사해 쓴다.
- **알려진 점:** 수채는 다 칠한 뒤 화면이 거의 멈춰 있어 무음 렌더 검사(checks.ts)가 "멈춰 있어요" 경고를 자주 남긴다(검수 경고 → 자동 발행 멈춤).

## 비용 기록 원칙

- 실제 청구액 · API 단가 환산액 · 추정액을 나눠 적는다. 단가는 기준일과 출처를 함께 둔다(`usage.ts`).
- 모르는 비용은 0이 아니라 `null`(미상)로 둔다.
- Claude 사고 토큰은 출력 토큰에 이미 들어 있으므로 따로 더하지 않는다. 같은 요청의 중복 로그는 message id로 지운다(`scripts/claude-usage.ts`).

## 실행 환경

- `LEMO_OPUSCAR_HOME`: 라이브러리 폴더(그 안의 `node_modules`까지 통째로 필요). 로컬 기본값 `D:/ai/lemo-firstgel-test/_vendor/lemo-opuscar`, 고정 커밋 `9eb7739`.
- Node 20+, ffmpeg 7+, `node node_modules/playwright-core/cli.js install chromium-headless-shell`.
- GPU 없는 러너에서 WebGL 스타일은 `LEMO_ANGLE=swiftshader`가 필요하고 느리다.
- 라이선스: 라이브러리 코드 MIT(LemoLab). 엔진에 복사한 코드는 각 파일 머리에 출처를 적고 `engine/LICENSE-lemo-opuscar`를 함께 둔다. 데모 음성 · 데모 영상은 쓰지 않는다. 우리 영상에 LemoLab 표기를 넣지 않는다.
