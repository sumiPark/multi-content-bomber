-- 0049_private_tools_bucket.sql — 워커 전용 비공개 저장 공간 (2026-11-05)
--
-- 저장소가 공개라 구매한 유료 도구(자막 모션 스킬)를 넣을 수 없어 여기 둔다.
-- 공개 안 함, 정책 없음: service_role(워커)만 읽고 쓴다.

insert into storage.buckets (id, name, public)
values ('private-tools', 'private-tools', false)
on conflict (id) do nothing;
