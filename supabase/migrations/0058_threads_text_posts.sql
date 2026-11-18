-- 스레드를 콘텐츠 생성의 한 플랫폼으로 · 글만 올리기 (2026-11-17)
--
-- 0056에서는 스레드를 인스타에 딸린 "스레드에도 올리기"로만 올렸다. 이제 업로드 마법사 1단계에서
-- 다른 플랫폼처럼 스레드 계정을 고르고, 캡션도 스레드용(ai_captions.threads)을 따로 쓴다.
-- 스레드만 고르면 사진 · 영상 없이 글만 올릴 수 있다 — 그 콘텐츠는 media_type = TEXT, media_urls = '{}'.
-- 발행 job의 post_type도 TEXT(스레드 글 게시물).

alter type public.media_type add value if not exists 'TEXT';
alter type public.post_type add value if not exists 'TEXT';

-- 새 enum 값은 같은 트랜잭션에서 쓸 수 없어 media_type을 text로 바꿔 비교한다.
alter table public.contents drop constraint if exists media_urls_count;
alter table public.contents add constraint media_urls_count check (
  case media_type::text
    when 'VIDEO' then array_length(media_urls, 1) = 1
    when 'IMAGE' then array_length(media_urls, 1) between 1 and 10
    when 'TEXT' then coalesce(array_length(media_urls, 1), 0) = 0
  end
);
