-- 스레드(Threads) 연결 · 발행 (2026-11-11)
--
-- 인스타 발행 API에는 "스레드에도 공유" 옵션이 없어서, 스레드는 따로 OAuth로 연결하고
-- graph.threads.net으로 직접 올린다. 연결한 스레드 계정은 다른 플랫폼처럼
-- social_accounts 한 줄(platform = THREADS)이고, 발행도 publish_jobs 한 줄이다.
--
-- 인스타 계정과의 짝은 따로 저장하지 않는다. 스레드 프로필은 인스타 프로필에서 만들어져
-- 사용자 이름이 같으니, 업로드 마법사가 이름으로 짝을 찾아 "스레드에도 올리기"를 보여 준다.

alter type public.social_platform add value if not exists 'THREADS';
