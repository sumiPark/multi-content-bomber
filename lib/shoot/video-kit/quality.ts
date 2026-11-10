// 완성본 검수의 결과와 재편집 기록. 검수 실패/누락을 통과로 취급하지 않는다.
export interface VideoIssue {
  kind: "caption" | "layout" | "crop" | "content" | "blank";
  severity: "blocking" | "minor";
  at: number;
  detail: string;
}

export interface VideoReview { issues: VideoIssue[] }
export interface QualityAttempt extends VideoReview { attempt: number; file: string; action: string }
export interface VideoQuality { passed: boolean; attempts: QualityAttempt[]; listening_review: "not_performed" }

/** 같은 음성/소재로 고칠 수 있는 글자 문제만 재편집한다. 소재/내용 문제는 발행을 막는다. */
export async function inspectAndRepairVideo(input: {
  file: string;
  review: (file: string) => Promise<VideoReview>;
  repair: (attempt: number, issues: VideoIssue[]) => Promise<string>;
  save: (quality: VideoQuality) => void;
  maxRepairs?: number;
}): Promise<{ file: string; quality: VideoQuality }> {
  let file = input.file;
  const quality: VideoQuality = { passed: false, attempts: [], listening_review: "not_performed" };
  const max = input.maxRepairs ?? 2;
  for (let attempt = 0; attempt <= max; attempt++) {
    // API 오류나 해석 실패는 예외로 전파한다. 빈 결과로 바꾸지 않는다.
    const review = await input.review(file);
    const blocking = review.issues.filter((i) => i.severity === "blocking");
    quality.attempts.push({ ...review, attempt, file, action: attempt === 0 ? "initial" : `caption-repair-${attempt}` });
    quality.passed = blocking.length === 0;
    input.save(quality);
    if (quality.passed || attempt === max || blocking.some((i) => !["caption", "layout"].includes(i.kind))) break;
    file = await input.repair(attempt + 1, blocking);
  }
  return { file, quality };
}
