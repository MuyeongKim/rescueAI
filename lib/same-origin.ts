/** 쿠키로 인증하는 변경 요청은 브라우저가 보낸 Origin과 실제 요청 출처를 대조한다. */
export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || (fetchSite !== null && fetchSite !== "same-origin")) return false;
  try {
    const expected = new URL(request.url);
    const actual = new URL(origin);
    return (actual.protocol === "https:" || actual.protocol === "http:")
      && actual.origin === expected.origin && actual.href === `${actual.origin}/`;
  } catch { return false; }
}
