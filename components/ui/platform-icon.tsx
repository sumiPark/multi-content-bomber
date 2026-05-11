import { cn } from "@/lib/utils";

type Platform = "YOUTUBE" | "INSTAGRAM" | "TIKTOK";

const LOGO_SRC: Record<Platform, string> = {
  YOUTUBE: "/logos/youtube.svg",
  INSTAGRAM: "/logos/instagram.svg",
  TIKTOK: "/logos/tiktok.svg",
};

const LABEL: Record<Platform, string> = {
  YOUTUBE: "YouTube",
  INSTAGRAM: "Instagram",
  TIKTOK: "TikTok",
};

interface PlatformIconProps {
  platform: Platform;
  /** 정사각형 컨테이너 한 변(px). YouTube는 가로형이라 양쪽 여백이 생긴다. */
  size?: number;
  className?: string;
}

// 정사각형 박스에 비율 유지로 가운데 정렬. 컬러 brand asset이라 별도 색상 적용 안 함.
export function PlatformIcon({
  platform,
  size = 20,
  className,
}: PlatformIconProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        className,
      )}
      style={{ width: size, height: size }}
      aria-label={LABEL[platform]}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={LOGO_SRC[platform]}
        alt=""
        className="max-h-full max-w-full object-contain"
        draggable={false}
      />
    </span>
  );
}
