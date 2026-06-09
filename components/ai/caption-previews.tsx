import {
  Bookmark,
  Heart,
  MessageCircle,
  Send,
  Share2,
} from "lucide-react";

interface BasePreviewProps {
  thumbnailUrl?: string;
}

function PhoneFrame({
  thumbnailUrl,
  children,
}: {
  thumbnailUrl?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative mx-auto aspect-[9/16] w-full max-w-[220px] overflow-hidden rounded-xl bg-zinc-900 text-white shadow-lg">
      {thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumbnailUrl}
          alt=""
          className="absolute inset-0 size-full object-cover opacity-90"
        />
      ) : (
        <div className="flex h-full items-center justify-center text-[10px] text-white/40">
          (미디어 미리보기)
        </div>
      )}
      {children}
    </div>
  );
}

function PreviewLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium text-muted-foreground">{children}</p>
  );
}

export function YoutubeShortsPreview({
  title,
  description,
  hashtags,
  thumbnailUrl,
}: BasePreviewProps & {
  title: string;
  description: string;
  hashtags: string[];
}) {
  return (
    <div className="space-y-2">
      <PreviewLabel>YouTube Shorts</PreviewLabel>
      <PhoneFrame thumbnailUrl={thumbnailUrl}>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 space-y-1 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3">
          <p className="text-[10px] font-medium opacity-90">@channel · 구독</p>
          <p className="line-clamp-2 whitespace-pre-line text-xs font-bold leading-tight">
            {title || "제목을 입력하세요"}
          </p>
          {description.trim() && (
            <p className="line-clamp-3 whitespace-pre-line text-[10px] text-white/80">
              {description}
            </p>
          )}
          {hashtags.length > 0 && (
            <p className="line-clamp-1 text-[10px] text-sky-300">
              {hashtags.slice(0, 5).join(" ")}
            </p>
          )}
        </div>
        <div className="pointer-events-none absolute bottom-20 right-2 flex flex-col items-center gap-3 text-white/90">
          <Heart className="size-4" />
          <MessageCircle className="size-4" />
          <Share2 className="size-4" />
        </div>
      </PhoneFrame>
    </div>
  );
}

export function InstagramPreview({
  caption,
  hashtags,
  thumbnailUrl,
}: BasePreviewProps & {
  caption: string;
  hashtags: string[];
}) {
  return (
    <div className="space-y-2">
      <PreviewLabel>Instagram Reels</PreviewLabel>
      <PhoneFrame thumbnailUrl={thumbnailUrl}>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 space-y-1 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3">
          <p className="text-[10px] font-medium">@username · 팔로우</p>
          <p className="line-clamp-4 whitespace-pre-line text-[10px]">
            {caption || "캡션을 입력하세요"}
          </p>
          {hashtags.length > 0 && (
            <p className="line-clamp-1 text-[10px] text-sky-300">
              {hashtags.slice(0, 5).join(" ")}
            </p>
          )}
        </div>
        <div className="pointer-events-none absolute bottom-20 right-2 flex flex-col items-center gap-3 text-white/90">
          <Heart className="size-4" />
          <MessageCircle className="size-4" />
          <Send className="size-4" />
          <Bookmark className="size-4" />
        </div>
      </PhoneFrame>
    </div>
  );
}

export function TiktokPreview({
  caption,
  thumbnailUrl,
}: BasePreviewProps & {
  caption: string;
}) {
  return (
    <div className="space-y-2">
      <PreviewLabel>TikTok</PreviewLabel>
      <PhoneFrame thumbnailUrl={thumbnailUrl}>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 space-y-1 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3">
          <p className="text-[10px] font-bold">@username</p>
          <p className="line-clamp-4 whitespace-pre-line text-[10px]">
            {caption || "본문을 입력하세요"}
          </p>
        </div>
        <div className="pointer-events-none absolute bottom-20 right-2 flex flex-col items-center gap-3 text-white/90">
          <Heart className="size-4" />
          <MessageCircle className="size-4" />
          <Bookmark className="size-4" />
          <Share2 className="size-4" />
        </div>
      </PhoneFrame>
    </div>
  );
}
