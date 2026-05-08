# [기획서] AI 멀티 채널 콘텐츠 배포 시스템 (MCB)

---

# 1. 프로젝트 개요

- **서비스 명 :** Multi-Content Bomber (MCB)
- **목표 :** 하나의 영상 또는 **여러 장의 이미지**를 업로드하여 유튜브, 인스타그램, 틱톡에 플랫폼별 최적화된 상태로 일괄 배포하는 SaaS
- **핵심 가치 :** 미디어 포맷에 상관없이 한 번의 업로드로 모든 숏폼/이미지 채널을 장악하여 마케팅 효율 극대화

## 2. 사용자 역할 (User Roles)

- **관리자(Admin) :** 워크스페이스 생성
- **매니저(Manager) :** 다중 소셜 계정 연동(OAuth), 전체 게시 현황 모니터링
- **크리에이터(Staff) :** 미디어 업로드, AI 분석 실행, 캡션 수정 및 최종 배포

## 3. 핵심 기능 요구사항

### 3.1 소셜 계정 및 미디어 관리 (Multi-Media & Account)

- **미디어 지원**
    - **영상 :** 1개 (MP4, MOV / 9:16 최적화)
    - **이미지 :** 1~10개 (JPG, PNG, WEBP / 슬라이드 형태 지원)
- **계정 풀 공 유:** 조직 내 모든 직원이 연동된 계정 리스트를 공유하여 배포 타겟으로 선택 가능

### 3.2 AI 콘텐츠 최적화 (AI Vision Engine)

- **OpenAI GPT-4o 활용**
    - **영상 분석 :** 영상의 메타데이터, 제목, 그리고 첫 프레임(썸네일 가능성)을 분석하여 핵심 주제 파악
    - **이미지 분석(Vision) :** 다중 이미지(최대 10장) 간의 상관관계를 분석하여 하나의 완성된 **스토리텔링형 캡션** 생성
- **플랫폼별 특화 캡션**
    - **YouTube :** 검색 최적화(SEO) 제목 및 설명, 관련 해시태그
    - **Instagram :** 감성 문구, 이모지 활용, Carousel(슬라이드) 유도 멘트, 해시태그 뭉치
    - **TikTok :** 초반 3초 훅(Hook) 강조 문구, 트렌드 해시태그

### 3.3 스마트 배포 엔진 (Distribution)

- **일괄 배포 :** 매체 종류에 따라 플랫폼별 API 분기 처리 (예: 인스타는 Carousel, 틱톡은 Photo Mode)
- **스케줄링 :** 플랫폼별 통계 기반 최적 시간 추천 및 예약 업로드

---

## 4. 플랫폼별 API 연동 상세

| **플랫폼** | **매체 종류** | **연동 API 엔드포인트 / 방식** |
| --- | --- | --- |
| **YouTube** | **영상(Shorts)** | `youtube.videos.insert` (9:16 비율 및 #Shorts 태그 활용) |
|  | **이미지** | YouTube Community API (※ 공식 API 권한 획득 난이도 높음, 확인 필요) |
| **Instagram** | **영상(Reels)** | `/{ig-user-id}/media` (video_url) → `media_publish` |
|  | **이미지(단일)** | `/{ig-user-id}/media` (image_url) → `media_publish` |
|  | **이미지(Carousel)** | 각 이미지 `item_id` 생성 → `children` 배열로 부모 컨테이너 생성 → 게시 |
| **TikTok** | **영상** | `/video/upload/` (Direct Post API) |
|  | **이미지(Photo)** | `/content/publish/` (post_type: `PHOTO_MODE` 사용하여 이미지 배열 전송) |

---

## 5. 프로세스 워크플로우 (Workflow)

1. **미디어 업로드 :** 사용자가 영상 1개 또는 이미지 1~10개를 드래그 앤 드롭 (이미지의 경우 순서 변경 UI 제공)
2. **AI 비전 분석 :** OpenAI GPT-4o이 미디어를 분석하여 플랫폼별 캡션 3종 자동 생성
3. **계정 및 시간 선택 :** 배포할 계정들을 체크하고, '최적 시간' 혹은 '즉시' 배포 선택
4. **미디어 프로세싱 :** **Sharp**를 이용해 이미지 리사이징(4:5/9:16), **FFmpeg**을 이용해 영상 규격 검증
5. **배포 큐(Queue) 등록 :** BullMQ가 각 플랫폼 API를 호출하여 백그라운드에서 업로드 수행
6. **결과 알림:** 대시보드에 각 계정별 성공/실패 여부 실시간 업데이트

---

## 6. 기술 사양 (Technical Specs)

- **Frontend :** Next.js 15 (App Router), Tailwind CSS, shadcn/ui, **framer-motion** (이미지 순서 변경용)
- **Backend :** Supabase Auth & Database, Next.js Server Actions
- **Image/Video Processing :** **Sharp** (이미지 리사이징/압축), **FFmpeg** (영상 검증)
- **AI :** OpenAI GPT-4o
- **Infrastructure:** Supabase Storage, Upstash Redis + BullMQ

---

## 7. 데이터베이스 구조 (DB Schema)

- **organizations / profiles :** 조직 및 유저 정보
- **social_accounts :** 플랫폼 토큰 및 계정 메타데이터
- **contents**
    - `media_type`: 'VIDEO' | 'IMAGE'
    - `media_urls`: TEXT[] (배열로 저장하여 다중 이미지 대응)
    - `metadata`: JSONB (이미지 해상도, 영상 길이 등)
- **publish_jobs :** 개별 플랫폼 전송 기록. `post_type`('REELS', 'FEED', 'CAROUSEL', 'PHOTO_MODE' 등) 필드 추가

---

## 8. 제약 사항 및 예외 처리

- **Sharp 이미지 처리 :** 인스타그램 4:5 비율 미준수 시 자동 패딩(Padding) 추가 또는 크롭 기능
- **Retry 로직 :** API 실패 시 Redis 가 3회 자동 재시도 후 실패 리포트
- **AI Labeling :** 각 플랫폼 API의 `is_ai_generated` 플래그를 True로 설정하는 옵션 포함

###