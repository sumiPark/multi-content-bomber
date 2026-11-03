// 고른 사진 · 영상의 미리보기 주소(blob URL) — 파일 하나에 주소 하나.
// 드롭존이 단계를 오가며 다시 그려지거나(React 개발 모드는 일부러 두 번 그린다) 해도 같은 주소를 다시 쓴다.
// 예전처럼 그려질 때마다 만들고 사라질 때 없애면, 다시 그려진 화면이 이미 없앤 주소를 가리켜 미리보기가 깨졌다(2026-11-04).
// 사람이 그 파일을 빼거나 모두 지울 때만 없앤다(나머지는 페이지를 떠나면 브라우저가 정리한다).

const cache = new WeakMap<Blob, string>();

export function previewUrlOf(file: Blob): string {
  let url = cache.get(file);
  if (!url) {
    url = URL.createObjectURL(file);
    cache.set(file, url);
  }
  return url;
}

export function releasePreviewUrl(file: Blob): void {
  const url = cache.get(file);
  if (!url) return;
  URL.revokeObjectURL(url);
  cache.delete(file);
}
