interface EvidenceBoard {
  hook: { spoken: string; answer: string; evidence_scenes: number[] };
  photos: { id: string; kind: string; usable: boolean }[];
  scenes: { source: string; source_id: string; say: string }[];
}

/** 병 사진만 있는 영상에서 제형 시연을 약속했던 회귀 사례를 막는다. 설명과 실물 증거는 구분한다. */
export function hookEvidenceProblems(board: EvidenceBoard, archive: { id: string; what: string }[]): string[] {
  const out: string[] = [];
  if (!board.hook.answer.trim()) out.push("후킹이 약속한 질문에 대한 구체적인 답이 없다");
  const evidence = board.hook.evidence_scenes;
  if (!evidence.length || evidence.some((i) => !Number.isInteger(i) || i <= 0 || i >= board.scenes.length)) out.push("후킹의 답을 보여 주는 본문 장면 번호가 올바르지 않다");
  const asksTexture = /(?:제형|거품|텍스처|질감|발림성).{0,12}(?:보|확인|비교)|(?:보|확인).{0,8}(?:제형|거품|텍스처)/.test(board.hook.spoken);
  if (asksTexture) {
    const visualProof = evidence.some((i) => {
      const s = board.scenes[i];
      if (!s) return false;
      if (s.source === "photo") return board.photos.some((p) => p.id === s.source_id && p.usable && ["texture", "use"].includes(p.kind));
      return s.source === "archive" && archive.some((a) => a.id === s.source_id && /제형|거품|발림|바르|텍스처/.test(a.what));
    });
    if (!visualProof) out.push("제형을 보라고 약속했지만 실제 제형/사용 컷이 없다. 용기 사진이나 설명 도식으로 제형 시연을 대신하지 말고 후킹을 바꾼다");
  }
  return out;
}
