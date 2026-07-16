import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "개인정보처리방침 | MCB",
  description:
    "MCB(Multi-Content Bomber)가 수집·이용·보관하는 개인정보 항목과 사용자의 권리를 안내합니다.",
};

const LAST_UPDATED = "2026-05-13";
const CONTACT_EMAIL = "java0219@naver.com";

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-10 border-b pb-6">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          개인정보처리방침
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          마지막 업데이트: {LAST_UPDATED}
        </p>
        <p className="mt-4 text-sm leading-relaxed">
          MCB(Multi-Content Bomber, 이하 &ldquo;서비스&rdquo;)는 사용자의 동의
          하에 콘텐츠를 YouTube, Instagram, TikTok 등 외부 SNS 플랫폼에 배포하는
          기능을 제공합니다. 본 처리방침은 서비스가 수집하는 개인정보의 항목,
          이용 목적, 보관 기간, 사용자의 권리, 안전성 확보 조치를 안내합니다.
        </p>
      </header>

      <Section title="1. 수집하는 개인정보 항목">
        <p>서비스는 다음 항목을 수집·처리합니다.</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>
            <strong>계정 정보</strong>: 이메일, 비밀번호 해시, 표시 이름, 조직
            정보(이름, 역할)
          </li>
          <li>
            <strong>SNS 연동 정보</strong>: 사용자가 명시적으로 동의한 SNS(YouTube,
            Instagram, TikTok)의 OAuth 액세스 토큰·리프레시 토큰, 플랫폼 계정 ID,
            표시 이름, 프로필 이미지 URL
          </li>
          <li>
            <strong>업로드 콘텐츠</strong>: 사용자가 업로드한 이미지·동영상 파일,
            AI가 생성하고 사용자가 검토한 캡션, 게시 메타데이터(제목, 해시태그
            등)
          </li>
          <li>
            <strong>게시 이력</strong>: 게시 요청 시각, 대상 플랫폼, 상태(성공/실패),
            결과 URL
          </li>
          <li>
            <strong>기술 정보</strong>: 세션 쿠키(인증용), 접근 IP·User-Agent
            (보안 및 디버깅 목적의 일시 로그)
          </li>
        </ul>
      </Section>

      <Section title="2. 개인정보의 이용 목적">
        <ul className="list-disc space-y-2 pl-6">
          <li>회원 가입·로그인 및 계정 관리</li>
          <li>
            사용자가 명시적으로 트리거한 콘텐츠 게시 작업의 처리(SNS API 호출)
          </li>
          <li>AI 캡션 생성을 위해 업로드 이미지를 OpenAI에 전달(아래 제3자 제공 참조)</li>
          <li>서비스 이용 내역에 대한 통계 분석(개인 식별 정보를 제외한 집계)</li>
          <li>서비스 안정성 유지(오류 추적, 부정 사용 방지)</li>
        </ul>
      </Section>

      <Section title="3. 보관 및 안전성 확보 조치">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            모든 데이터는 Supabase(미국·EU 리전, AES-256 암호화 스토리지) 인프라에
            저장됩니다.
          </li>
          <li>
            <strong>SNS 토큰은 추가로 애플리케이션 레이어에서 AES-256-CBC로
            암호화</strong>되어 저장되며, 복호화 키는 서버 환경변수로만 관리됩니다.
            토큰 컬럼은 RLS(Row Level Security) 및 컬럼 권한 revoke로 service
            role 외 접근이 차단됩니다.
          </li>
          <li>
            모든 외부 통신은 HTTPS/TLS 1.2 이상으로 전송됩니다.
          </li>
          <li>
            세션은 Supabase Auth가 발급하는 짧은 만료 시간의 JWT로 관리되며,
            httpOnly·Secure·SameSite 쿠키로 전송됩니다.
          </li>
        </ul>
      </Section>

      <Section title="4. 제3자 제공·처리 위탁">
        <p>서비스는 다음 제3자에게 데이터를 전송합니다.</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>
            <strong>OpenAI</strong>(미국, GPT-4o API): 캡션 생성을 위해 사용자가
            업로드한 이미지를 일시 전송. 결과 캡션만 서비스로 반환되며, OpenAI는
            API 입력을 모델 학습에 사용하지 않음(OpenAI Data Usage Policy 적용).
          </li>
          <li>
            <strong>YouTube / Instagram / TikTok</strong>: 사용자가 트리거한 게시
            작업에 한해, 사용자의 OAuth 토큰으로 해당 플랫폼의 공식 API에 콘텐츠를
            업로드. 사용자의 SNS 계정으로만 게시되며 제3자에게 노출되지 않음.
          </li>
          <li>
            <strong>Vercel</strong>(미국, 호스팅), <strong>Railway</strong>(미국,
            백그라운드 워커), <strong>Upstash Redis</strong>(미국, 큐 브로커):
            서비스 인프라. 사용자 콘텐츠를 일시 처리하나 저장하지 않음.
          </li>
        </ul>
        <p className="mt-3">
          위 제3자 외에는 사용자의 사전 동의 없이 개인정보를 제공하지 않습니다.
        </p>
      </Section>

      <Section title="5. 보관 기간 및 파기">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>SNS 연동 토큰</strong>: 사용자가 연동 해제(/accounts 페이지의
            disconnect)하면 즉시 데이터베이스에서 삭제됩니다.
          </li>
          <li>
            <strong>업로드 콘텐츠·캡션</strong>: 사용자가 삭제할 때까지 보관
            (배포 관리 또는 보관함). 삭제 요청 시 Storage 및 데이터베이스에서
            즉시 제거.
          </li>
          <li>
            <strong>계정 정보</strong>: 회원 탈퇴 요청 시 30일 이내 모든 개인정보가
            영구 삭제됩니다(법령상 보관 의무 항목 제외).
          </li>
          <li>
            <strong>로그</strong>: 보안·장애 대응 목적의 일시 로그는 최대 30일
            보관 후 자동 파기.
          </li>
        </ul>
      </Section>

      <Section title="6. 사용자의 권리">
        <ul className="list-disc space-y-2 pl-6">
          <li>본인의 개인정보 열람·정정·삭제·처리정지를 요청할 권리</li>
          <li>SNS 연동을 언제든지 해제할 권리(/accounts 페이지)</li>
          <li>업로드 콘텐츠를 언제든지 삭제할 권리(배포 관리 · 보관함)</li>
          <li>
            계정 자체의 삭제는{" "}
            <Link href="/data-deletion" className="underline">
              데이터 삭제 안내 페이지
            </Link>{" "}
            의 절차를 따르거나 아래 연락처로 요청
          </li>
        </ul>
      </Section>

      <Section title="7. 쿠키">
        <p>
          서비스는 인증 세션 유지를 위해 Supabase Auth가 발급하는 세션 쿠키를
          사용합니다. 광고·트래킹 목적의 제3자 쿠키는 사용하지 않습니다. 브라우저
          설정에서 쿠키를 차단하면 로그인이 불가능합니다.
        </p>
      </Section>

      <Section title="8. 변경 사항">
        <p>
          본 처리방침이 변경되는 경우 서비스 내 공지 또는 등록된 이메일을 통해
          최소 7일 전에 안내합니다. 중대한 변경(수집 항목 추가, 제3자 제공 확대
          등)은 최소 30일 전에 안내하며 필요한 경우 재동의를 받습니다.
        </p>
      </Section>

      <Section title="9. 연락처">
        <p>
          개인정보 처리와 관련된 문의·요청은 아래로 보내주세요.
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
