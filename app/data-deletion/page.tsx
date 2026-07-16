import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "데이터 삭제 안내 / Data Deletion Instructions | MCB",
  description:
    "Data Deletion Instructions for Multi-Content Bomber (MCB). Learn how to delete your user data, disconnect SNS accounts, and request full account deletion. MCB(Multi-Content Bomber)에 저장된 사용자 데이터를 삭제하는 방법을 안내합니다.",
};

const LAST_UPDATED = "2026-05-13";
const CONTACT_EMAIL = "java0219@naver.com";

export default function DataDeletionPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-10 border-b pb-6">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          데이터 삭제 안내
        </h1>
        <p className="mt-1 text-base font-medium text-muted-foreground">
          Data Deletion Instructions for Multi-Content Bomber (MCB)
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          마지막 업데이트 / Last updated: {LAST_UPDATED}
        </p>
        <p className="mt-4 text-sm leading-relaxed">
          MCB(Multi-Content Bomber)는 사용자가 자신의 데이터를 언제든지 삭제할 수
          있도록 세 가지 경로를 제공합니다. 항목별로 필요한 만큼 부분 삭제할 수
          있고, 전체 계정 삭제도 가능합니다.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          MCB provides three ways for users to request data deletion at any
          time: disconnecting individual SNS accounts (immediately deletes
          stored OAuth tokens), deleting uploaded content from the library, or
          requesting full account deletion via email. Detailed steps are
          described in each section below.
        </p>
      </header>

      <Section title="1. SNS 연동만 해제하기 (가장 빠른 방법)">
        <p>
          특정 SNS(YouTube, Instagram, TikTok) 계정만 끊고 싶다면 서비스 내에서
          직접 해제할 수 있습니다.
        </p>
        <ol className="mt-3 list-decimal space-y-2 pl-6">
          <li>로그인 후 좌측 사이드바의 <strong>계정 연동</strong> 메뉴 클릭</li>
          <li>해제하려는 SNS 계정 카드의 <strong>연동 해제</strong> 버튼 클릭</li>
          <li>확인 다이얼로그에서 한 번 더 확인</li>
        </ol>
        <p className="mt-3">
          <strong>처리 시점</strong>: 즉시. 해당 SNS의 OAuth 액세스 토큰·리프레시
          토큰이 데이터베이스에서 즉시 영구 삭제되며, 이후 그 SNS로의 게시는
          불가능해집니다. 이미 게시된 콘텐츠는 영향받지 않습니다.
        </p>
      </Section>

      <Section title="2. 업로드 콘텐츠 삭제하기">
        <p>업로드한 이미지·동영상과 AI 캡션을 항목별로 삭제할 수 있습니다.</p>
        <ol className="mt-3 list-decimal space-y-2 pl-6">
          <li>
            로그인 후 좌측 사이드바에서 <strong>배포 관리</strong>(발행한 콘텐츠)
            또는 <strong>보관함</strong>(발행하지 않은 콘텐츠) 메뉴 클릭
          </li>
          <li>
            삭제하려는 콘텐츠 선택 — 배포 관리에서는 항목을 클릭해 상세를 연 뒤{" "}
            <strong>콘텐츠 삭제</strong>, 보관함에서는 항목의{" "}
            <strong>삭제</strong> 옵션 선택
          </li>
          <li>확인 후 삭제</li>
        </ol>
        <p className="mt-3">
          <strong>처리 시점</strong>: 즉시. 미디어 파일(Supabase Storage), AI 캡션,
          게시 메타데이터가 즉시 제거됩니다. 이미 외부 SNS에 게시된 결과물은 각
          SNS 플랫폼에서 별도로 삭제해야 합니다.
        </p>
      </Section>

      <Section title="3. 전체 계정 삭제 요청하기">
        <p>
          MCB 서비스 자체에서 탈퇴하고 모든 데이터를 영구 삭제하려면 아래
          이메일로 요청해주세요. (현재 셀프 서비스 탈퇴 UI는 준비 중이며, 그동안은
          이메일 요청으로 처리합니다.)
        </p>
        <div className="mt-4 rounded-md border border-border bg-muted/30 p-4 text-sm">
          <p>
            <strong>받는 사람</strong>: {CONTACT_EMAIL}
          </p>
          <p className="mt-2">
            <strong>제목</strong>: [MCB] 계정 삭제 요청
          </p>
          <p className="mt-2">
            <strong>본문 양식</strong>:
          </p>
          <pre className="mt-2 whitespace-pre-wrap rounded bg-background p-3 text-xs">
{`계정 삭제를 요청합니다.

- 가입 이메일: <가입 시 사용한 이메일>
- 요청 사유 (선택): <자유 기재>

본인이 직접 요청한 것임을 확인합니다.`}
          </pre>
        </div>
        <p className="mt-3">
          <strong>처리 시점</strong>: 본인 확인 후 영업일 기준 7일 이내. 처리
          내역은 요청 이메일로 회신합니다.
        </p>
      </Section>

      <Section title="4. 무엇이 삭제되나요?">
        <p>전체 계정 삭제 시 다음 항목이 모두 영구 제거됩니다.</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>계정 정보(이메일, 비밀번호 해시, 표시 이름)</li>
          <li>
            모든 SNS 연동 정보(OAuth 토큰, 플랫폼 계정 ID, 표시 이름, 프로필 이미지
            URL)
          </li>
          <li>업로드한 모든 미디어 파일(Supabase Storage)</li>
          <li>모든 AI 생성 캡션 및 메타데이터</li>
          <li>모든 게시 이력 및 큐 작업</li>
          <li>조직(Organization)에 본인만 속해 있던 경우 조직 자체도 삭제</li>
        </ul>
      </Section>

      <Section title="5. 백업 보존 기간">
        <p>
          데이터 무결성과 장애 복구 목적의 시스템 백업에 사용자 데이터가 일시
          포함될 수 있으며, 백업은 <strong>최대 30일</strong> 후 자동으로
          순환·폐기됩니다. 그 기간 동안 백업에서 데이터를 복구하는 일은
          데이터베이스 장애 복구 외에는 발생하지 않습니다.
        </p>
      </Section>

      <Section title="6. SNS 플랫폼 측 데이터">
        <p>
          MCB를 통해 게시된 콘텐츠 자체는 사용자의 SNS 계정 소유이며, 각 플랫폼
          정책에 따릅니다. MCB에서 콘텐츠를 삭제해도 YouTube/Instagram/TikTok에
          이미 게시된 결과물은 자동으로 삭제되지 않습니다. 각 플랫폼에서 직접
          삭제해야 합니다.
        </p>
        <p className="mt-3">
          또한 MCB와의 SNS 연동을 해제하는 것과는 별개로, 각 SNS 플랫폼의 설정
          페이지에서 MCB 앱의 권한을 직접 회수할 수도 있습니다.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-6">
          <li>
            <strong>Google/YouTube</strong>:{" "}
            <a
              href="https://myaccount.google.com/permissions"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              내 Google 계정 → 보안 → 타사 액세스
            </a>
          </li>
          <li>
            <strong>Instagram/Meta</strong>: Instagram 앱 → 설정 → 보안 → 앱 및
            웹사이트
          </li>
          <li>
            <strong>TikTok</strong>: TikTok 앱 → 설정 → 보안 → 권한 부여된 앱
          </li>
        </ul>
      </Section>

      <Section title="7. 문의">
        <p>
          데이터 삭제와 관련된 질문이나 처리 상태 확인은 아래로 연락주세요.
        </p>
        <ul className="mt-3 list-disc space-y-1 pl-6">
          <li>이메일: {CONTACT_EMAIL}</li>
        </ul>
      </Section>

      <footer className="mt-12 border-t pt-6 text-sm text-muted-foreground">
        <Link href="/" className="underline">
          홈으로 돌아가기
        </Link>
      </footer>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8 text-sm leading-relaxed">
      <h2 className="mb-3 text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}
