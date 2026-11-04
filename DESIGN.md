# MCB 디자인 규칙

모든 화면 작업은 이 문서를 따른다. 규칙을 바꿔야 하면 **화면보다 이 문서를 먼저 수정**하고, 아래 변경 기록에 남긴다.

- 기준: **Marketing Hub 디자인 규칙**(`D:/project_program/marketing-hub/DESIGN.md`)과 같은 토큰 · 컴포넌트 규칙을 쓴다(2026-11-03 사용자 결정). 두 서비스가 같은 생김새를 갖는다.
- 실제 구현: `app/globals.css`(shadcn 기본 이름에 매핑 + `bg-surface-2` · `text-ink-2` · `bg-ok-soft` 같은 확장 토큰), `components/ui/*`(버튼 · 카드 · 배지 · 입력 · 탭).
- 시안: `local/design-mockups-v2/7-marketing-hub.html`, 콘텐츠 생성 · 배포 관리는 `8-upload-postings.html` (git 제외)

---

## 1. 원칙

1. **할 일이 먼저 읽힌다.** 들어오면 지금 사람이 할 일 · 멈춘 것 · 마감이 먼저 보인다. 장식(그라디언트, 일러스트, 큰 히어로)은 쓰지 않는다.
2. **한 화면에서 끝낸다.** 조회 → 판단 → 조치가 화면 이동 없이. 상세는 오른쪽 서랍, 입력은 모달.
3. **결과를 분명히.** 확인 · 예약 · 건너뛰기 같은 조작은 결과를 과거형으로 알린다(“확인했어요”).
4. **색만으로 의미를 전달하지 않는다.** 상태는 색 + 아이콘 또는 글자를 함께 쓴다.
5. **쉬운 말.** 메뉴 · 버튼에 내부 용어(B 트랙, 컨펌, N단계)를 쓰지 않는다.

## 2. 색 토큰

라이트 테마가 기본(다크 토큰도 같은 이름으로 정의돼 있지만 지금은 전환 기능이 없다). 컴포넌트는 토큰만 쓰고 색 값을 직접 쓰지 않는다.

| 토큰 (Tailwind) | 값 | 용도 |
|---|---|---|
| `bg-background` | `#F4F6F9` | 앱 바탕(회색). **흰 패널 · 입력칸에 쓰지 않는다** |
| `bg-card` | `#FFFFFF` | 패널, 표, 모달, 입력칸, 선택된 탭 |
| `bg-surface-2` / `bg-secondary` / `bg-muted` | `#F5F6F8` | 표 머리, 선택 안 된 탭, 보조 배경 |
| `bg-surface-3` / `bg-accent` | `#E8EBEF` | hover, 눌림, OFF 토글 |
| `text-foreground` | `#191F28` | 본문, 숫자 |
| `text-ink-2` | `#333D4B` | 보조 본문 |
| `text-muted-foreground` | `#6B7684` | 레이블, 캡션 |
| `text-faint` | `#A2AAB5` | 비활성, 메뉴 묶음 이름 |
| `border-border` | `#E5E8EB` | 구분선, 패널 테두리 |
| `border-input` / `border-line-strong` | `#D1D6DB` | 입력 · 보조 버튼 테두리 |
| `bg-primary` · `text-primary` | `#1F6FFF` | 주요 버튼, 선택, 링크 (hover `#1558D6`) |
| `bg-brand-soft` | `#EAF2FF` | 선택 배경(사이드바 선택 메뉴), 안내 영역 |

### 의미 색 (상태 전용)

| 토큰 | 값 / soft | 의미 |
|---|---|---|
| `ok` | `#18A050` / `#E8F8EE` | 정상, 연결됨, 예약됨, 완료 |
| `warn` | `#E8710A` / `#FFF3E0` | 확인 필요, 예약중, AI 점검이 짚은 것 |
| `risk` | `#E5384A` / `#FFECEE` | 오류, 실패, 멈춤, 금지 표현 |

- 쓰는 법: 글자 `text-ok`, 배경 `bg-ok-soft`, 테두리 `border-ok/30~40`.
- 배지 variant: `default`(파랑 soft) · `secondary`(회색) · `ok` · `warn` · `destructive`(risk) · `outline`.

### 콘텐츠 방식 배지

| 방식 | 토큰 | 글자 |
|---|---|---|
| AI 자동 업로드 (시각은 자동 업로드 일정) | `bg-lv-ai-soft` / `text-lv-ai` (`#F0EDFF` / `#6E56CF`) | AI 자동 |
| 직접 촬영 (날짜 · 시각 없는 기획 목록) | `bg-lv-shoot-soft` / `text-lv-shoot` (`#E8F8EE` / `#18A050`) | 직접 촬영 |

### 토큰을 쓰지 않는 예외 (기능)

- **계정 그룹 색**: 사용자가 그룹마다 고르는 팔레트(`components/accounts/accounts-page.tsx`, 콘텐츠 생성 마법사의 그룹 목록). 데이터에 저장된 선택값이라 토큰으로 바꾸지 않는다.
- **플랫폼 로고 색**: 유튜브 · 인스타그램 · 틱톡 공식 색(`components/ui/platform-icon.tsx`).
- **캡션 미리보기**: 어두운 영상 미리보기 위 글자색.

## 3. 타이포그래피

- 글꼴: **Pretendard Variable**(`pretendard` npm 패키지 자체 호스팅) → 대체 `"Apple SD Gothic Neo", "Malgun Gothic", system-ui`
- 숫자가 나오는 모든 곳: `tabular-nums` (표 `td`는 기본 적용)
- 한글 줄바꿈: `word-break: keep-all` (body 기본)

| 이름 | 크기 | 굵기 | 용도 |
|---|---|---|---|
| kpi | 24px | 700 | 숫자 카드 |
| title | 20px (`text-xl font-bold tracking-[-0.01em]`) | 700 | 페이지 제목 |
| topbar | 18px | 700 | 상단바 화면 이름 |
| section | 15~16px | 600 | 패널 · 카드 제목 |
| body | 14px | 400 | 본문, 메뉴 |
| table | 13px | 400 · 500 | 표, 버튼, 입력 |
| caption | 12px | 400 · 500 | 보조 정보, 배지, 표 머리 |

12px 미만은 쓰지 않는다(배지 숫자 11px만 예외).

## 4. 간격 · 크기 · 모서리

- 기본 단위 4px. 본문 바깥 여백 24px(모바일 16px): `p-4 sm:p-6`
- 컨트롤 높이: 기본 36px(`h-9`), 작은 것 32px(`size="sm"`), 큰 버튼 44px(`size="lg"`)
- 표: 머리 44px, 줄 52px, 칸 좌우 14px
- 모서리: 컨트롤 8px(`rounded-md`), 패널 · 카드 12px(`rounded-lg`), 모달 · 서랍 16px(`rounded-xl`), 배지 pill
- 그림자: 평면 요소는 테두리만. 떠 있는 요소(드롭다운 · 모달 · 서랍 · 토스트)만 `0 8px 24px rgb(16 24 40/.12), 0 2px 6px rgb(16 24 40/.08)`

## 5. 레이아웃 · 앱 셸 (`components/layout/sidebar-shell.tsx`)

- 왼쪽 사이드바 240px + 상단바 60px + 본문
- 사이드바 위에서부터: 로고(28px 파란 타일 + “MCB”) → 조직 카드(조직 이름 + 내 역할) → 메뉴 묶음(묶음 이름 12px `text-faint`, 메뉴 42px · 아이콘 18px, 선택 메뉴 `bg-brand-soft` + `text-primary`) → 아래 사용자(이메일 + 로그아웃 아이콘 버튼). **사이드바 전체가 스크롤**된다(메뉴가 가려지지 않게)
- 메뉴 배지: 배포 관리 실패 건수(빨간 pill, 99+), 아직 없는 기능 “준비 중”(회색 pill), 마지막으로 본 뒤 새 결과가 나온 화면(8px 파란 점 `bg-primary` + 읽기용 이름 “새 결과”, 그 화면을 열면 사라짐 — 분석의 프로필 점수)
- 상단바: 왼쪽 화면 이름(메뉴 이름과 같다), 오른쪽 상태(발행 실패가 있으면 “발행 실패 n건” risk pill → 배포 관리)
- 1024px 미만: 사이드바를 숨기고 상단바 메뉴 버튼으로 왼쪽 260px 패널을 연다. 메뉴를 누르거나 바깥을 누르면 닫힌다
- 본문: 페이지 머리(제목 20px + 설명 13~14px `text-muted-foreground`, 오른쪽 주 동작) → 내용. **본문은 화면 전체 폭을 쓴다**(`<main>`에 `max-w-*`를 두지 않는다, 바깥 여백 `p-4 sm:p-6`만). 넓은 화면에서는 표 · 카드 격자가 넓어지고, 폭이 넓으면 읽기 어려운 것(긴 설명 문단 · 입력 폼 한 줄)만 그 요소에 `max-w-*`를 준다
- **공개 페이지**(로그인 · 개인정보처리방침 · 이용약관 · 데이터 삭제)와 **아래 정책 링크 푸터**는 Meta · Google 검수 크롤러가 확인하는 곳이라 구조를 바꾸지 않는다

## 6. 컴포넌트 규칙

### 버튼 (`components/ui/button.tsx`)
- `default`(파랑 채움) — 화면당 1개의 주 동작
- `outline`(흰 바탕 + 테두리) — 일반 동작
- `ghost`(배경 없음) — 표 안, 툴바 아이콘
- `destructive`(risk soft) — 삭제 · 해제
- 레이블은 동사로 끝나는 짧은 말: “확인”, “건너뛰기”, “다시 연결”

### 카드 = 패널 (`components/ui/card.tsx`)
- 흰 바탕 + 1px 테두리, 모서리 12px, 그림자 없음. 제목 15px 600, 설명 13px

### 배지 · 칩 (`components/ui/badge.tsx`)
- 높이 24px pill, 12px 600. 상태: 정상 `ok` · 확인 필요 `warn` · 오류 `destructive` · 대기 · 꺼짐 `secondary` · 내 차례 · 선택 `default`

### 입력 (`components/ui/input.tsx`, `textarea.tsx`, 직접 만든 `<select>`)
- 높이 36px, 모서리 8px, 테두리 `border-input`, **흰 바탕 `bg-card`**, 글자 13px(모바일 16px — 확대 방지)
- 포커스는 `ring` 파랑 테두리 + 링. 오류는 입력 아래 12px `text-risk`(원인 + 해결)

### 탭 (`components/ui/tabs.tsx`)
- 세그먼트: `bg-surface-2` + 테두리, 선택 칸 흰 바탕 + 굵게
- 탭 패널 없이 값 하나만 고르는 버튼 묶음(사진/영상, 기간, 바로/예약)은 `components/ui/segmented.tsx`
- 표 위 상태 탭: 건수 pill이 붙은 폴더형 탭(선택 탭 흰 바탕 + 파란 건수) — 배포 관리

### 알림 상자
- 멈춤 · 오류: `bg-risk-soft` + `text-risk` 아이콘 + 문구 + 고치는 버튼
- 확인 필요: `bg-warn-soft` / `border-warn/40`
- 안내: `bg-brand-soft`

### 토스트
- 오른쪽 아래, 4초, 결과를 과거형으로

## 7. 변경 기록

- 2026-11-04 직접 촬영을 날짜 · 시각 칸에서 뺌. 편성표 → “자동 업로드 일정”(AI 자동 콘텐츠 묶음), 완성본 확인 → “완성본 받기”, “촬영 설정” 메뉴 추가. 대시보드에서 할 일 칸 · 하루 칸 표를 빼고 경고 · 계정별 오늘 올린 개수 · 업로드 예정만 둠
- 2026-11-04 토스트(`components/ui/toast.tsx`, `toast("…")`) · 확인 창(`components/ui/confirm-dialog.tsx`)을 공용 부품으로. 되돌릴 수 없는 조작은 확인 창, 결과는 토스트. 앱 셸의 `<main>` 중첩 제거
- 2026-11-04 메뉴 배지에 “새 결과” 파란 점 추가(분석 — 프로필 점수가 새로 나오면). 분석 화면은 “프로필 점수 | 게시물 성과” 탭(데이터 있는 탭이 먼저 열림, 탭 옆 건수 pill)

- 2026-11-03 콘텐츠 생성 · 배포 관리를 시안 8로 바꿈: 마법사는 왼쪽 단계 목록 + 가운데 패널 + 오른쪽 요약, 배포 관리는 숫자 카드 · 상태 탭 · 일괄 작업 바 · 오른쪽 서랍 · 토스트. `Segmented` 부품 추가
- 2026-11-03 본문 폭 제한(`max-w-4xl~7xl`) 없앰 — 시안처럼 본문이 화면 전체 폭을 쓴다(사용자 요청)
- 2026-11-03 처음 작성. Marketing Hub 디자인 규칙으로 전환(토큰 · Pretendard · 버튼 36px · 카드 테두리 · 칩 배지 · 240px 사이드바 + 60px 상단바 · 제목 20px · 본문 여백 24px). 화면의 직접 색 지정(호박 · 초록 · 빨강 · 파랑)을 의미 토큰으로 바꿈(그룹 색 팔레트 · 플랫폼 색 · 캡션 미리보기는 예외)
