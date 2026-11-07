import { HttpError, bad, json, now, readJson, str, uid } from "./lib/util.js";
import { b32encode, clampIters, hashPassword, randomToken, safeEqual, seal, sha256Hex, totpVerify, unseal, verifyPassword } from "./lib/crypto.js";
import { audit, list, one, run } from "./lib/db.js";

const DAY = 86400000;
const SESSION_ABS = 7 * DAY, SESSION_IDLE = 3 * DAY, TOUCH_EVERY = 5 * 60000;
const WINDOW = 15 * 60000, MAX_FAILS = 5, LOCK_MS = 15 * 60000;

const cookieName = (url) => (url.protocol === "https:" ? "__Host-rds_session" : "rds_session");
const cookieHeader = (url, value, maxAge) =>
  `${cookieName(url)}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${url.protocol === "https:" ? "; Secure" : ""}`;
const readCookie = (req, name) => {
  for (const part of (req.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
};

const COMMON = new Set(["password1234", "123456789012", "qwertyuiop12", "iloveyou1234", "administrator", "passwordpassword"]);
export function passwordProblem(pw) {
  if (typeof pw !== "string") return "Password is required.";
  if (pw.length < 12) return "Use at least 12 characters.";
  if (pw.length > 200) return "Use at most 200 characters.";
  if (new Set(pw).size < 5) return "Use more varied characters.";
  if (COMMON.has(pw.toLowerCase())) return "That password is too common.";
  return null;
}

async function throttleCheck(db, key) {
  const r = await one(db, "SELECT locked_until FROM login_throttle WHERE key=?", key);
  const t = Date.now();
  if (r && r.locked_until > t) throw new HttpError(429, "LOCKED", "Too many attempts. Try again later.", { retryAfter: Math.ceil((r.locked_until - t) / 1000) });
}
// One row per key (no row-per-attempt), so attackers cannot burn the D1 write quota.
async function throttleFail(db, key) {
  const t = Date.now(), r = await one(db, "SELECT fails,window_start FROM login_throttle WHERE key=?", key);
  let fails = 1, ws = t;
  if (r && t - r.window_start < WINDOW) { fails = r.fails + 1; ws = r.window_start; }
  const lock = fails >= MAX_FAILS ? t + LOCK_MS : 0;
  await run(db, "INSERT INTO login_throttle(key,fails,window_start,locked_until) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET fails=excluded.fails, window_start=excluded.window_start, locked_until=excluded.locked_until", key, fails, ws, lock);
  return lock > 0;
}
const throttleClear = (db, key) => run(db, "DELETE FROM login_throttle WHERE key=?", key);

export async function clientIpHash(req) {
  const ip = req.headers.get("CF-Connecting-IP") || (req.headers.get("X-Forwarded-For") || "").split(",")[0].trim() || "unknown";
  return (await sha256Hex("ip|" + ip)).slice(0, 24);
}

async function createSession(c, extraRevokeOthers = false) {
  const { env, url, req, ipHash } = c;
  const token = randomToken(32), csrf = randomToken(24), t = Date.now();
  await run(env.DB, "INSERT INTO sessions(token_hash,sid,csrf,created_at,last_seen_at,expires_at,idle_expires_at,ip_hash,user_agent) VALUES(?,?,?,?,?,?,?,?,?)",
    await sha256Hex(token), uid(), csrf, new Date(t).toISOString(), new Date(t).toISOString(), new Date(t + SESSION_ABS).toISOString(), new Date(t + SESSION_IDLE).toISOString(), ipHash, (req.headers.get("User-Agent") || "").slice(0, 160));
  // opportunistic cleanup keeps the table tiny
  await run(env.DB, "DELETE FROM sessions WHERE expires_at<? OR idle_expires_at<?", new Date(t).toISOString(), new Date(t).toISOString());
  await run(env.DB, "DELETE FROM login_throttle WHERE locked_until<? AND window_start<?", t, t - WINDOW);
  return { csrf, cookie: cookieHeader(url, token, SESSION_ABS / 1000) };
}

export async function authenticate(req, env, url) {
  const token = readCookie(req, cookieName(url));
  if (!token || token.length > 120) return null;
  const th = await sha256Hex(token), s = await one(env.DB, "SELECT * FROM sessions WHERE token_hash=?", th);
  if (!s) return null;
  const t = Date.now();
  if (Date.parse(s.expires_at) < t || Date.parse(s.idle_expires_at) < t) { await run(env.DB, "DELETE FROM sessions WHERE token_hash=?", th); return null; }
  if (t - Date.parse(s.last_seen_at) > TOUCH_EVERY)
    await run(env.DB, "UPDATE sessions SET last_seen_at=?, idle_expires_at=? WHERE token_hash=?", new Date(t).toISOString(), new Date(t + SESSION_IDLE).toISOString(), th);
  return s;
}

// Origin + CSRF checks for state-changing requests.
export async function guardUnsafe(req, url, session) {
  const origin = req.headers.get("Origin");
  if (origin && origin !== url.origin) throw new HttpError(403, "BAD_ORIGIN", "Cross-site request blocked.");
  if (session && !(await safeEqual(req.headers.get("X-CSRF-Token") || "", session.csrf))) throw new HttpError(403, "CSRF", "Session check failed. Reload the page and try again.");
}

const getOwner = (db) => one(db, "SELECT * FROM owner WHERE id=1");
const needSetupToken = (env) => {
  if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 24) throw new HttpError(503, "SETUP_TOKEN_NOT_CONFIGURED", "Add a SETUP_TOKEN secret (24+ characters) to the Worker first.");
};

async function verifyTotpOrFail(env, owner, code) {
  const secret = await unseal(env.SETUP_TOKEN, owner.totp_secret);
  const step = await totpVerify(secret, code, owner.totp_last_step);
  if (step === null) return false;
  await run(env.DB, "UPDATE owner SET totp_last_step=? WHERE id=1", step);
  return true;
}

// Public + authenticated auth endpoints. Returns a Response, or null if the path is not an auth route.
export async function authRoutes(c) {
  const { req, env, url, path, method, ipHash } = c;
  const db = env.DB;
  const iters = clampIters(env.PBKDF2_ITERATIONS);

  if (path === "/api/auth/session" && method === "GET") {
    const owner = await getOwner(db), s = await authenticate(req, env, url);
    return json({ authenticated: !!s, setupRequired: !owner, totpEnabled: !!(owner && owner.totp_enabled), csrf: s ? s.csrf : null });
  }

  if (path === "/api/auth/setup" && method === "POST") {
    await guardUnsafe(req, url, null);
    needSetupToken(env);
    const b = await readJson(req), key = "setup|" + ipHash;
    await throttleCheck(db, key);
    if (await getOwner(db)) throw new HttpError(409, "ALREADY_SETUP", "The owner account already exists.");
    if (!(await safeEqual(str(b.setupToken, "Setup token", { req: true, max: 300 }), env.SETUP_TOKEN))) {
      if (await throttleFail(db, key)) await audit(env, "setup_locked", "", "anonymous", ipHash);
      throw new HttpError(403, "BAD_SETUP_TOKEN", "That setup token is not correct.");
    }
    const problem = passwordProblem(b.password); if (problem) throw bad(problem, "WEAK_PASSWORD");
    const t = now();
    try { await run(db, "INSERT INTO owner(id,password_hash,created_at,password_changed_at) VALUES(1,?,?,?)", await hashPassword(b.password, iters), t, t); }
    catch { throw new HttpError(409, "ALREADY_SETUP", "The owner account already exists."); }
    await throttleClear(db, key);
    const s = await createSession(c);
    await audit(env, "owner_setup", "", "owner", ipHash);
    return json({ ok: true, csrf: s.csrf }, 200, { "Set-Cookie": s.cookie });
  }

  if (path === "/api/auth/login" && method === "POST") {
    await guardUnsafe(req, url, null);
    const owner = await getOwner(db);
    if (!owner) throw new HttpError(409, "SETUP_REQUIRED", "Create the owner account first.");
    const b = await readJson(req), key = "login|" + ipHash;
    await throttleCheck(db, key);
    const okPw = typeof b.password === "string" && b.password.length <= 200 && (await verifyPassword(b.password, owner.password_hash));
    if (!okPw) {
      if (await throttleFail(db, key)) await audit(env, "login_locked", "", "anonymous", ipHash);
      throw new HttpError(401, "BAD_CREDENTIALS", "Incorrect password.");
    }
    if (owner.totp_enabled) {
      if (!b.totp) throw new HttpError(401, "TOTP_REQUIRED", "Enter your 6-digit authenticator code.");
      if (!(await verifyTotpOrFail(env, owner, String(b.totp).trim()))) {
        if (await throttleFail(db, key)) await audit(env, "login_locked", "totp", "anonymous", ipHash);
        throw new HttpError(401, "BAD_TOTP", "That code is not valid or was already used.");
      }
    }
    await throttleClear(db, key);
    const s = await createSession(c);
    await audit(env, "login_ok", "", "owner", ipHash);
    return json({ ok: true, csrf: s.csrf }, 200, { "Set-Cookie": s.cookie });
  }

  if (path === "/api/auth/reset" && method === "POST") {
    await guardUnsafe(req, url, null);
    needSetupToken(env);
    const owner = await getOwner(db);
    if (!owner) throw new HttpError(409, "SETUP_REQUIRED", "Create the owner account first.");
    const b = await readJson(req), key = "reset|" + ipHash;
    await throttleCheck(db, key);
    if (!(await safeEqual(str(b.setupToken, "Setup token", { req: true, max: 300 }), env.SETUP_TOKEN))) {
      if (await throttleFail(db, key)) await audit(env, "reset_locked", "", "anonymous", ipHash);
      throw new HttpError(403, "BAD_SETUP_TOKEN", "That setup token is not correct.");
    }
    const problem = passwordProblem(b.password); if (problem) throw bad(problem, "WEAK_PASSWORD");
    await run(db, "UPDATE owner SET password_hash=?, totp_secret=NULL, totp_pending=NULL, totp_enabled=0, password_changed_at=? WHERE id=1", await hashPassword(b.password, iters), now());
    await run(db, "DELETE FROM sessions");
    await throttleClear(db, key); await throttleClear(db, "login|" + ipHash);
    await audit(env, "owner_reset", "password reset; 2FA cleared; all sessions revoked", "owner", ipHash);
    return json({ ok: true });
  }

  // ---- authenticated below ----
  const s = c.session;
  if (!s) return null;

  if (path === "/api/auth/logout" && method === "POST") {
    await run(db, "DELETE FROM sessions WHERE token_hash=?", s.token_hash);
    await audit(env, "logout", "", "owner", ipHash);
    return json({ ok: true }, 200, { "Set-Cookie": cookieHeader(url, "", 0) });
  }
  if (path === "/api/auth/logout-all" && method === "POST") {
    await run(db, "DELETE FROM sessions WHERE token_hash<>?", s.token_hash);
    await audit(env, "logout_others", "", "owner", ipHash);
    return json({ ok: true });
  }
  if (path === "/api/auth/sessions" && method === "GET") {
    const rows = await list(db, "SELECT sid,created_at,last_seen_at,expires_at,user_agent,token_hash FROM sessions ORDER BY last_seen_at DESC");
    return json({ sessions: rows.map((r) => ({ sid: r.sid, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, userAgent: r.user_agent, current: r.token_hash === s.token_hash })) });
  }
  const del = path.match(/^\/api\/auth\/sessions\/([0-9a-f-]{36})$/);
  if (del && method === "DELETE") {
    await run(db, "DELETE FROM sessions WHERE sid=? AND token_hash<>?", del[1], s.token_hash);
    return json({ ok: true });
  }

  if (path === "/api/auth/password" && method === "POST") {
    const b = await readJson(req), owner = await getOwner(db), key = "login|" + ipHash;
    await throttleCheck(db, key);
    if (!(typeof b.current === "string" && (await verifyPassword(b.current, owner.password_hash)))) {
      await throttleFail(db, key);
      throw new HttpError(401, "BAD_CREDENTIALS", "Current password is incorrect.");
    }
    const problem = passwordProblem(b.next); if (problem) throw bad(problem, "WEAK_PASSWORD");
    await run(db, "UPDATE owner SET password_hash=?, password_changed_at=? WHERE id=1", await hashPassword(b.next, iters), now());
    await run(db, "DELETE FROM sessions WHERE token_hash<>?", s.token_hash);
    await throttleClear(db, key);
    await audit(env, "password_changed", "other sessions revoked", "owner", ipHash);
    return json({ ok: true });
  }

  if (path === "/api/auth/totp/begin" && method === "POST") {
    needSetupToken(env);
    const owner = await getOwner(db);
    if (owner.totp_enabled) throw new HttpError(409, "TOTP_ALREADY_ON", "Two-step sign-in is already on.");
    const secret = b32encode(crypto.getRandomValues(new Uint8Array(20)));
    await run(db, "UPDATE owner SET totp_pending=? WHERE id=1", await seal(env.SETUP_TOKEN, secret));
    return json({ secret, uri: `otpauth://totp/Rahat%20DeSecret:owner?secret=${secret}&issuer=Rahat%20DeSecret&digits=6&period=30` });
  }
  if (path === "/api/auth/totp/enable" && method === "POST") {
    const b = await readJson(req), owner = await getOwner(db);
    if (!owner.totp_pending) throw bad("Start setup first.", "NO_PENDING_TOTP");
    const secret = await unseal(env.SETUP_TOKEN, owner.totp_pending);
    const step = await totpVerify(secret, String(b.code || "").trim(), 0);
    if (step === null) throw new HttpError(401, "BAD_TOTP", "That code is not valid. Check your phone's clock and try again.");
    await run(db, "UPDATE owner SET totp_secret=totp_pending, totp_pending=NULL, totp_enabled=1, totp_last_step=? WHERE id=1", step);
    await run(db, "DELETE FROM sessions WHERE token_hash<>?", s.token_hash);
    await audit(env, "totp_enabled", "other sessions revoked", "owner", ipHash);
    return json({ ok: true });
  }
  if (path === "/api/auth/totp/disable" && method === "POST") {
    const b = await readJson(req), owner = await getOwner(db), key = "login|" + ipHash;
    await throttleCheck(db, key);
    const okPw = typeof b.password === "string" && (await verifyPassword(b.password, owner.password_hash));
    const okCode = owner.totp_enabled ? await verifyTotpOrFail(env, owner, String(b.code || "").trim()) : true;
    if (!okPw || !okCode) { await throttleFail(db, key); throw new HttpError(401, "BAD_CREDENTIALS", "Password or code is incorrect."); }
    await run(db, "UPDATE owner SET totp_secret=NULL, totp_pending=NULL, totp_enabled=0 WHERE id=1");
    await audit(env, "totp_disabled", "", "owner", ipHash);
    return json({ ok: true });
  }
  return null;
}
