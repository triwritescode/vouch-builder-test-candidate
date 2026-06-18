// Bearer-token auth for /api/handover. The expected token lives only in env
// (VOUCH_API_KEY) and is never logged or returned. Returns true when authorised.
export function isAuthorised(req: Request): boolean {
  const expected = process.env.VOUCH_API_KEY;
  if (!expected) return false; // fail closed if unconfigured
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return timingSafeEqual(match[1]!.trim(), expected);
}

// Constant-time comparison to avoid leaking the token via response timing.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
