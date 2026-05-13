import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "서비스 약관 | MCB",
  description:
    "MCB(Multi-Content Bomber) 서비스 이용 약관 — 서비스 정의, 이용 자격, 사용자 책임, 면책 사항을 안내합니다.",
};

const LAST_UPDATED = "2026-05-13";
const CONTACT_EMAIL = "java0219@naver.com";

export default function TermsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-10 border-b pb-6">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          서비스 약관
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          마지막 업데이트: {LAST_UPDATED}
        </p>
        <p className="mt-4 text-sm leading-relaxed">
          본 약관은 MCB(Multi-Content Bomber, 이하 &ldquo;서비스&rdquo;)의 이용
          조건과 운영자(이하 &ldquo;회사&rdquo;)와 사용자(이하 &ldquo;회원&rdquo;)의
          권리·의무·책임을 규정합니다. 회원은 서비스에 가입함으로써 본 약관에
          동의한 것으로 간주됩니다.
        </p>
      </header>

      <Section title="1. 서비스의 정의">
        <p>
          서비스는 사용자가 한 번의 업로드로 본인의 콘텐츠(이미지·동영상)를
          YouTube, Instagram, TikTok 등 다중 SNS 플랫폼에 게시할 수 있도록 돕는
          AI 보조 도구입니다. 주요 기능은 다음과 같습니다.
        </p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>SNS 계정의 OAuth 연동(사용자 명시적 동의 기반)</li>
          <li>AI(OpenAI GPT-4o)를 통한 플랫폼별 캡션·해시태그 초안 생성</li>
          <li>사용자가 검토·수정한 콘텐츠의 다중 플랫폼 동시 또는 예약 게시</li>
          <li>게시 결과 추적 및 관리</li>
        </ul>
      </Section>

      <Section title="2. 이용 자격">
        <ul className="list-disc space-y-2 pl-6">
          <li>회원은 만 14세 이상이어야 합니다.</li>
          <li>
            회원은 연결하려는 각 SNS 플랫폼(YouTube/Instagram/TikTok)의 이용 약관
            및 커뮤니티 가이드라인을 준수할 수 있는 본인의 계정만 연결해야
            합니다.
          </li>
          <li>
            회원은 정확한 정보를 제공해야 하며, 허위 정보로 가입한 경우 서비스
            이용이 제한될 수 있습니다.
          </li>
        </ul>
      </Section>

      <Section title="3. 사용자의 책임">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>콘텐츠 소유권</strong>: 업로드한 모든 콘텐츠의 저작권·초상권·
            상표권 등 모든 권리에 대한 책임은 사용자에게 있습니다. 제3자의 권리를
            침해하는 콘텐츠는 업로드·게시할 수 없습니다.
          </li>
          <li>
            <strong>AI 캡션 검토</strong>: 서비스가 AI로 생성한 캡션·해시태그는
            초안이며, 최종 게시 전 사용자가 검토하고 수정할 책임이 있습니다.
            AI가 생성한 부정확한 정보, 부적절한 표현, 사실과 다른 내용 등으로
            발생하는 모든 결과의 책임은 게시한 사용자에게 있습니다.
          </li>
          <li>
            <strong>플랫폼 정책 준수</strong>: 게시되는 콘텐츠는 각 대상 플랫폼의
            정책(스팸·반복 게시 제한, 광고 표시, 미성년자 보호 등)을 준수해야
            합니다.
          </li>
          <li>
            <strong>계정 보안</strong>: 비밀번호와 SNS 연동을 안전하게 관리할
            책임은 사용자에게 있습니다.
          </li>
        </ul>
      </Section>

      <Section title="4. 금지 행위">
        <p>회원은 다음 행위를 해서는 안 됩니다.</p>
        <ul className="mt-3 list-disc space-y-2 pl-6">
          <li>
            제3자의 저작권·상표권·초상권 등 권리를 침해하는 콘텐츠 업로드·게시
          </li>
          <li>
            플랫폼 알고리즘을 우회하거나 어뷰징할 목적의 대량 자동 게시
          </li>
          <li>스팸, 사기, 피싱, 악성 코드 유포 등 불법 행위</li>
          <li>타인의 SNS 계정을 무단으로 연결하거나 그 계정으로 게시</li>
          <li>
            서비스의 정상 운영을 방해하는 행위(API 무단 호출, 리버스 엔지니어링
            등)
          </li>
          <li>
            본 약관 또는 관련 법령을 위반하는 모든 행위
          </li>
        </ul>
        <p className="mt-3">
          위 행위 적발 시 사전 통지 없이 서비스 이용을 제한하거나 계정을 정지할
          수 있습니다.
        </p>
      </Section>

      <Section title="5. 서비스 변경·중단">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            회사는 서비스의 기능을 개선·변경할 수 있으며, 중대한 변경은 사전에
            서비스 내 또는 이메일로 공지합니다.
          </li>
          <li>
            기술적 결함, 정기 점검, 외부 API(YouTube/Meta/TikTok/OpenAI) 장애
            등으로 서비스가 일시 중단될 수 있으며, 회사는 이로 인한 직접·간접
            손해에 대해 책임지지 않습니다.
          </li>
          <li>
            회사는 합리적 사유로 서비스 전체를 종료할 수 있으며, 종료 시 최소 30일
            전에 공지하고 사용자의 데이터 추출 방법을 안내합니다.
          </li>
        </ul>
      </Section>

      <Section title="6. 면책">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            회사는 사용자의 콘텐츠가 각 SNS 플랫폼에서 삭제되거나 노출 제한을
            받는 경우, 또는 플랫폼의 정책 변경으로 발생하는 결과에 대해 책임지지
            않습니다.
          </li>
          <li>
            회사는 외부 API(YouTube Data API, Meta Graph API, TikTok Content
            Posting API 등)의 변경·중단·요금 정책 변동에 대해 책임지지 않습니다.
          </li>
          <li>
            회사는 사용자가 본 약관을 위반하여 발생한 모든 손해에 대해 책임지지
            않으며, 회사가 손해를 입은 경우 사용자에게 배상을 청구할 수 있습니다.
          </li>
        </ul>
      </Section>

      <Section title="7. 개인정보 보호">
        <p>
          개인정보의 수집·이용·보관·파기·사용자 권리에 관한 사항은{" "}
          <Link href="/privacy" className="underline">
            개인정보처리방침
          </Link>
          을 따릅니다.
        </p>
      </Section>

      <Section title="8. 계정 삭제">
        <p>
          회원은 언제든지 계정 삭제를 요청할 수 있습니다. 자세한 절차는{" "}
          <Link href="/data-deletion" className="underline">
            데이터 삭제 안내
          </Link>
          를 참조하세요.
        </p>
      </Section>

      <Section title="9. 준거법 및 분쟁 해결">
        <p>
          본 약관은 대한민국 법령에 따라 해석·적용되며, 서비스 이용과 관련하여
          발생한 분쟁은 회사 소재지 관할 법원을 1심 전속 관할로 합니다.
        </p>
      </Section>

      <Section title="10. 약관의 변경">
        <p>
          본 약관이 변경되는 경우 서비스 내 공지 또는 등록된 이메일로 최소 7일
          전(중대한 변경은 30일 전)에 안내합니다. 변경 후 서비스를 계속 이용하면
          변경된 약관에 동의한 것으로 간주됩니다.
        </p>
      </Section>

      <Section title="11. 연락처">
        <ul className="list-disc space-y-1 pl-6">
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
