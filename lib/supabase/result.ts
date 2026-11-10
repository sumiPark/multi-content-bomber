// Supabase 호출 결과의 error를 버리지 않게 하는 작은 도우미.
//
// supabase-js는 실패해도 throw하지 않고 { data: null, error }를 돌려준다. 그래서
// `await supabase.from(...).update(...)`처럼 결과를 버리면 저장 · 삭제가 실패해도
// 아무도 모르고, 화면은 "저장했어요"라고 안내한다. 쓰기 호출은 아래 둘 중 하나로 감싼다.
//
//   mustOk(res, what)      실패하면 throw — 뒤 단계가 이 저장에 기대는 경우(워커 단계 전환 등)
//   warnIfError(res, what) 실패해도 계속 — 기록 · 통계처럼 없어도 흐름이 맞는 경우. 로그는 남긴다
//
// 서버 액션은 throw 대신 `{ ok: false, error }`를 돌려주는 기존 방식을 그대로 쓴다.

interface SupabaseLikeResult<T> {
  data: T;
  error: { message: string } | null;
}

/** 실패하면 `${what} 실패: …` 오류를 던지고, 성공하면 data를 돌려준다. */
export function mustOk<T>(res: SupabaseLikeResult<T>, what: string): T {
  if (res.error) throw new Error(`${what} 실패: ${res.error.message}`);
  return res.data;
}

/** 실패하면 경고 로그만 남기고 false. 성공하면 true. */
export function warnIfError(
  res: { error: { message: string } | null },
  what: string,
): boolean {
  if (!res.error) return true;
  console.warn(`[supabase] ${what} 실패: ${res.error.message}`);
  return false;
}
