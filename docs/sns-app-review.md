# SNS 플랫폼별 앱 검수 가이드 (MCB)

YouTube/Instagram/TikTok 세 플랫폼의 Content Posting API를 운영용으로 쓰려면 각 플랫폼이 요구하는 검수(App Review / Audit / OAuth Verification)를 통과해야 한다. 이 문서는 **사용자(앱 운영자)가 해야 할 작업**과 각 플랫폼에서 요구하는 정보를 한 곳에 모은다.

> ⚠️ 콘솔 UI/메뉴 위치는 자주 바뀐다. 이 문서는 2026-05 시점 기준이며, 정확한 위치는 각 플랫폼 공식 문서를 함께 참조.

## 0-A. 도메인 소유 증명 절차 (Google Search Console / Meta / TikTok 공통 베이스)

세 플랫폼 모두 운영 도메인의 소유 증명을 요구한다. 한 번 익혀두면 같은 방식으로 세 곳에 적용.

### Vercel 도메인 (`*.vercel.app`)을 그대로 쓰는 경우

Vercel preview/production 도메인은 우리가 DNS 통제권이 없어 일부 verify 방식이 불가능. 가능한 방식:

- ✅ **HTML 파일 업로드**: Next.js 프로젝트 `public/` 디렉토리에 verify 파일을 두고 배포 → `https://yourapp.vercel.app/google1234abcd.html` 같은 URL이 즉시 응답. Search Console / TikTok HTML 방식 둘 다 OK
- ✅ **Meta tag**: Next.js의 `app/layout.tsx`에서 `<head>`에 `<meta>` 추가 — Search Console / TikTok 둘 다 OK
- ❌ DNS TXT — Vercel 서브도메인은 우리가 DNS 통제 불가, 사용 불가

### 자체 도메인 (예: `mcb.com`)을 Vercel에 연결한 경우

- ✅ HTML 파일 / Meta tag — 위와 동일
- ✅ **DNS TXT** — 도메인 등록기관(가비아, GoDaddy, Cloudflare 등) 대시보드 → DNS 관리 → TXT 레코드 추가. Meta Business Verification은 사실상 DNS TXT를 권장

### 절차 — Google Search Console (YouTube 검수에 필수)

1. https://search.google.com/search-console 접속 (Google 계정 로그인 필요, OAuth client 발급한 계정과 동일해야 편함)
2. 좌측 상단 속성 선택기 → **속성 추가**
3. 두 옵션 중 선택:
   - **도메인** (root + 모든 서브도메인 한꺼번에) — DNS TXT만 가능
   - **URL 접두어** (예: `https://mcb.vercel.app/`) — HTML 파일 / Meta tag / Google Analytics 등 다양 ⭐ **Vercel 도메인은 이쪽 선택**
4. URL 입력 → **계속**
5. 추천 방법: **HTML 파일 업로드**
   - 파일 다운로드 (예: `google1234567890abcdef.html`)
   - Next.js 프로젝트 `public/` 폴더에 그대로 넣기
   - `git commit` + `git push` → Vercel 자동 배포 (1~2분)
   - 배포 후 브라우저에서 `https://yourapp.vercel.app/google1234567890abcdef.html` 접속해 200 응답 확인
   - Search Console로 돌아와 **확인** 클릭

### 절차 — Meta Business Verification 도메인

1. Meta Business Suite → **Business settings** → **Brand safety** → **Domains** → **+ Add**
2. 도메인 입력 → 등록
3. 등록된 도메인 클릭 → 3가지 방식 중 선택:
   - **DNS TXT 레코드** ⭐ Meta는 이걸 권장 (자체 도메인일 때만)
   - HTML 파일 업로드
   - Meta tag (`<meta name="facebook-domain-verification" content="...">`)
4. **Verify** 클릭

### 절차 — TikTok URL Properties

위 §3.1 D 단계 참조. HTML 파일 방식이 Vercel과 가장 잘 맞음.

### Tip — 한 번에 끝내기

운영 도메인 root에 다음 파일들을 함께 두면 세 플랫폼 모두 한 번에 verify 가능:
- `public/google<해시>.html` (Google)
- `public/tiktok<해시>.txt` (TikTok)
- `<meta name="facebook-domain-verification" content="<해시>" />` in `app/layout.tsx`'s `<head>`

각 콘솔에서 verify 코드를 받아온 후 한 번에 commit & deploy. 이후 각 콘솔로 돌아가 **Verify** 클릭.

## 0. 시작 전 공통 준비물 ⭐

세 플랫폼 모두 아래를 요구한다. 한 번 준비해두고 재사용.

### 0.1 도메인 + 공개 페이지

| 항목 | 요구 플랫폼 | 우리 현황 |
|---|---|---|
| Homepage URL (`https://...`) | Google · Meta · TikTok | `NEXT_PUBLIC_SITE_URL`로 운영 (Vercel) |
| Privacy Policy URL | Google · Meta · TikTok | ❌ **신설 필요** — `/privacy` 페이지 작성 |
| Terms of Service URL | Meta · TikTok | ❌ **신설 필요** — `/terms` 페이지 작성 |
| Data Deletion URL | Meta | ❌ **신설 필요** — `/data-deletion` 또는 계정 disconnect 흐름 문서 |
| 도메인 소유 증명 | Google (Search Console) · TikTok (URL Properties) | Vercel 도메인 + Google Search Console 등록 필요 |

**Privacy Policy 최소 항목**:
- 수집하는 데이터 (OAuth 토큰, 업로드 미디어, 캡션, 분석 데이터)
- 보관 위치 (Supabase EU/US, AES-256 토큰 암호화)
- 제3자 공유 (OpenAI — 캡션 생성 시 이미지/메타 전송, YouTube/Instagram/TikTok — 사용자 동의 하에 게시)
- 사용자 권리 (계정 disconnect, 데이터 삭제 요청 방법)
- 연락처

**Data Deletion 흐름**: 우리는 `/accounts` 페이지에서 disconnect 기능이 있으므로([app/(dashboard)/accounts/actions.ts](../app/(dashboard)/accounts/actions.ts) 참조), Data Deletion URL에는 그 절차를 안내 페이지로 만들어 링크하면 된다. Meta는 **자동화된 데이터 삭제 webhook**도 받지만, 안내 페이지로 충분.

### 0.2 사업자 정보

- **Meta**: Business Verification에서 사업자등록증 또는 정부 발급 신분증 + 사업장 주소 증명 필요. 개인사업자도 가능. 미등록이면 1주일 내 발급 추천.
- **Google**: 사업자 등록은 필수 아니지만 "Brand verification" 단계에서 회사명/로고 일관성 검사. 개인이어도 가능.
- **TikTok**: 사업자 등록 필수 아님. 다만 회사 정보 입력 필드는 있음.

### 0.3 데모 영상 (스크린 캡처)

각 플랫폼이 요구. **사용자 → 우리 앱 로그인 → OAuth 연동 → 콘텐츠 업로드 → 게시 → 게시된 결과 확인**까지 한 흐름으로 한 영상에 담는다(2~5분).

- 녹화 도구: Loom, OBS, Windows 캡처
- 업로드 위치: YouTube unlisted (Google) / Vimeo / Google Drive 공유 링크
- 캡션 자막은 영문 권장 (특히 Meta/Google)

영상 한 번 잘 만들어두면 세 플랫폼에 공통 사용 가능.

### 0.4 영문 Use Case Description (신청서 본문)

각 플랫폼 신청서에 그대로 붙여 쓸 수 있는 영문 한 단락. 우리 앱 작동을 정확히 반영했다.

> **MCB (Multi-Content Bomber)** is a SaaS tool that helps content creators and small marketing teams broadcast a single piece of content (image or short-form video) across YouTube Shorts, Instagram Reels, and TikTok at once. The user signs in with their own social account via OAuth and explicitly authorizes the app to publish content on their behalf. AI-generated captions tailored to each platform are produced from the source media using OpenAI GPT-4o, the user reviews and edits them, and only then are publish jobs queued. Tokens are stored encrypted at rest (AES-256), revoked when the user disconnects an account, and never shared with third parties beyond the API call to the originating platform.

플랫폼별 권한 정당화 문구는 아래 각 섹션에 변형해서 둠.

## 1. YouTube — Google Cloud OAuth Verification ⭐ (가장 길고 까다로움)

**일정**: 보통 **4~6주**, 거절 시 +4주.

**우리가 쓰는 스코프** (`lib/platforms/youtube.ts`):
- `https://www.googleapis.com/auth/youtube.upload` — **Sensitive Scope**
- `https://www.googleapis.com/auth/youtube.readonly` — **Sensitive Scope**

> ⚠️ 일부 옛날 Google 문서는 `youtube.upload`를 Restricted로 분류한다. 2026-05 시점 실제 콘솔 "데이터 액세스 요약" 화면에서는 **둘 다 "민감한 범위(Sensitive)"** 섹션에 노출되고 "제한된 범위(Restricted)"는 비어있다. Restricted가 아니면 **CASA Tier 2 보안 평가 불필요** — Sensitive scope verification만 받으면 된다 (§1.4 참조).

### 1.0 검수 회피 옵션 (가능하면 이쪽이 압도적으로 유리)

**Google Workspace Internal 모드**로 운영 가능하면 verification 자체가 면제된다.

- 조건: 회사가 Google Workspace 도메인을 소유하고, 모든 사용자가 같은 Workspace 도메인 계정만 씀 (`you@회사도메인.com`)
- 설정: OAuth 동의 화면 → **사용자 유형(User type)을 "내부(Internal)"로 전환**
- 효과: sensitive scope 그대로 사용 가능, 100명 한도 없음, "Unverified app" 경고 화면 없음, 데모 영상/justification 작성 불필요
- 한계: Workspace 도메인 밖 계정(개인 gmail 포함)은 절대 못 씀

회사 도메인이 Workspace 가입돼있는지 모르면: **Admin Console**(`admin.google.com`) 접근이 되면 OK. 안 되면 External로 가야 함.

External 운영이 필수면 아래 1.1~1.5 그대로 진행.

### 1.1 콘솔 작업 — 메뉴 경로 단위

> 진입: https://console.cloud.google.com → 좌측 상단 프로젝트 선택기에서 **OAuth Client를 이미 발급한 그 프로젝트** 선택.

#### A. YouTube Data API v3 활성화 (이미 했다면 skip)

1. 좌측 햄버거 메뉴(☰) → **APIs & Services** → **Library**
2. 검색창에 `YouTube Data API v3` 입력 → 결과 클릭
3. 상단 파란색 **ENABLE** 버튼 클릭

#### B. OAuth consent screen 설정

1. 좌측 햄버거 메뉴 → **APIs & Services** → **OAuth consent screen**
2. 처음이라면 User Type 선택 화면:
   - **External** 라디오 선택 → **CREATE** 클릭
3. **OAuth consent screen** 탭 (1/4 단계) — "App information" 폼:
   - **App name**: `MCB` (사용자가 보게 될 이름)
   - **User support email**: 본인 Gmail (드롭다운에서 선택)
   - **App logo**: 120×120 PNG 업로드 (필수는 아니지만 Production 검증 시 사실상 요구)
   - **App domain** 그룹:
     - Application home page: `https://<운영 도메인>` (예: `https://mcb.vercel.app`)
     - Application privacy policy link: `https://<운영 도메인>/privacy`
     - Application terms of service link: `https://<운영 도메인>/terms`
   - **Authorized domains** — 위 도메인의 root (예: `vercel.app` 또는 자체 도메인 `mcb.com`). Search Console verify된 도메인만 입력 가능
   - **Developer contact information**: 본인 이메일
   - **SAVE AND CONTINUE**
4. **Scopes** 탭 (2/4) — `youtube.upload` + `youtube.readonly` 추가:
   - **ADD OR REMOVE SCOPES** 버튼 클릭
   - 우측 패널 검색창에 `youtube` 입력
   - 체크박스 두 개 체크:
     - `.../auth/youtube.upload` (Restricted)
     - `.../auth/youtube.readonly` (Sensitive)
   - 우측 하단 **UPDATE** → 메인 화면으로 돌아오면 **SAVE AND CONTINUE**
5. **Test users** 탭 (3/4):
   - **+ ADD USERS** → 본인 Google 계정 이메일 추가 (검증 전엔 여기 추가된 사용자만 OAuth 가능, 최대 100명)
   - **SAVE AND CONTINUE**
6. **Summary** 탭 (4/4) → **BACK TO DASHBOARD**

#### C. OAuth Client redirect URI 점검

1. 좌측 햄버거 → **APIs & Services** → **Credentials**
2. "OAuth 2.0 Client IDs" 표에서 우리가 쓰는 Client → 연필 아이콘(편집) 클릭
3. **Authorized redirect URIs** 섹션:
   - 정확히 일치해야 함: `${NEXT_PUBLIC_SITE_URL}/api/auth/callback/youtube`
   - 운영 도메인 + 로컬 둘 다 등록 권장 (`http://localhost:3000/api/auth/callback/youtube`)
4. **SAVE**

#### D. Verification (Production 전환) 신청

> ⚠️ **Brand verification(브랜딩 인증)과 Scope verification(범위 검증)은 별도 단계**다. 브랜딩이 "인증됨 / 사용자에게 표시되고 있습니다"로 통과돼도 scope는 ⚠️ 노란 경고 그대로 남아있다 — 둘 다 통과해야 끝.

1. **OAuth consent screen** 화면 상단 **PUBLISH APP** 클릭 → 확인 다이얼로그 → **CONFIRM**
2. Publishing status가 "In production"으로 바뀌면서 즉시 노란색 박스 "Your app requires verification" 노출
3. 박스 안의 **PREPARE FOR VERIFICATION** 클릭 → 검증 위저드 시작
4. 위저드 단계:
   - **Brand verification**: App name / logo / homepage / privacy / terms 검토. 통과 시 별도 알림 + "사용자에게 표시되고 있습니다" 상태로 전환. 여기까지는 빠름 (수 일).
   - **사전 분기 질문 — "애플리케이션이 WordPress 사이트 관리자만 사용하는 Gmail SMTP 플러그인인가요?"** → **아니오(No)** 선택. "예"로 답하면 잘못된 간소화 트랙으로 들어가 즉시 거절됨.
   - **Scope verification ("데이터 액세스")**: 콘솔이 위저드를 바꿔서 **scope별 개별 입력란이 아니라 한 입력칸에 sensitive scope 전체 정당화를 합쳐서** 작성하게 한다.
     - 입력 필드: "범위가 어떤 방식으로 사용되나요?" — **1000자 제한**
     - 본문은 [1.3 견본](#13-신청서-영문-견본)의 통합본(989자) 그대로 복붙
   - **Demo video**: **YouTube 링크만 허용** (Drive/Vimeo 거절). **Unlisted**로 올리면 충분 (Public 불필요)
   - **Submit**
5. 제출 후 좌측 ⚠️ 노란 경고 → 🔵 **검토 중(In review)** 으로 바뀌고 `tjdwnd1004@gmail.com`으로 접수 메일 도착해야 정상.
6. 이메일로 진행 상황 통보. 보통 첫 응답 3~7일, 통과까지 4~6주.

> 입력만 하고 "저장"만 누르면 임시 저장 상태 — 페이지 하단 **"확인을 위해 제출(Submit for verification)"** 버튼까지 눌러야 검토 큐에 들어간다.

### 1.2 검증 요구 항목 (Google이 자동 안내)

- ✅ Authorized domains에 등록된 모든 도메인 = **Google Search Console에서 소유 증명** 완료
- ✅ Privacy Policy URL이 위 도메인 안에 호스팅되고 publicly accessible
- ✅ Homepage가 앱의 기능을 명확히 설명
- ✅ App logo가 일관(homepage 로고 = 콘솔 로고)
- ✅ Restricted/Sensitive Scope별로 **why** 정당화 영문 작성
- ✅ **데모 비디오 YouTube unlisted 링크** — OAuth 동의 화면 → 권한 사용 → 결과 데이터를 어떻게 쓰는지 흐름

### 1.3 신청서 영문 견본

**"범위가 어떤 방식으로 사용되나요?" 통합 입력칸 (1000자 제한, 한 단락, 줄바꿈 없음, 실제 제출본 989자)** ⭐

> MCB (Multi-Content Bomber) is a content distribution tool that lets creators publish one piece of media to YouTube, Instagram, and TikTok from a single interface. We request two scopes. youtube.upload is required to call videos.insert so the authenticated user can upload their own videos (including Shorts) to their own YouTube channel from our app. We never publish without an explicit user-triggered Publish click. Titles, descriptions, and hashtags can be drafted by AI but are always reviewed and approved by the user before the publish call is made. youtube.readonly is used only to call channels.list?mine=true once during account connection, to show which channel the user just linked (channel ID, title, thumbnail). Many users own multiple Google accounts and need to confirm the correct channel is connected. We do not read videos, analytics, or comments. OAuth tokens are encrypted at rest with AES-256-GCM and never shared with third parties. A narrower scope is not available.

위 본문의 핵심 키워드 — 검토자가 거절 안 하는 데 필요한 단어:
- **user-triggered** / **reviewed and approved by the user** — 자동 publish 아님을 명시
- API 엔드포인트명 (`videos.insert`, `channels.list?mine=true`) — 검토자가 코드와 매칭 가능
- **encrypted at rest with AES-256-GCM** — 보안 처리 명시
- **A narrower scope is not available** — narrower 검토 사유 차단

**구버전 — scope별 분리 입력 화면이 다시 나오는 경우** (드물지만 백업용):

> youtube.upload: Required so the authenticated user can upload their own videos to their own YouTube channel via videos.insert, triggered by an explicit user click in our publish workflow. Captions are AI-drafted but user-approved.
>
> youtube.readonly: Used once during account connection to call channels.list?mine=true and confirm which channel the user just linked. We do not read videos, analytics, or comments.

### 1.3-1 데모 영상 — YouTube 필수 장면

**일부공개(Unlisted)**로 업로드. Private 금지. 길이는 2~5분 충분.

1. **첫 5초 — OAuth Client ID 클로즈업**: Google Cloud Console → 사용자 인증 정보 → 검증 중인 OAuth 클라이언트 상세 페이지(`*.apps.googleusercontent.com` 형식 ID가 보이는 화면). 검토자가 영상과 신청서 매칭 확인용
2. https://mcb.cuma.co.kr → 로그인
3. **계정 → YouTube 연동 클릭 → Google 동의 화면**을 **천천히** (권한 목록 "YouTube 동영상 관리", "YouTube 계정 보기" + 앱 이름 + 홈페이지/Privacy 링크 모두 명확히 보이게)
4. `youtube.readonly` 실사용: 연동 직후 채널명/썸네일이 우리 앱에 표시
5. `youtube.upload` 실사용: 콘텐츠 업로드 → 캡션 검토 → **사용자가 명시적으로 "게시" 클릭** → youtube.com에서 영상 게시 확인
6. (권장) 계정 disconnect 흐름

영상 description에 한 줄: *"OAuth verification demo for Multi-Content Bomber (client ID: ...). Demonstrates youtube.upload and youtube.readonly usage."*

### 1.4 보안 평가 (CASA Tier 2)

CASA는 **Restricted Scope에만** 적용된다. 현재 우리 scope는 둘 다 Sensitive로 분류돼있어 **CASA 불필요**. 만약 향후 `youtube.force-ssl`이나 `youtube` 같은 Restricted scope를 추가하면 그때 CASA Tier 2 자체 평가지(Self-Assessment Questionnaire) 제출 필요.

### 1.5 흔한 거절 사유

- 데모 영상에서 "사용자가 OAuth 동의 화면을 명확히 보는 장면"이 없음 (너무 빠르게 넘김)
- 데모 영상에 **OAuth Client ID가 나오지 않음** — 검토자가 신청서와 영상을 매칭 못 함
- Privacy Policy에 "YouTube API Services를 사용한다"는 문구 누락 (YouTube API Services Terms of Service 동의 의무)
- Authorized domain 중 하나가 Search Console verify 안 됨
- 로고가 너무 일반적이거나 placeholder
- justification 1000자에 끼워 맞추느라 "user-triggered" / "user reviews and approves" 문구가 빠짐 — 자동 publish로 오해받음
- "WordPress Gmail SMTP 플러그인인가요?"에 잘못 "예" 선택 → 다른 트랙으로 분류돼 즉시 거절

## 2. Instagram — Meta App Review

**일정**: Business Verification 1~2주 + App Review 1~2주 = **합쳐 3~4주**.

**우리가 쓰는 권한** (`lib/platforms/instagram.ts`):
- `instagram_business_basic`
- `instagram_business_content_publish` ⭐
- `instagram_business_manage_comments`

### 2.1 콘솔 작업 — 메뉴 경로 단위

> 진입: https://developers.facebook.com → 우측 상단 **My Apps** → 이미 만든 앱 클릭 (없으면 **Create App**).

#### A. 앱 생성 (이미 했다면 skip)

1. 우측 상단 **My Apps** → **Create App**
2. **Use case 선택** 화면:
   - **Other** 라디오 → **Next**
3. **Type 선택** 화면:
   - **Business** 카드 선택 → **Next**
4. **Details** 화면:
   - **App name**: `MCB`
   - **App contact email**: 본인 이메일
   - **Business portfolio**: 드롭다운에서 선택 (없으면 우측 "Create a new business portfolio")
   - **Create app**
5. 다이얼로그에서 비밀번호 재확인 후 진행

#### B. Instagram API 셋업 (Login + Graph API)

1. 좌측 사이드바 → **App settings** → **Basic** — 페이지 하단 **App ID** / **App secret**(Show 버튼) 확인. `.env.local`의 `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` 값과 일치해야 함
2. 좌측 사이드바 → **Add product** (또는 좌측 하단 "+ 추가 제품")
3. **Instagram** 카드 옆 **Set up** 클릭
4. Instagram 셋업 화면 좌측 → **API setup with Instagram Login**
5. **1. Generate access tokens** 섹션은 콘솔에서 직접 토큰 발급 테스트용 — 우리 앱은 자체 OAuth 흐름을 쓰므로 무시 가능
6. **2. Configure webhooks** — 검수 단계에선 skip
7. **3. Set up Instagram business login**:
   - **OAuth redirect URIs**: `${NEXT_PUBLIC_SITE_URL}/api/auth/callback/instagram` 등록
   - **Deauthorize callback URL**: 선택 (사용자가 인스타에서 권한 해제 시 알림 받을 webhook)
   - **Data deletion request URL**: 우리 `/data-deletion` 페이지 URL
   - **Save**

#### C. Business Verification ⭐ (가장 오래 걸리는 단계)

1. **Meta Business Suite** 별도 사이트 진입: https://business.facebook.com
2. 좌측 상단 햄버거 → **All tools** → "Security and access" 카테고리 → **Security Center**
3. **Business verification** 카드 → **Start verification**
4. 안내에 따라:
   - 사업자 정보 입력 (회사명, 주소, 전화번호, 웹사이트, 사업자등록번호)
   - 도메인 verify (Meta가 제시한 DNS TXT 또는 HTML 메타 태그 — 도메인 호스팅에서 추가)
   - 사업자등록증 PDF/이미지 업로드
   - 주소 증명 서류 업로드 (공과금 고지서, 은행 명세서 등 — 회사명·주소가 사업자등록증과 일치해야 함)
5. **Submit for review** → 보통 영업일 5~10일 내 결과

> 개인사업자도 통과 가능. 단, 사업자등록증 상호 = 신청서 회사명 = 주소 증명 서류 상호 셋이 일관되어야 함.

#### D. App Review 신청

1. 다시 Meta for Developers → 좌측 사이드바 → **App Review** → **Permissions and features**
2. 검색창에 `instagram_business_content_publish` 입력 → 결과 행의 **Request advanced access** 버튼 클릭
3. 폼 작성:
   - **How will your app use this permission?**: [2.3 견본](#23-신청서-영문-견본) 영문 정당화 복붙
   - **Step-by-step instructions**: 리뷰어가 따라할 수 있게 1, 2, 3 형식 (예: "1. Go to https://mcb.vercel.app and click Login. 2. Use the test credentials provided below. 3. Click '+ New content'. 4. Select an image. 5. Toggle Instagram in the Step 4 of the wizard. 6. Click Publish.")
   - **Test credentials**: 리뷰어용 우리 앱 계정 ID/PW + 연결된 Instagram 비즈니스 테스트 계정 ID/PW
   - **Screencast/Video URL**: 데모 영상 unlisted YouTube 또는 Google Drive 링크
   - **Submit**
4. 같은 방식으로 `instagram_business_manage_comments` 별도 신청 (한 번에 묶어 신청 가능한 화면도 있음 — 표 좌측 체크박스로 다중 선택)
5. 각 권한 옆 상태가 **In review** → **Approved** 또는 **Rejected**로 바뀜. 평균 영업일 5~7일

#### E. Live mode 전환

1. 콘솔 상단 헤더 가운데 — 토글 스위치 **App Mode: Development | Live**
2. 토글 클릭 → 확인 다이얼로그 → **Switch**
3. Privacy Policy URL이 채워져 있지 않으면 토글이 막힘 — 위 B-7 단계로 돌아가 확인

### 2.2 Instagram 비즈니스 계정 요구사항 (사용자 본인 + 테스트 계정 모두)

- Instagram 계정이 **Business** 또는 **Creator** 유형이어야 함 (앱 → 설정 → 계정 → 프로페셔널 계정 전환)
- Facebook Page에 연결되어 있어야 publish API 동작
  - 단, Instagram Login 흐름(우리가 쓰는 것)은 **2024년 7월부터 Facebook Page 연결 없이도 동작**. 다만 일부 기능은 여전히 Page 필요 — 우리 publish 흐름은 Login만으로 OK.

### 2.3 신청서 영문 견본

**`instagram_business_content_publish` — Why do you need this permission?**

> MCB allows creators and small marketing teams to broadcast a single piece of media to multiple platforms at once. With this permission, the user can publish images and Reels to their own Instagram business account directly from our interface, without uploading the same file separately through the Instagram app. We never publish without an explicit user-triggered action in our publish workflow. The media being published is owned by the user. Captions and hashtags are generated by AI but reviewed and approved by the user before the publish call is made.

**`instagram_business_manage_comments` — Why do you need this permission?**

> Reserved for an upcoming auto-reply feature where the user explicitly authorizes our app to draft and post replies to comments on their own posts. This permission is requested now so we don't need a second review cycle later. The feature ships behind a user-controlled opt-in toggle; without that toggle, no comments are read or written.

### 2.4 데모 영상 — 필수 장면

Meta 리뷰어는 영상에서 다음을 확인한다:

1. 로그인 페이지
2. **Instagram OAuth 동의 화면** (인스타 계정으로 인증, 권한 목록 명확히 노출)
3. 우리 앱 안에서 콘텐츠 업로드 → 캡션 검토 → 게시 트리거
4. **Instagram 앱/웹에서 실제로 게시된 결과** (같은 사용자 프로필에 새 포스트가 떴는지)
5. 계정 disconnect 흐름 (선택이지만 데이터 삭제 신뢰도 ↑)

### 2.5 흔한 거절 사유

- 데모 영상이 권한이 실제로 어떻게 쓰이는지 보여주지 않음 (단순 mockup 이미지로는 부족)
- 테스트 계정 자격 증명을 제출 안 함
- Privacy Policy에 "Instagram에서 받은 데이터를 어떻게 처리하는지" 별도 문구 누락
- App Mode가 Development인 채로 신청

## 3. TikTok — Content Posting API Audit

**일정**: **2~3주**. 거절 빈도 높음.

**우리가 쓰는 스코프** (`lib/platforms/tiktok.ts`):
- `user.info.basic` — 기본 제공 (audit 불필요)
- `video.upload` — **audit 필수**
- `video.publish` ⭐ — **audit 필수** (가장 까다로움)

### 3.0 검수 회피 불가 ⚠️

YouTube와 달리 TikTok은 **검수 회피 옵션 없음**:

- "Internal" / "Workspace" 같은 조직 한정 모드 자체가 없음
- Sandbox 한도 매우 작고 (테스터 **10명**) Sandbox에선 게시가 **항상 SELF_ONLY**(본인 피드에 비공개)로 강제됨 → 회사 5~10명 내부 운영조차 사실상 불가
- Audit 통과 전엔 `video.publish` 호출이 **403** 반환

회사 사람만 쓴다 해도 결국 audit 통과 필수.

### 3.1 콘솔 작업 — 메뉴 경로 단위

> 진입: https://developers.tiktok.com → 우측 상단 **Manage apps** (없으면 **Log in** 후 **Become a developer**).

#### A. 앱 생성 (이미 했다면 skip)

1. **Manage apps** → 우측 **Connect an app** 또는 카드형 화면의 **+** 버튼
2. **App Details** 폼:
   - **App icon**: 정사각 PNG (512×512 이상)
   - **App name**: `MCB` (영문, 변경 어려움) — ⚠️ **TikTok 정책상 앱 이름에 "TikTok" / "Tik Tok" / "TT" 단어 절대 금지**. 들어가면 audit 자동 거절. 현재 "Multi-Content Bomber"는 OK.
   - **App description**: 영문 한 문단 — [0.4 영문 Use Case](#04-영문-use-case-description-신청서-본문) 복붙
   - **Category**: Tools / Productivity
   - **App platform**: Web 선택 (체크박스)
   - **Web/Desktop URL**: `https://<운영 도메인>`
   - **Save**
3. 앱 생성 직후 자동으로 상세 페이지로 이동. **Client key** / **Client secret** 확인 — `.env.local`의 `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`과 일치해야 함

#### B. Login Kit 추가 + Redirect URI

1. 앱 상세 페이지 좌측 사이드바 → **Add products**
2. **Login Kit** 카드 → **Add**
3. 추가 후 사이드바에 **Login Kit** 메뉴 생김 → 클릭
4. **Login Kit configuration** 화면:
   - **Redirect URI**: `${NEXT_PUBLIC_SITE_URL}/api/auth/callback/tiktok` 입력 → **Add**
   - 로컬 테스트용 `http://localhost:3000/api/auth/callback/tiktok`도 별도 추가
   - **Save**

#### C. Content Posting API 추가

1. 사이드바 → **Add products** → **Content Posting API** 카드 → **Add**
2. 사이드바에 **Content Posting API** 생김 → 클릭
3. **Mode 선택** 화면:
   - **Direct Post**: 우리가 쓰는 모드 (PULL_FROM_URL 또는 직접 업로드로 즉시 게시)
   - **Upload**: TikTok 앱의 inbox로 draft 전달 후 사용자가 모바일에서 마무리
   - **Direct Post** 선택 → **Save**

#### D. URL Properties verify ⭐

1. 사이드바 → **URL properties** (또는 Content Posting API 페이지 안의 "URL ownership verification" 섹션)
2. **+ Add property** 버튼
3. Property type 선택:
   - **Domain** 라디오 선택
   - **Domain or URL**: 우리가 video_url로 보낼 호스트. **두 가지 경로 중 선택**:
     - (a) Supabase Storage 호스트 그대로 — `<project-ref>.supabase.co`. 다만 Supabase가 임의 파일 호스팅을 안 해주므로 verify 거의 불가능
     - (b) **우리 Vercel 도메인** (권장). 단, `lib/platforms/tiktok.ts`의 `video_url`을 자체 도메인 proxy 엔드포인트로 교체하는 코드 변경 필요 — 후속 슬라이스
4. **Verify** 방법 선택:
   - **HTML file**: TikTok이 발급한 파일을 도메인 루트에 두기 → Next.js라면 `public/` 디렉토리에 파일 두면 됨
   - **Meta tag**: `<head>` 안에 `<meta name="tiktok-developers-site-verification" content="...">` 추가
   - **DNS TXT**: 도메인 호스팅에서 TXT 레코드 추가
5. 배포 후 **Verify** 버튼 클릭 → 통과 시 상태 **Verified**

#### E. Scopes 활성화

1. 사이드바 → **App Information** → 하단 **Scopes** 섹션
2. 체크박스로 활성화:
   - `user.info.basic`
   - `video.upload`
   - `video.publish`
3. **Save**

#### F. Sandbox 모드 — 테스트 사용자 추가

1. 앱 상세 페이지 상단 토글 또는 사이드바 — **Sandbox** 모드 (검수 전 기본값)
2. 사이드바 → **Manage** → **Target users** (또는 Sandbox 화면 안의 "Add testers")
3. **+ Add** → 테스트할 TikTok username (`@` 빼고) 입력 → **Add** (본인 포함 **최대 10명**)
4. 추가된 사용자에게 TikTok 알림 — 사용자가 수락해야 OAuth 가능
5. Sandbox에선 모든 publish가 **SELF_ONLY 강제** — [lib/platforms/tiktok.ts](../lib/platforms/tiktok.ts)가 이미 SELF_ONLY로 보내고 있음. 영상은 본인 피드에만 비공개로 올라감 → 검수 데모로 "공개 게시"를 보여주는 건 Sandbox에서 불가

#### G. Production Audit 신청

1. 앱 상세 페이지 상단 우측 **Submit for review** 버튼 (또는 사이드바 **App review**)
2. 체크리스트 확인:
   - ✅ URL Properties 모두 Verified
   - ✅ Privacy Policy URL 입력
   - ✅ Terms of Service URL 입력
   - ✅ Scopes 모두 사용 정당화 작성
   - ✅ Demo video URL 입력
3. 각 scope 옆 텍스트 박스에 [3.3 견본](#33-신청서-영문-견본) 복붙
4. **Test instructions** 필드 — Meta와 유사하게 step-by-step + test account 명시
5. **Submit**
6. 결과는 콘솔 상단 알림 + 이메일. 보통 2~3주. 거절 시 사유 + 재신청 가능

### 3.2 Sandbox 모드 (검수 전 테스트)

Audit 통과 전에는 **Target Users**에 추가한 사용자(본인 포함 최대 10명)만 OAuth 가능. 그 안에서 publish 흐름 검증 가능.

- App 페이지 → Manage → **Target Users** → TikTok 사용자명 추가
- 추가된 사용자의 게시는 **항상 privacy_level=SELF_ONLY**로 강제됨 ([lib/platforms/tiktok.ts](../lib/platforms/tiktok.ts)에서 이미 SELF_ONLY로 설정 — Audit 통과 후 PUBLIC_TO_EVERYONE 옵션 노출하는 별도 슬라이스 필요)

### 3.3 신청서 영문 견본

**`video.publish` — Justification**

> MCB lets creators broadcast a single short-form video to multiple platforms (YouTube Shorts, Instagram Reels, TikTok) from a unified interface. With the `video.publish` scope, the user can post a video they own directly to their TikTok account, using AI-assisted captions and hashtags that the user reviews and approves before the publish action. We use the PULL_FROM_URL source method: the video is hosted on our authenticated storage and TikTok fetches it during publish. We never publish content on behalf of the user without an explicit click in our publish workflow.

**`video.upload` — Justification**

> Used when the user chooses to send the prepared video to their TikTok inbox as a draft rather than publishing immediately. The user reviews the draft inside the TikTok app before deciding to post. Same explicit user-triggered flow inside MCB. (※ `video.publish`의 prerequisite은 아님 — 둘은 독립적인 엔드포인트. inbox 흐름을 안 쓸 거면 이 scope 자체를 제거하고 신청에서 빼는 게 거절 위험을 줄임)

**`user.info.basic` — Justification**

> Used only during account connection to display the connected username and avatar inside MCB so the user can confirm which TikTok account is linked. We do not read followers, following, or any other social graph data.

### 3.4 데모 영상 — TikTok 가이드

TikTok 검토는 Google보다 데모 영상 비중이 크다. **8분 이상 권장** (Google 2~5분과 다름) — 흐름을 충분히 보여줘야 통과율이 오름.

필수 장면:
1. https://mcb.cuma.co.kr 로그인
2. 계정 → TikTok 연동 → **TikTok OAuth 동의 화면** (권한 목록 — video.upload, video.publish, user.info.basic — 명확히 노출)
3. 콘텐츠 업로드 → AI 캡션 검토/수정 → **사용자가 "게시" 클릭**
4. **TikTok 앱/웹에서 실제로 게시된 결과**를 직접 보여줌 (mockup 절대 안 됨)
5. (권장) 계정 disconnect 흐름

### 3.5 흔한 거절 사유

- `video_url` 호스트 verify 실패 → URL Properties 통과 못 함
- 데모 영상이 mockup 또는 너무 짧음 (8분 미만은 거절률 높아짐)
- 데모 영상에 SELF_ONLY가 아닌 모드를 보여줌 (Sandbox에선 불가능한데도 시연 시도)
- Privacy Policy에 "TikTok에서 받은 데이터를 어떻게 다루는지" **별도 조항** 누락 (다른 플랫폼과 묶어서 한 줄로 처리하면 거절)
- 앱 이름에 "TikTok" / "TT" 단어 포함 → 정책 위반 자동 거절
- 신청자 계정 자체가 TikTok Community Guidelines 위반 이력 있음
- `video.upload`를 신청하면서 draft 흐름이 실제 앱에 구현 안 됨 → "쓰지도 않는 scope 요청"으로 거절. 안 쓸 거면 scope에서 빼고 신청

## 4. 검수 통과 후 코드/env 작업

각 플랫폼이 통과되면 코드/설정 측에서 다음을 바꿔야 함.

### 4.1 YouTube

- Google Cloud Console → OAuth consent screen → **Publishing status: Production** 클릭
- 코드 변경 없음. 다만 사용자 100명 제한이 해제됨.

### 4.2 Instagram

- Meta for Developers → App settings → **App Mode: Live** 전환
- 코드 변경 없음. 다만 모든 Instagram 비즈니스 계정 사용자가 연동 가능해짐.

### 4.3 TikTok

- Audit 통과 → Production mode 활성화 자동
- **코드 변경 필요**: `lib/platforms/tiktok.ts`의 `privacy_level: "SELF_ONLY"` → 사용자 선택 가능하게 PublishContext에 `tiktokPrivacy` 같은 필드 추가하거나, AI 캡션 옆 UI에서 선택. 후속 슬라이스.

## 5. 일정/난이도 요약

| 플랫폼 | 예상 소요 | 난이도 | 가장 큰 장애물 |
|---|---|---|---|
| YouTube | 4~6주 (CASA 면제 시) | ⭐⭐⭐⭐ | Restricted scope 정당화 + 데모 영상 + Search Console 도메인 |
| Instagram | 3~4주 | ⭐⭐⭐ | Business Verification (사업자 서류) |
| TikTok | 2~3주 | ⭐⭐⭐ | URL Properties verify (Storage 호스트 → 자체 도메인 proxy 필요할 수도) |

## 6. 권장 진행 순서

1. **즉시 시작 가능**: Google Search Console 도메인 등록, Vercel에 Privacy/Terms/Data Deletion 정적 페이지 추가 (1~2일)
2. **사업자 등록 + Meta Business Verification 신청** (가장 오래 걸리는 단계라 먼저 시작)
3. **데모 영상 한 번 녹화** (세 플랫폼 공통 사용)
4. **세 플랫폼 검수 동시 신청**
5. **검수 대기 동안 코드 작업**: Privacy/Terms 페이지 디자인, TikTok proxy 엔드포인트, 캐러셀 미디어 지원 등 후속 슬라이스

## 7. 관련 파일

- 어댑터 코드: [lib/platforms/youtube.ts](../lib/platforms/youtube.ts), [instagram.ts](../lib/platforms/instagram.ts), [tiktok.ts](../lib/platforms/tiktok.ts)
- 사용 스코프 정의: 각 어댑터 파일 상단 `SCOPES` 상수
- 토큰 암호화: [lib/crypto.ts](../lib/crypto.ts) (AES-256-CBC, hex iv:cipher 포맷)
- 계정 disconnect 흐름: [app/(dashboard)/accounts/actions.ts](../app/(dashboard)/accounts/actions.ts)
- Phase 4b 워커: [docs/phase-4b.md](./phase-4b.md)
