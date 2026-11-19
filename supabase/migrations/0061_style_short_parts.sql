-- 0061_style_short_parts.sql — 스타일 쇼츠 편집용 파일 묶음 (2026-11-19 사용자 결정)
--
-- 완성본을 캡컷 같은 편집 앱에서 다시 고칠 수 있게, 버전마다 편집용 파일 묶음(zip)을 함께 저장한다:
-- 자막 없는 영상 · 자막만 그린 영상(투명 배경 · 크로마 키용) · 자막 글(srt) · 음성 · 배경음악 · 효과음.
-- media 버킷은 zip을 받지 않으므로(0005) 넓히지 않고 비공개 버킷 edit-parts를 따로 만든다.
-- 올리기 · 받기 링크는 서버(service_role)만 하므로 storage 정책을 두지 않는다(authenticated는 직접 읽지 못한다).
-- 기존 테이블에는 열 하나만 더한다. 예전 버전은 null(묶음 없음).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('edit-parts', 'edit-parts', false, 1073741824, array['application/zip'])
on conflict (id) do nothing;

alter table public.style_short_versions add column parts_path text;

comment on column public.style_short_versions.parts_path is '편집용 파일 묶음 zip 경로(edit-parts 버킷). 없으면 null';
