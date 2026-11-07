import { HttpError, bad, json, now, readJson, secondsToUtcMidnight, sleep, str, uid } from "./lib/util.js";
import { audit, list, one, run } from "./lib/db.js";

// Providers whose free quota is shared by the whole account (a hit blocks every model on them).
const ACCOUNT_WIDE = new Set(["pricing", "credits", "allowlist"]);
const NON_CHAT = /whisper|tts|embed|guard|moderation|rerank|transcri|speech|image-gen|flux|stable-diffusion/i;
const MAX_STORE = 600;

export const hasKey = (env, p) => (p.kind === "workersai" ? !!env.AI : !!(p.key_env && env[p.key_env]));

// ---------- free-tier rules ----------
function allZero(p) {
  if (!p || typeof p !== "object" || !("prompt" in p) || !("completion" in p)) return false;
  return Object.values(p).every((v) => { const n = Number(v); return Number.isFinite(n) && n === 0; });
}
function normalize(policy, raw) {
  const id = raw && raw.id;
  if (typeof id !== "string" || !id || id.length > 200 || NON_CHAT.test(id) || raw.active === false) return null;
  const outMods = raw.architecture?.output_modalities || raw.output_modalities;
  if (Array.isArray(outMods) && !outMods.includes("text")) return null;
  let free, basis;
  if (policy === "pricing") { if (!allZero(raw.pricing)) return null; free = 1; basis = "pricing_zero"; }
  else if (policy === "tier") { free = 1; basis = "provider_free_tier"; }
  else if (policy === "credits") { free = 1; basis = "monthly_credits"; }
  else return null;
  const ctx = raw.context_length ?? raw.context_window ?? raw.max_context_length ?? raw.providers?.find?.((p) => p.context_length)?.context_length ?? null;
  const tools = Array.isArray(raw.supported_parameters) ? raw.supported_parameters.includes("tools") : !!raw.providers?.some?.((p) => p.supports_tools);
  return { model_id: id, name: String(raw.name || id).slice(0, 160), ctx: Number.isFinite(Number(ctx)) ? Number(ctx) : null, tools: tools ? 1 : 0, free, basis };
}

async function getProvider(db, id) {
  const p = await one(db, "SELECT * FROM providers WHERE id=?", id);
  if (!p) throw new HttpError(404, "PROVIDER_NOT_FOUND", "Unknown provider.");
  return p;
}

// ---------- upstream plumbing ----------
function upstreamError(status, text, headers, policy) {
  const t = String(text || "").slice(0, 300);
  if (status === 401 || status === 403) return new HttpError(502, "PROVIDER_AUTH", "The provider rejected the API key or this account's access to the model. Check the secret and your account.");
  if (status === 402) return new HttpError(402, "QUOTA_EXHAUSTED", "Free quota or credits are used up for this provider. Nothing was charged and no paid fallback was used.", ACCOUNT_WIDE.has(policy) ? { cooldown: 300 } : {});
  if (status === 429) {
    const daily = /per day|daily|quota|exhaust/i.test(t);
    const secs = daily ? secondsToUtcMidnight() : Math.max(parseInt(headers.get("retry-after") || "0", 10) || 0, 30);
    return new HttpError(429, daily ? "QUOTA_EXHAUSTED" : "RATE_LIMITED", daily ? "The daily free quota is used up. It resets later; no paid fallback was used." : `Rate limit reached. Try again in about ${secs} seconds.`, { retryAfter: secs, cooldown: daily && ACCOUNT_WIDE.has(policy) ? secs : 0 });
  }
  if (status === 404 || status === 410) return new HttpError(404, "MODEL_UNAVAILABLE", "The provider no longer serves this model. Re-sync the catalog and pick another.");
  if (status === 400 || status === 422) return new HttpError(400, "PROVIDER_REJECTED", "The provider rejected the request: " + t.replace(/\s+/g, " "));
  return new HttpError(502, "PROVIDER_ERROR", `The provider returned an error (${status}).`);
}
function withTimeout(signal, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new Error("timeout")), ms);
  if (signal) { if (signal.aborted) c.abort(); else signal.addEventListener("abort", () => c.abort(), { once: true }); }
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function openaiChat(env, m, payload, signal) {
  const base = m.base_url.replace(/\/+$/, "");
  const headers = { Authorization: "Bearer " + env[m.key_env], "Content-Type": "application/json" };
  const body = { ...payload };
  if (m.provider_id === "openrouter") { headers["X-Title"] = "Rahat DeSecret"; body.provider = { max_price: { prompt: 0, completion: 0, request: 0, image: 0 } }; }
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const to = withTimeout(signal, 30000);
    try {
      const res = await fetch(base + "/chat/completions", { method: "POST", headers, body: JSON.stringify(body), signal: to.signal });
      to.done();
      if (res.status >= 500 && attempt === 0) { await sleep(400); continue; }
      if (res.status === 400 && body.provider) { // guard param unsupported: model-level free filter still applies
        const txt = await res.clone().text();
        if (/max_price|provider/i.test(txt)) { delete body.provider; continue; }
      }
      return res;
    } catch (e) {
      to.done();
      if (signal?.aborted) throw e;
      lastErr = e;
      if (attempt < 1) await sleep(400); else break;
    }
  }
  throw new HttpError(504, "PROVIDER_UNREACHABLE", "Could not reach the provider (timeout or network error)." + (lastErr ? "" : ""));
}

// Throws unless the model may be called under FREE_ONLY.
export async function loadRoutable(env, key) {
  const m = await one(env.DB, `SELECT m.*, p.kind, p.base_url, p.key_env, p.enabled, p.free_attested_at, p.cooldown_until, p.free_policy, p.name AS provider_name
    FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.key=?`, key);
  if (!m) throw new HttpError(404, "MODEL_NOT_FOUND", "That model is not in your catalog.");
  if (m.status !== "active") throw new HttpError(409, "MODEL_UNAVAILABLE", "That model is no longer listed by its provider.");
  if (!m.free) throw new HttpError(403, "NOT_FREE", "Blocked by FREE_ONLY: this model is not verified free.");
  if (!m.enabled) throw new HttpError(403, "PROVIDER_DISABLED", `${m.provider_name} is turned off. Enable it in Models.`);
  if (!m.free_attested_at) throw new HttpError(403, "FREE_NOT_VERIFIED", `Confirm the free-tier terms for ${m.provider_name} before using it.`);
  if (m.cooldown_until > Date.now()) throw new HttpError(429, "PROVIDER_COOLDOWN", `${m.provider_name} is paused after hitting its free quota.`, { retryAfter: Math.ceil((m.cooldown_until - Date.now()) / 1000) });
  if (m.kind === "workersai" ? !env.AI : !env[m.key_env]) throw new HttpError(503, "NO_API_KEY", m.kind === "workersai" ? "The Workers AI binding (AI) is not attached to this Worker." : `Add the ${m.key_env} secret to the Worker to use ${m.provider_name}.`);
  return m;
}

async function record(env, m, ok, status, code, usage, ms) {
  try {
    await run(env.DB, "INSERT INTO usage_records(id,provider_id,model_key,ok,status,error_code,tokens_in,tokens_out,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      uid(), m.provider_id, m.key, ok ? 1 : 0, status ?? null, code ?? null, usage?.prompt_tokens ?? usage?.input_tokens ?? null, usage?.completion_tokens ?? usage?.output_tokens ?? null, ms, now());
  } catch (e) { console.error("usage record failed", e && e.message); }
}
async function applyCooldown(env, m, e) {
  if (e instanceof HttpError && e.extra?.cooldown) await run(env.DB, "UPDATE providers SET cooldown_until=? WHERE id=?", Date.now() + e.extra.cooldown * 1000, m.provider_id);
}

function workersAiError(e) {
  const msg = String(e && e.message || e);
  if (/daily free allocation|neurons|4006|quota/i.test(msg)) return new HttpError(429, "QUOTA_EXHAUSTED", "The daily free Workers AI allocation is used up. It resets at 00:00 UTC; nothing was charged.", { retryAfter: secondsToUtcMidnight(), cooldown: secondsToUtcMidnight() });
  if (/paid|upgrade|billing|workers paid/i.test(msg)) return new HttpError(403, "NOT_FREE", "This model needs a paid Workers plan, so it is blocked.", { markPaid: true });
  if (/no such model|not found|5007|does not exist/i.test(msg)) return new HttpError(404, "MODEL_UNAVAILABLE", "Workers AI does not offer this model on your account. Remove it or pick another.");
  return new HttpError(502, "PROVIDER_ERROR", "Workers AI returned an error.");
}

// Start a generation. Returns { stream: ReadableStream|null, text?, usage? }.
export async function generate(env, m, messages, { stream = false, maxTokens, signal } = {}) {
  const started = Date.now();
  try {
    if (m.kind === "workersai") {
      const input = { messages, stream };
      if (maxTokens) input.max_tokens = maxTokens;
      const r = await env.AI.run(m.model_id, input);
      if (stream) return { stream: r, started };
      const text = r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response ?? "";
      return { text: String(text), usage: r?.usage, started };
    }
    const payload = { model: m.model_id, messages, stream, temperature: 0.6 };
    if (maxTokens) payload.max_tokens = maxTokens;
    const res = await openaiChat(env, m, payload, signal);
    if (!res.ok) throw upstreamError(res.status, await res.text().catch(() => ""), res.headers, m.free_policy);
    if (stream) return { stream: res.body, started };
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new HttpError(502, "EMPTY_RESPONSE", "The model returned an empty reply.");
    return { text, usage: data.usage, started };
  } catch (e) {
    const err = m.kind === "workersai" && !(e instanceof HttpError) ? workersAiError(e) : e;
    if (err instanceof HttpError) {
      if (err.extra?.markPaid) await run(env.DB, "UPDATE models SET free=0, free_basis='needs_paid_plan' WHERE key=?", m.key);
      await applyCooldown(env, m, err);
      await record(env, m, false, err.status, err.code, null, Date.now() - started);
    }
    throw err;
  }
}
export const recordSuccess = (env, m, usage, started) => record(env, m, true, 200, null, usage, Date.now() - started);

// Parse SSE bytes from either OpenAI-style or Workers-AI-style streams.
export async function* sseData(body) {
  const reader = body.getReader(), dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        if (line.startsWith("data:")) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith("data:")) yield buf.slice(5).trim();
  } finally { try { reader.releaseLock(); } catch { /* already released */ } }
}
export const deltaOf = (o) => o?.choices?.[0]?.delta?.content ?? o?.choices?.[0]?.text ?? (typeof o?.response === "string" ? o.response : "") ?? "";

// ---------- catalog sync ----------
export async function syncProvider(env, id) {
  const p = await getProvider(env.DB, id);
  if (p.kind === "workersai") throw bad("Workers AI uses a built-in list. Add models manually or press Test on a seeded one.", "NO_SYNC");
  if (!p.base_url) throw bad("This provider has no base URL.");
  const key = p.key_env ? env[p.key_env] : null;
  if (p.free_policy !== "pricing" && !key) throw new HttpError(503, "NO_API_KEY", `Add the ${p.key_env} secret first; this provider lists models only for signed-in accounts.`);
  const to = withTimeout(null, 20000);
  let res;
  try { res = await fetch(p.base_url.replace(/\/+$/, "") + "/models", { headers: key ? { Authorization: "Bearer " + key } : {}, signal: to.signal }); }
  catch { throw new HttpError(504, "PROVIDER_UNREACHABLE", "Could not reach the provider's model list."); }
  finally { to.done(); }
  if (!res.ok) throw upstreamError(res.status, await res.text().catch(() => ""), res.headers, p.free_policy);
  const data = await res.json().catch(() => null);
  const items = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  const t = now();
  const rows = []; let skipped = 0;
  for (const raw of items) {
    const n = normalize(p.free_policy, raw);
    if (!n) { skipped++; continue; }
    if (rows.length < MAX_STORE) rows.push(n);
  }
  const sql = `INSERT INTO models(key,provider_id,model_id,name,context_length,free,free_basis,supports_tools,status,favorite,manual,last_seen_at,created_at) VALUES(?,?,?,?,?,?,?,?, 'active',0,0,?,?)
    ON CONFLICT(key) DO UPDATE SET name=excluded.name, context_length=excluded.context_length, free=excluded.free, free_basis=excluded.free_basis, supports_tools=excluded.supports_tools, status='active', last_seen_at=excluded.last_seen_at`;
  for (let i = 0; i < rows.length; i += 40)
    await env.DB.batch(rows.slice(i, i + 40).map((n) => env.DB.prepare(sql).bind(`${p.id}:${n.model_id}`, p.id, n.model_id, n.name, n.ctx, n.free, n.basis, n.tools, t, t)));
  await run(env.DB, "UPDATE models SET status='gone' WHERE provider_id=? AND manual=0 AND last_seen_at<?", p.id, t);
  const note = `${rows.length} free models stored, ${skipped} skipped (paid, non-chat or unlisted)` + (items.length > MAX_STORE + skipped ? `; capped at ${MAX_STORE}` : "");
  await run(env.DB, "UPDATE providers SET last_sync_at=?, last_sync_note=? WHERE id=?", t, note, p.id);
  await audit(env, "catalog_sync", `${p.id}: ${note}`);
  return { stored: rows.length, skipped, note };
}

// ---------- HTTP routes ----------
const slug = /^[a-z0-9][a-z0-9-]{1,30}$/;
export async function llmRoutes(c) {
  const { req, env, path, method, url } = c, db = env.DB;
  let m;

  if (path === "/api/providers" && method === "GET") {
    const rows = await list(db, `SELECT p.*, (SELECT COUNT(*) FROM models m WHERE m.provider_id=p.id AND m.status='active' AND m.free=1) AS model_count FROM providers p ORDER BY p.custom, p.name`);
    return json({ freeOnly: true, providers: rows.map((p) => ({ id: p.id, name: p.name, kind: p.kind, baseUrl: p.base_url, keyEnv: p.key_env, policy: p.free_policy, enabled: !!p.enabled, attestedAt: p.free_attested_at, hasKey: hasKey(env, p), cooldownUntil: p.cooldown_until > Date.now() ? p.cooldown_until : null, lastSyncAt: p.last_sync_at, lastSyncNote: p.last_sync_note, modelCount: p.model_count, custom: !!p.custom })) });
  }
  if (path === "/api/providers" && method === "POST") {
    const b = await readJson(req);
    const id = str(b.id, "Id", { req: true, max: 31 }), name = str(b.name, "Name", { req: true, max: 60 });
    const base = str(b.baseUrl, "Base URL", { req: true, max: 300 }), keyEnv = str(b.keyEnv, "Secret name", { req: true, max: 60 });
    if (!slug.test(id)) throw bad("Id must be lowercase letters, numbers and dashes.");
    if (!/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[^\s]*)?$/i.test(base)) throw bad("Base URL must start with https://");
    if (!/^[A-Z][A-Z0-9_]{2,59}$/.test(keyEnv)) throw bad("Secret name must look like MY_PROVIDER_API_KEY.");
    try { await run(db, "INSERT INTO providers(id,name,kind,base_url,key_env,free_policy,enabled,custom,created_at) VALUES(?,?,?,?,?,?,0,1,?)", id, name, "openai", base, keyEnv, "tier", now()); }
    catch { throw new HttpError(409, "EXISTS", "A provider with that id already exists."); }
    await audit(env, "provider_added", id);
    return json({ ok: true }, 201);
  }
  if (path === "/api/providers/health" && method === "GET") {
    const ps = await list(db, "SELECT * FROM providers WHERE enabled=1");
    const out = await Promise.all(ps.map(async (p) => {
      if (p.kind === "workersai") return { id: p.id, status: env.AI ? "binding_present" : "no_binding" };
      if (!env[p.key_env]) return { id: p.id, status: "no_key" };
      const to = withTimeout(null, 8000), t0 = Date.now();
      try {
        const r = await fetch(p.base_url.replace(/\/+$/, "") + "/models", { headers: { Authorization: "Bearer " + env[p.key_env] }, signal: to.signal });
        return { id: p.id, status: r.ok ? "ok" : r.status === 401 || r.status === 403 ? "invalid_key" : r.status === 429 ? "rate_limited" : "error", httpStatus: r.status, ms: Date.now() - t0 };
      } catch { return { id: p.id, status: "unreachable" }; } finally { to.done(); }
    }));
    return json({ health: out });
  }
  m = path.match(/^\/api\/providers\/([a-z0-9-]+)$/);
  if (m && method === "PATCH") {
    const p = await getProvider(db, m[1]), b = await readJson(req);
    if (b.attest === false) { await run(db, "UPDATE providers SET free_attested_at=NULL, enabled=0 WHERE id=?", p.id); await audit(env, "provider_attestation_cleared", p.id); }
    if (b.attest === true) { await run(db, "UPDATE providers SET free_attested_at=? WHERE id=?", now(), p.id); await audit(env, "provider_attested", p.id); }
    if (typeof b.enabled === "boolean") {
      const fresh = await getProvider(db, p.id);
      if (b.enabled && !fresh.free_attested_at) throw new HttpError(403, "FREE_NOT_VERIFIED", "Confirm you checked this provider's free terms and your eligibility first.");
      await run(db, "UPDATE providers SET enabled=?, cooldown_until=0 WHERE id=?", b.enabled ? 1 : 0, p.id);
      await audit(env, b.enabled ? "provider_enabled" : "provider_disabled", p.id);
    }
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    const p = await getProvider(db, m[1]);
    if (!p.custom) throw bad("Built-in providers cannot be deleted. Turn them off instead.");
    await run(db, "DELETE FROM providers WHERE id=?", p.id); await audit(env, "provider_deleted", p.id);
    return json({ ok: true });
  }
  m = path.match(/^\/api\/providers\/([a-z0-9-]+)\/sync$/);
  if (m && method === "POST") return json(await syncProvider(env, m[1]));

  if (path === "/api/models" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80), prov = url.searchParams.get("provider") || "";
    const fav = url.searchParams.get("favorites") === "1";
    const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "40", 10) || 40)), offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
    const where = ["m.status='active'", "m.free=1", "p.enabled=1"], bind = [];
    if (prov) { where.push("m.provider_id=?"); bind.push(prov); }
    if (fav) where.push("m.favorite=1");
    if (q) { where.push("(m.name LIKE ? ESCAPE '\\' OR m.model_id LIKE ? ESCAPE '\\')"); const like = "%" + q.replace(/[\\%_]/g, "\\$&") + "%"; bind.push(like, like); }
    const from = `FROM models m JOIN providers p ON p.id=m.provider_id WHERE ${where.join(" AND ")}`;
    const [rows, tot] = await Promise.all([
      list(db, `SELECT m.key,m.name,m.model_id,m.provider_id,p.name AS provider_name,m.context_length,m.free_basis,m.supports_tools,m.favorite ${from} ORDER BY m.favorite DESC, m.name LIMIT ? OFFSET ?`, ...bind, limit, offset),
      one(db, `SELECT COUNT(*) n ${from}`, ...bind),
    ]);
    return json({ models: rows.map((r) => ({ key: r.key, name: r.name, modelId: r.model_id, providerId: r.provider_id, providerName: r.provider_name, context: r.context_length, basis: r.free_basis, tools: !!r.supports_tools, favorite: !!r.favorite })), total: tot.n });
  }
  if (path === "/api/models" && method === "POST") {
    const b = await readJson(req), p = await getProvider(db, str(b.providerId, "Provider", { req: true, max: 40 }));
    if (p.free_policy === "pricing") throw bad("For this provider, use Sync: only models with verified zero pricing are added.", "USE_SYNC");
    const mid = str(b.modelId, "Model id", { req: true, max: 200 }), name = str(b.name, "Name", { max: 160 }) || mid, t = now();
    try { await run(db, "INSERT INTO models(key,provider_id,model_id,name,free,free_basis,status,manual,last_seen_at,created_at) VALUES(?,?,?,?,1,'manual','active',1,?,?)", `${p.id}:${mid}`, p.id, mid, name, t, t); }
    catch { throw new HttpError(409, "EXISTS", "That model is already in the catalog."); }
    await audit(env, "model_added", `${p.id}:${mid}`);
    return json({ ok: true }, 201);
  }
  m = path.match(/^\/api\/models\/([^/]+)$/);
  if (m && method === "PATCH") {
    const key = decodeURIComponent(m[1]), b = await readJson(req);
    if (typeof b.favorite === "boolean") await run(db, "UPDATE models SET favorite=? WHERE key=?", b.favorite ? 1 : 0, key);
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    const key = decodeURIComponent(m[1]);
    const r = await run(db, "DELETE FROM models WHERE key=? AND manual=1", key);
    if (!r.meta?.changes) throw bad("Only manually added models can be removed. Synced ones disappear when the provider drops them.");
    return json({ ok: true });
  }
  m = path.match(/^\/api\/models\/([^/]+)\/test$/);
  if (m && method === "POST") {
    const model = await loadRoutable(env, decodeURIComponent(m[1]));
    const g = await generate(env, model, [{ role: "user", content: "Reply with the single word: OK" }], { maxTokens: 8 });
    await recordSuccess(env, model, g.usage, g.started);
    return json({ ok: true, ms: Date.now() - g.started, sample: g.text.slice(0, 40) });
  }

  if (path === "/api/settings" && method === "GET") {
    const rows = await list(db, "SELECT key,value FROM settings");
    return json({ settings: Object.fromEntries(rows.map((r) => [r.key, r.value])) });
  }
  if (path === "/api/settings" && method === "PUT") {
    const b = await readJson(req);
    if (b.defaultModelKey !== undefined) {
      const v = b.defaultModelKey === null ? "" : str(b.defaultModelKey, "Model", { max: 300 });
      await run(db, "INSERT INTO settings(key,value,updated_at) VALUES('default_model_key',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at", v, now());
    }
    return json({ ok: true });
  }
  return null;
}
