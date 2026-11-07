const enc = new TextEncoder();

export const b64u = (buf) => {
  const b = new Uint8Array(buf); let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64u = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "=";
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
export const randomToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
// Constant-time comparison (compares fixed-length digests, not the raw values).
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([sha256Hex(String(a)), sha256Hex(String(b))]);
  let r = 0; for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}

export const clampIters = (v) => Math.min(100000, Math.max(10000, parseInt(v, 10) || 100000));
async function derive(pw, salt, iters) {
  const key = await crypto.subtle.importKey("raw", enc.encode(pw), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iters }, key, 256);
}
export async function hashPassword(pw, iters = 100000) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$sha256$${iters}$${b64u(salt)}$${b64u(await derive(pw, salt, iters))}`;
}
export async function verifyPassword(pw, stored) {
  const p = String(stored || "").split("$");
  if (p.length !== 5 || p[0] !== "pbkdf2") return false;
  const iters = parseInt(p[2], 10);
  if (!(iters >= 1000 && iters <= 1000000)) return false;
  return safeEqual(b64u(await derive(pw, unb64u(p[3]), iters)), p[4]);
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function b32encode(u8) {
  let bits = 0, val = 0, out = "";
  for (const b of u8) { val = ((val << 8) | b) & 0xffffff; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function b32decode(s) {
  let bits = 0, val = 0; const out = [];
  for (const ch of s.replace(/=+$/, "").toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    val = ((val << 5) | i) & 0xffffff; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}
export async function totpAt(secretU8, step) {
  const key = await crypto.subtle.importKey("raw", secretU8, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const msg = new ArrayBuffer(8), dv = new DataView(msg);
  dv.setUint32(0, Math.floor(step / 4294967296)); dv.setUint32(4, step >>> 0);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = sig[19] & 15;
  const n = ((sig[o] & 0x7f) << 24) | (sig[o + 1] << 16) | (sig[o + 2] << 8) | sig[o + 3];
  return String(n % 1000000).padStart(6, "0");
}
// Returns the matched time-step (so the caller can block replays) or null.
export async function totpVerify(secretB32, code, lastStep = 0) {
  if (!/^\d{6}$/.test(String(code || ""))) return null;
  const secret = b32decode(secretB32), cur = Math.floor(Date.now() / 30000);
  for (const d of [0, -1, 1]) {
    const step = cur + d; if (step <= lastStep) continue;
    if (await safeEqual(await totpAt(secret, step), code)) return step;
  }
  return null;
}

async function aesKey(secret) {
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode("rds-data-key|" + secret)), "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(secret, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), enc.encode(text));
  return b64u(iv) + "." + b64u(ct);
}
export async function unseal(secret, blob) {
  const [iv, ct] = blob.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64u(iv) }, await aesKey(secret), unb64u(ct)));
}
