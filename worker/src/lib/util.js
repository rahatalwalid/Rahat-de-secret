export class HttpError extends Error {
  constructor(status, code, message, extra = {}) { super(message || code); this.status = status; this.code = code; this.extra = extra; }
}
export const bad = (m, code = "VALIDATION") => new HttpError(400, code, m);
export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEC = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cache-Control": "no-store",
};
export function secHeaders(h = new Headers()) { for (const [k, v] of Object.entries(SEC)) h.set(k, v); return h; }

export function json(data, status = 200, extra = {}) {
  const h = secHeaders();
  h.set("Content-Type", "application/json; charset=utf-8");
  for (const [k, v] of Object.entries(extra)) k.toLowerCase() === "set-cookie" ? h.append(k, v) : h.set(k, v);
  return new Response(JSON.stringify(data), { status, headers: h });
}
export function sseResponse(stream) {
  const h = secHeaders();
  h.set("Content-Type", "text/event-stream; charset=utf-8");
  h.set("Cache-Control", "no-store, no-transform");
  h.set("X-Accel-Buffering", "no");
  return new Response(stream, { headers: h });
}
export function errorResponse(e, rid) {
  if (e instanceof HttpError) {
    const extra = {};
    if (e.extra?.retryAfter) extra["Retry-After"] = String(e.extra.retryAfter);
    return json({ error: e.code, message: e.message, retryAfter: e.extra?.retryAfter }, e.status, extra);
  }
  console.error("unhandled", rid, e && e.stack ? e.stack : e);
  return json({ error: "INTERNAL", message: "Something went wrong on the server.", requestId: rid }, 500);
}

export async function readJson(req, max = 65536) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send JSON.");
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, "TOO_LARGE", "Request body too large.");
  let v;
  try { v = JSON.parse(text || "{}"); } catch { throw bad("Body must be valid JSON.", "BAD_JSON"); }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw bad("Body must be a JSON object.", "BAD_JSON");
  return v;
}

export function str(v, name, { min = 0, max = 1000, req = false } = {}) {
  if (v === undefined || v === null) { if (req) throw bad(`${name} is required.`); return undefined; }
  if (typeof v !== "string") throw bad(`${name} must be text.`);
  const s = v.trim();
  if (req && !s) throw bad(`${name} is required.`);
  if (s.length < min) throw bad(`${name} must be at least ${min} characters.`);
  if (s.length > max) throw bad(`${name} must be at most ${max} characters.`);
  return s;
}
export function oneOf(v, name, list, { req = false } = {}) {
  if (v === undefined || v === null) { if (req) throw bad(`${name} is required.`); return undefined; }
  if (!list.includes(v)) throw bad(`${name} must be one of: ${list.join(", ")}.`);
  return v;
}
export function int(v, name, { min = 0, max = 1e9, req = false } = {}) {
  if (v === undefined || v === null) { if (req) throw bad(`${name} is required.`); return undefined; }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}
export function bool(v, name) {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw bad(`${name} must be true or false.`);
  return v;
}
export function dateOrNull(v, name) {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw bad(`${name} must be a valid date.`);
  return new Date(v).toISOString();
}
export const secondsToUtcMidnight = () => {
  const n = new Date();
  return Math.max(60, Math.ceil((Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1) - n.getTime()) / 1000));
};
