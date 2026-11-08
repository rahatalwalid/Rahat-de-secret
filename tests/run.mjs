import { readFileSync } from "node:fs";
import worker from "../worker/src/index.js";
import { b32decode, totpAt } from "../worker/src/lib/crypto.js";
import { makeD1 } from "./d1shim.mjs";

const ORIGIN = "https://app.test";
let pass = 0, fail = 0;
const results = [];
function ok(cond, name, extra) { cond ? pass++ : fail++; results.push(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== undefined ? "  -> " + JSON.stringify(extra) : ""}`); }

function makeEnv(extra = {}, preSql) {
  return { DB: makeD1(preSql), SETUP_TOKEN: "s".repeat(32), PBKDF2_ITERATIONS: "10000", ASSETS: { fetch: async () => new Response("asset") }, ...extra };
}
function makeClient(env) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const jar = { cookie: "", csrf: "" };
  async function raw(method, path, body, opts = {}) {
    const headers = { Origin: ORIGIN, "CF-Connecting-IP": opts.ip || "1.2.3.4", ...(opts.headers || {}) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (jar.cookie && !opts.noCookie) headers.Cookie = jar.cookie;
    if (jar.csrf && method !== "GET" && !opts.noCsrf) headers["X-CSRF-Token"] = jar.csrf;
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    const sc = res.headers.get("set-cookie");
    if (sc) { const pair = sc.split(";")[0]; jar.cookie = pair.endsWith("=") ? "" : pair; }
    return res;
  }
  async function call(method, path, body, opts) {
    const res = await raw(method, path, body, opts);
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json() : null;
    if (data && data.csrf) jar.csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  }
  const settle = () => Promise.all(pending.splice(0));
  return { call, raw, jar, settle };
}
const PW = "correct horse battery 9";

async function testAuth() {
  const env = makeEnv(); const c = makeClient(env);
  let r = await c.call("GET", "/api/auth/session");
  ok(r.status === 200 && r.data.setupRequired === true && !r.data.authenticated, "fresh install reports setupRequired");
  r = await c.call("GET", "/api/agents");
  ok(r.status === 401, "private API rejects anonymous requests", r.status);
  r = await c.call("GET", "/api/health");
  ok(r.status === 200 && Object.keys(r.data).join() === "ok", "health reveals nothing but ok");
  ok(r.headers.get("x-content-type-options") === "nosniff" && r.headers.get("strict-transport-security") && r.headers.get("content-security-policy"), "API responses carry security headers");

  r = await c.call("POST", "/api/auth/setup", { setupToken: "wrong".repeat(8), password: PW });
  ok(r.status === 403, "setup rejects a wrong setup token", r.status);
  r = await c.call("POST", "/api/auth/setup", { setupToken: env.SETUP_TOKEN, password: "short" });
  ok(r.status === 400 && r.data.error === "WEAK_PASSWORD", "setup rejects weak passwords", r.data);
  r = await c.call("POST", "/api/auth/setup", { setupToken: env.SETUP_TOKEN, password: PW });
  ok(r.status === 200 && r.data.csrf && c.jar.cookie.startsWith("__Host-rds_session="), "setup creates owner and session cookie");
  const sc = (await c.raw("GET", "/api/auth/session")).headers.get("set-cookie");
  ok(sc === null, "session check does not reset cookie");
  r = await c.call("POST", "/api/auth/setup", { setupToken: env.SETUP_TOKEN, password: PW + "x" });
  ok(r.status === 409, "setup cannot run twice", r.status);
  const dbHash = (await env.DB.prepare("SELECT password_hash FROM owner").first()).password_hash;
  ok(dbHash.startsWith("pbkdf2$sha256$10000$") && !dbHash.includes(PW), "password stored only as PBKDF2 hash");

  r = await c.call("POST", "/api/agents", { name: "A", role: "B" }, { noCsrf: true });
  ok(r.status === 403 && r.data.error === "CSRF", "state-changing request without CSRF token is rejected", r.data);
  r = await c.call("POST", "/api/agents", { name: "A", role: "B" }, { headers: { Origin: "https://evil.test" } });
  ok(r.status === 403 && r.data.error === "BAD_ORIGIN", "cross-origin request is rejected", r.data);
  r = await c.call("POST", "/api/agents", { name: "A", role: "B" });
  ok(r.status === 201, "authenticated + CSRF request succeeds", r.data);

  const oldCookie = c.jar.cookie;
  r = await c.call("POST", "/api/auth/logout", {});
  ok(r.status === 200, "logout works");
  const c2 = makeClient(env); c2.jar.cookie = oldCookie;
  r = await c2.call("GET", "/api/agents");
  ok(r.status === 401, "logout revokes the session server-side (old cookie dead)", r.status);

  // login throttle
  const c3 = makeClient(env);
  const before = (await env.DB.prepare("SELECT COUNT(*) n FROM audit_log").first()).n;
  const codes = [];
  for (let i = 0; i < 6; i++) { r = await c3.call("POST", "/api/auth/login", { password: "wrong password here" }, { ip: "9.9.9.9" }); codes.push(r.status); }
  ok(codes.join() === "401,401,401,401,401,429", "5 wrong logins then lockout", codes);
  ok(Number(r.headers.get("retry-after")) > 0, "lockout sends Retry-After");
  const after = (await env.DB.prepare("SELECT COUNT(*) n FROM audit_log").first()).n;
  ok(after - before === 1, "failed logins write one audit row (on lockout) not one per attempt", after - before);
  r = await c3.call("POST", "/api/auth/login", { password: PW }, { ip: "9.9.9.9" });
  ok(r.status === 429, "correct password is also refused while locked");
  r = await c3.call("POST", "/api/auth/login", { password: PW }, { ip: "8.8.8.8" });
  ok(r.status === 200, "a different client can still sign in (no global lockout)");

  // sessions + change password
  const c4 = makeClient(env); await c4.call("POST", "/api/auth/login", { password: PW });
  r = await c3.call("GET", "/api/auth/sessions");
  ok(r.status === 200 && r.data.sessions.length >= 2 && r.data.sessions.some((s) => s.current), "session list shows devices and marks current");
  r = await c3.call("POST", "/api/auth/password", { current: "nope nope nope nope", next: PW + "2" });
  ok(r.status === 401, "change password needs the current password");
  r = await c3.call("POST", "/api/auth/password", { current: PW, next: PW + "2" });
  ok(r.status === 200, "password can be changed");
  r = await c4.call("GET", "/api/agents");
  ok(r.status === 401, "changing password signs out other devices", r.status);
  r = await makeClient(env).call("POST", "/api/auth/login", { password: PW });
  ok(r.status === 401, "old password no longer works");

  // TOTP
  const c5 = makeClient(env); await c5.call("POST", "/api/auth/login", { password: PW + "2" });
  r = await c5.call("POST", "/api/auth/totp/begin", {});
  ok(r.status === 200 && /^[A-Z2-7]{32}$/.test(r.data.secret), "2FA setup returns an authenticator secret");
  const secret = r.data.secret;
  const sealed = (await env.DB.prepare("SELECT totp_pending FROM owner").first()).totp_pending;
  ok(!sealed.includes(secret), "2FA secret is encrypted at rest");
  const step = Math.floor(Date.now() / 30000);
  r = await c5.call("POST", "/api/auth/totp/enable", { code: "000000" });
  ok(r.status === 401, "2FA enable rejects a wrong code");
  r = await c5.call("POST", "/api/auth/totp/enable", { code: await totpAt(b32decode(secret), step) });
  ok(r.status === 200, "2FA enabled with a valid code");
  const c6 = makeClient(env);
  r = await c6.call("POST", "/api/auth/login", { password: PW + "2" }, { ip: "7.7.7.7" });
  ok(r.status === 401 && r.data.error === "TOTP_REQUIRED", "login now asks for the code");
  r = await c6.call("POST", "/api/auth/login", { password: PW + "2", totp: await totpAt(b32decode(secret), step) }, { ip: "7.7.7.7" });
  ok(r.status === 401 && r.data.error === "BAD_TOTP", "a code already used at enable time cannot be replayed");
  r = await c6.call("POST", "/api/auth/login", { password: PW + "2", totp: await totpAt(b32decode(secret), step + 1) }, { ip: "7.7.7.7" });
  ok(r.status === 200, "next-step code signs in");

  // break-glass reset
  const c7 = makeClient(env);
  r = await c7.call("POST", "/api/auth/reset", { setupToken: "bad".repeat(10), password: "brand new password 77" });
  ok(r.status === 403, "reset rejects a wrong setup token");
  r = await c7.call("POST", "/api/auth/reset", { setupToken: env.SETUP_TOKEN, password: "brand new password 77" });
  ok(r.status === 200, "reset works with the setup token");
  r = await c6.call("GET", "/api/agents");
  ok(r.status === 401, "reset revokes all sessions");
  r = await c7.call("POST", "/api/auth/login", { password: "brand new password 77" });
  ok(r.status === 200, "login works after reset and 2FA is cleared");

  const noToken = makeEnv({ SETUP_TOKEN: undefined });
  r = await makeClient(noToken).call("POST", "/api/auth/setup", { setupToken: "x", password: PW });
  ok(r.status === 503 && r.data.error === "SETUP_TOKEN_NOT_CONFIGURED", "setup is closed if no SETUP_TOKEN secret exists");
}

async function loggedIn(extraEnv = {}, preSql) {
  const env = makeEnv(extraEnv, preSql), c = makeClient(env);
  await c.call("POST", "/api/auth/setup", { setupToken: env.SETUP_TOKEN, password: PW });
  return { env, c };
}

async function testLegacyMigration() {
  const legacy = readFileSync(new URL("./fixtures/legacy_schema.sql", import.meta.url), "utf8");
  const env = makeEnv({}, legacy + `
    INSERT INTO conversations(id,title,created_at,updated_at) VALUES('c1','Old chat','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES('m1','c1','user','hello old data','2026-01-01T00:00:01Z');
    INSERT INTO agents(id,name,role,instructions,status,created_at) VALUES('a1','Old Agent','Helper','be nice','active','2026-01-01T00:00:00Z');
    INSERT INTO tasks(id,title,status,created_at,updated_at) VALUES('t1','Old task','queued','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    INSERT INTO memory(id,content,created_at) VALUES('mem1','I like tea','2026-01-01T00:00:00Z');`);
  const c = makeClient(env);
  await c.call("POST", "/api/auth/setup", { setupToken: env.SETUP_TOKEN, password: PW });
  let r = await c.call("GET", "/api/conversations/c1");
  ok(r.status === 200 && r.data.messages[0].content === "hello old data", "legacy conversation and messages survive migration", r.data);
  r = await c.call("GET", "/api/agents");
  ok(r.data.agents.some((a) => a.id === "a1" && a.instructions === "be nice"), "legacy agent survives with new columns defaulted");
  r = await c.call("GET", "/api/tasks");
  ok(r.data.tasks.find((t) => t.id === "t1").status === "pending", "legacy 'queued' tasks become 'pending'", r.data.tasks);
  r = await c.call("GET", "/api/memory");
  ok(r.data.items.find((m) => m.id === "mem1").category === "general", "legacy memory survives and gets a category");
  r = await c.call("GET", "/api/settings");
  ok(r.status === 200 && typeof r.data.defaultModelKey === "string", "settings works after upgrading the legacy database", r.data);
  const auditColumns = (await env.DB.prepare("PRAGMA table_info(audit_log)").all()).results.map((x) => x.name);
  ok(auditColumns.includes("detail"), "migration additively restores audit_log.detail on a legacy database", auditColumns);
  r = await c.call("DELETE", "/api/conversations/c1");
  ok(r.status === 200, "delete chat works against the legacy database", r.data);
  r = await c.call("GET", "/api/overview");
  ok(r.status === 200, "overview works after delete when audit_log was missing detail", r.data);
  r = await c.call("GET", "/api/audit");
  ok(r.status === 200 && r.data.entries.some((x) => x.action === "conversation_deleted"), "audit log is readable after the column is repaired", r.data);
  r = await c.call("GET", "/api/system/status");
  ok(r.data.schemaVersion === 4 && r.data.warnings.length === 0 && r.data.freeOnly === true, "status reports schema version, no warnings, free-only", r.data);
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).results.map((x) => x.name);
  ok(["conversations", "messages", "agents", "projects", "tasks", "memory", "audit_log", "owner", "sessions", "providers", "models"].every((t) => tables.includes(t)), "all expected tables exist");
  ok(tables.includes("files"), "files table exists");
  const ceo = await env.DB.prepare("SELECT name,instructions FROM agents WHERE id='rahat-ceo'").first();
  ok(ceo && ceo.name === "Rahat CEO" && /strategist/i.test(ceo.role || ceo.instructions || ""), "Rahat CEO agent is seeded", ceo);
  const diag = await c.call("GET", "/api/diagnostics");
  ok(diag.status === 200 && diag.data.ok === true, "diagnostics reports every check passing", diag.data && diag.data.checks.filter((x) => !x.ok));
  ok(diag.data.checks.some((x) => x.name === "Rahat CEO agent" && x.value === 1), "diagnostics sees the CEO agent");
}

async function testCrud() {
  const { c } = await loggedIn();
  let r = await c.call("POST", "/api/projects", { name: "Shop", description: "Sell stuff", goals: "100 sales" });
  const pid = r.data.project.id; ok(r.status === 201, "create project");
  const p2 = (await c.call("POST", "/api/projects", { name: "Blog" })).data.project.id;
  r = await c.call("POST", "/api/agents", { name: "Dev", role: "Developer", instructions: "code well", projectIds: [pid] });
  const aid = r.data.agent.id; ok(r.status === 201, "create agent with project link");
  r = await c.call("GET", "/api/settings");
  ok(r.status === 200 && typeof r.data.defaultModelKey === "string", "settings exposes the automatic default model", r.data);
  r = await c.call("GET", "/api/agents"); ok(r.data.agents[0].project_ids[0] === pid, "agent lists assigned projects");
  r = await c.call("PATCH", `/api/agents/${aid}`, { status: "paused", instructions: "new" });
  ok(r.status === 200, "pause + edit agent");
  r = await c.call("POST", "/api/tasks", { title: "Ship", projectId: pid, agentId: aid, priority: "high" });
  const tid = r.data.task.id; ok(r.status === 201 && r.data.task.status === "pending", "create task defaults to pending");
  r = await c.call("POST", "/api/tasks", { title: "Bad", projectId: "nope" });
  ok(r.status === 400 && r.data.error === "BAD_REFERENCE", "task rejects unknown project");
  r = await c.call("PATCH", `/api/tasks/${tid}`, { status: "bogus" });
  ok(r.status === 400, "task rejects invalid status");
  r = await c.call("PATCH", `/api/tasks/${tid}`, { status: "completed", result: "done" });
  r = await c.call("GET", `/api/tasks?projectId=${pid}`);
  ok(r.data.tasks[0].status === "completed" && r.data.tasks[0].progress === 100 && r.data.tasks[0].completed_at, "completing a task sets progress 100 and completion time");
  r = await c.call("GET", `/api/tasks/${tid}/events`); ok(r.data.events.length >= 2, "task history is recorded");
  r = await c.call("GET", `/api/tasks?projectId=${p2}`); ok(r.data.tasks.length === 0, "project data stays separated");
  r = await c.call("DELETE", `/api/projects/${pid}`); ok(r.status === 400 && r.data.error === "CONFIRM_REQUIRED", "project delete requires typing its name");
  r = await c.call("POST", "/api/memory", { content: "Customers prefer blue packaging", title: "Packaging", category: "business", projectId: pid, tags: "design" });
  const mid = r.data.item.id; ok(r.status === 201, "create memory");
  await c.call("POST", "/api/memory", { content: "Owner likes short answers", category: "personal", pinned: true });
  r = await c.call("GET", "/api/memory?q=packaging"); ok(r.data.items.length === 1, "memory search finds by keyword");
  r = await c.call("PATCH", `/api/memory/${mid}`, { content: "Customers prefer green packaging" }); ok(r.status === 200, "edit memory");
  r = await c.call("DELETE", `/api/projects/${pid}?confirm=Shop`);
  ok(r.status === 200, "project delete with confirmation works");
  r = await c.call("GET", "/api/tasks"); ok(r.data.tasks[0].project_id === null, "deleting a project keeps tasks, unassigned");
  r = await c.call("GET", "/api/overview");
  ok(r.status === 200 && r.data.tasks.completed === 1 && r.data.agents.paused === 1 && r.data.counts.memory === 2, "overview shows real counts", r.data);
  r = await c.call("GET", "/api/agents/templates"); ok(r.data.templates.length === 7, "7 agent templates available");
  r = await c.call("POST", "/api/conversations", { title: "Hi" }); const cid = r.data.conversation.id;
  r = await c.call("PATCH", `/api/conversations/${cid}`, { title: "Renamed", pinned: true }); ok(r.status === 200, "rename + pin conversation");
  r = await c.call("GET", "/api/conversations?q=renam"); ok(r.data.conversations.length === 1, "search conversations by title");
  r = await c.call("DELETE", `/api/conversations/${cid}`); ok(r.status === 200, "delete conversation");
  r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "hi" });
  ok(r.status === 404, "deleted conversation is really gone");
}

const sse = (events) => new ReadableStream({ start(c) { const e = new TextEncoder(); for (const x of events) c.enqueue(e.encode(x + "\n\n")); c.close(); } });
const orModels = { data: [
  { id: "meta/free-one:free", name: "Free One", context_length: 32000, pricing: { prompt: "0", completion: "0", request: "0", image: "0" }, architecture: { output_modalities: ["text"] } },
  { id: "acme/paid-model", name: "Paid", context_length: 8000, pricing: { prompt: "0.000001", completion: "0.000002" } },
  { id: "acme/sneaky", name: "Sneaky request fee", pricing: { prompt: "0", completion: "0", request: "0.01" } },
  { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" } },
  { id: "acme/img:free", name: "Image gen", pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["image"] } },
  { id: "free/two:free", name: "Free Two", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
] };

async function testProviders() {
  const calls = []; const realFetch = globalThis.fetch;
  let mode = "ok";
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.endsWith("/models") && u.includes("openrouter")) return Response.json(orModels);
    if (u.endsWith("/models") && u.includes("groq")) return Response.json({ data: [{ id: "llama-3.3-70b-versatile", context_window: 131072 }, { id: "whisper-large-v3" }, { id: "old-model", active: false }] });
    if (u.endsWith("/chat/completions")) {
      if (mode === "429day") return new Response('{"error":"daily quota exceeded"}', { status: 429 });
      if (mode === "429rate") return new Response("slow down", { status: 429, headers: { "retry-after": "42" } });
      if (mode === "402") return new Response("payment required", { status: 402 });
      if (mode === "401") return new Response("bad key", { status: 401 });
      const body = JSON.parse(init.body);
      if (body.stream) return new Response(sse(['data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}]}', 'data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}', "data: [DONE]"]), { headers: { "content-type": "text/event-stream" } });
      return Response.json({ choices: [{ message: { content: "Hello there" } }], usage: { prompt_tokens: 5, completion_tokens: 3 } });
    }
    throw new Error("unexpected fetch " + u);
  };
  try {
    const { env, c } = await loggedIn({ OPENROUTER_API_KEY: "k-or", GROQ_API_KEY: "k-groq" });
    let r = await c.call("GET", "/api/providers");
    ok(r.data.providers.length === 5 && r.data.providers.every((p) => !p.enabled), "all providers start disabled (free-only by default)");
    r = await c.call("GET", "/api/models"); ok(r.data.total === 0, "model picker lists nothing from disabled providers");

    r = await c.call("PATCH", "/api/providers/openrouter", { enabled: true });
    ok(r.status === 403 && r.data.error === "FREE_NOT_VERIFIED", "cannot enable a provider without confirming free terms", r.data);
    r = await c.call("POST", "/api/providers/openrouter/sync", {});
    ok(r.status === 200 && r.data.stored === 2, "OpenRouter sync stores only verified zero-price chat models", r.data);
    const stored = (await env.DB.prepare("SELECT model_id FROM models WHERE provider_id='openrouter' ORDER BY model_id").all()).results.map((x) => x.model_id);
    ok(stored.join() === "free/two:free,meta/free-one:free", "paid, request-fee, variable-price and image models are excluded", stored);
    r = await c.call("POST", "/api/providers/groq/sync", {});
    ok(r.data.stored === 1, "Groq sync skips non-chat and inactive models", r.data);
    r = await c.call("POST", "/api/models", { providerId: "openrouter", modelId: "acme/paid-model" });
    ok(r.status === 400 && r.data.error === "USE_SYNC", "manual add is blocked for price-verified providers");

    r = await c.call("POST", "/api/conversations", {}); const cid = r.data.conversation.id;
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "hi", modelKey: "openrouter:meta/free-one:free" });
    ok(r.status === 403 && r.data.error === "PROVIDER_DISABLED", "chat is refused while provider is disabled", r.data);
    await c.call("PATCH", "/api/providers/openrouter", { attest: true });
    r = await c.call("PATCH", "/api/providers/openrouter", { enabled: true }); ok(r.status === 200, "provider enables after owner confirms terms");
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "hi", modelKey: "openrouter:acme/paid-model" });
    ok(r.status === 404 && r.data.error === "MODEL_NOT_FOUND", "a paid model is not even in the catalog");
    await env.DB.prepare("INSERT INTO models(key,provider_id,model_id,name,free,status,last_seen_at,created_at) VALUES('openrouter:x/paid','openrouter','x/paid','Paid',0,'active','t','t')").run();
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "hi", modelKey: "openrouter:x/paid" });
    ok(r.status === 403 && r.data.error === "NOT_FREE", "model flagged not-free is blocked by FREE_ONLY", r.data);

    await c.call("POST", "/api/memory", { content: "The owner's favourite colour is teal", title: "Colour" });
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "what is my favourite colour?", modelKey: "openrouter:meta/free-one:free" });
    ok(r.status === 200 && r.data.message.content === "Hello there", "non-streaming chat returns and saves the reply", r.data);
    ok(r.data.context.length === 1 && r.data.context[0].title === "Colour", "relevant memory was retrieved and reported");
    const sent = JSON.parse(calls.filter((x) => x.url.endsWith("/chat/completions")).at(-1).init.body);
    ok(sent.messages[0].content.includes("teal") && sent.provider?.max_price?.prompt === 0, "memory injected into system prompt; OpenRouter max_price guard set to 0", sent.provider);
    ok(calls.at(-1).init.headers.Authorization === "Bearer k-or", "server-side secret used for provider auth");

    const res = await c.raw("POST", `/api/conversations/${cid}/messages`, { content: "stream it", modelKey: "openrouter:meta/free-one:free", stream: true });
    ok((res.headers.get("content-type") || "").includes("text/event-stream"), "streaming chat returns an event stream");
    const text = await res.text(); await c.settle();
    ok(text.includes('"t":"Hel"') && text.includes('"t":"lo"') && text.includes('"done":true'), "stream delivers deltas then done", text);
    r = await c.call("GET", `/api/conversations/${cid}`);
    const last = r.data.messages.at(-1);
    ok(last.role === "assistant" && last.content === "Hello", "streamed reply is saved to D1 after the stream ends", last);
    ok(r.data.conversation.title === "what is my favourite colour?", "conversation auto-titles from the first message", r.data.conversation.title);

    const usage = (await env.DB.prepare("SELECT COUNT(*) n, SUM(tokens_out) t FROM usage_records WHERE ok=1").first());
    ok(usage.n >= 2 && usage.t >= 2, "usage and token counts are recorded", usage);

    mode = "429rate";
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "again", modelKey: "openrouter:meta/free-one:free" });
    ok(r.status === 429 && r.data.error === "RATE_LIMITED" && r.headers.get("retry-after") === "42", "rate limit is explained with Retry-After", r.data);
    mode = "429day";
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "retry", modelKey: "openrouter:meta/free-one:free", retry: true });
    ok(r.status === 429 && r.data.error === "QUOTA_EXHAUSTED", "daily quota exhaustion is reported clearly", r.data);
    const nFetch = calls.length;
    mode = "ok";
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "x", modelKey: "openrouter:meta/free-one:free" });
    ok(r.status === 429 && r.data.error === "PROVIDER_COOLDOWN" && calls.length === nFetch, "after quota exhaustion the provider is paused and not called again", r.data);
    r = await c.call("PATCH", "/api/providers/openrouter", { enabled: true });
    mode = "402";
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "x", modelKey: "openrouter:meta/free-one:free", retry: true });
    ok(r.status === 402 && r.data.error === "QUOTA_EXHAUSTED" && /no paid fallback/i.test(r.data.message), "402 is treated as exhausted, never as a reason to go paid", r.data);
    const used = (await env.DB.prepare("SELECT DISTINCT provider_id FROM usage_records").all()).results.map((x) => x.provider_id);
    ok(used.join() === "openrouter", "no other provider was ever called as a fallback", used);
    await c.call("PATCH", "/api/providers/openrouter", { enabled: true });
    mode = "401";
    r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "x", modelKey: "openrouter:meta/free-one:free", retry: true });
    ok(r.status === 502 && r.data.error === "PROVIDER_AUTH", "invalid key gives a clear error", r.data);

    // attestation cleared => disabled
    await c.call("PATCH", "/api/providers/openrouter", { attest: false });
    r = await c.call("GET", "/api/providers"); ok(!r.data.providers.find((p) => p.id === "openrouter").enabled, "clearing the free-terms confirmation disables the provider");

    // missing secret
    await c.call("PATCH", "/api/providers/groq", { attest: true }); await c.call("PATCH", "/api/providers/groq", { enabled: true });
    const { env: env2, c: c2 } = await loggedIn({ GROQ_API_KEY: undefined });
    globalThis.fetch = async () => Response.json({ data: [] });
    await c2.call("PATCH", "/api/providers/groq", { attest: true }); await c2.call("PATCH", "/api/providers/groq", { enabled: true });
    await env2.DB.prepare("INSERT INTO models(key,provider_id,model_id,name,free,status,last_seen_at,created_at) VALUES('groq:m','groq','m','M',1,'active','t','t')").run();
    const cv = (await c2.call("POST", "/api/conversations", {})).data.conversation.id;
    r = await c2.call("POST", `/api/conversations/${cv}/messages`, { content: "x", modelKey: "groq:m" });
    ok(r.status === 503 && r.data.error === "NO_API_KEY" && r.data.message.includes("GROQ_API_KEY"), "missing secret is reported by name", r.data);
    r = await c2.call("POST", "/api/providers/groq/sync", {}); ok(r.status === 503, "sync without a key explains what to add");
  } finally { globalThis.fetch = realFetch; }
}

async function testWorkersAi() {
  const calls = [];
  const AI = { run: async (model, input) => {
    calls.push({ model, input });
    if (model.includes("quota")) throw new Error("4006: you have used up your daily free allocation of 10,000 neurons");
    if (model.includes("paid")) throw new Error("this model requires a Workers Paid plan");
    if (input.stream) return sse(['data: {"response":"Wor"}', 'data: {"response":"kers"}', "data: [DONE]"]);
    return { response: "pong" };
  } };
  const { env, c } = await loggedIn({ AI });
  await c.call("PATCH", "/api/providers/workersai", { attest: true }); await c.call("PATCH", "/api/providers/workersai", { enabled: true });
  let r = await c.call("GET", "/api/models?provider=workersai"); ok(r.data.total >= 5, "Workers AI seed models appear once enabled", r.data.total);
  const key = "workersai:@cf/meta/llama-3.1-8b-instruct";
  r = await c.call("POST", `/api/models/${encodeURIComponent(key)}/test`, {});
  ok(r.status === 200 && r.data.sample === "pong", "model test works through the AI binding", r.data);
  const cid = (await c.call("POST", "/api/conversations", {})).data.conversation.id;
  const res = await c.raw("POST", `/api/conversations/${cid}/messages`, { content: "stream", modelKey: key, stream: true });
  const text = await res.text(); await c.settle();
  ok(text.includes('"t":"Wor"') && text.includes('"t":"kers"'), "Workers AI streaming deltas are forwarded");
  r = await c.call("GET", `/api/conversations/${cid}`); ok(r.data.messages.at(-1).content === "Workers", "Workers AI streamed reply saved");
  await c.call("POST", "/api/models", { providerId: "workersai", modelId: "@cf/test/quota" });
  r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "x", modelKey: "workersai:@cf/test/quota" });
  ok(r.status === 429 && r.data.error === "QUOTA_EXHAUSTED", "Workers AI daily allocation exhaustion handled", r.data);
  await c.call("PATCH", "/api/providers/workersai", { enabled: true });
  await c.call("POST", "/api/models", { providerId: "workersai", modelId: "@cf/test/paid" });
  r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "x", modelKey: "workersai:@cf/test/paid" });
  ok(r.status === 403 && r.data.error === "NOT_FREE", "a model needing the paid plan is rejected", r.data);
  const flag = await env.DB.prepare("SELECT free FROM models WHERE key='workersai:@cf/test/paid'").first();
  ok(flag.free === 0, "...and permanently flagged not-free so it is never offered again");
}

async function testPaused() {
  const { env, c } = await loggedIn({ AI: { run: async () => ({ response: "ok" }) } });
  await c.call("PATCH", "/api/providers/workersai", { attest: true }); await c.call("PATCH", "/api/providers/workersai", { enabled: true });
  const key = "workersai:@cf/meta/llama-3.1-8b-instruct";
  const a = (await c.call("POST", "/api/agents", { name: "X", role: "Y" })).data.agent.id;
  const cid = (await c.call("POST", "/api/conversations", { agentId: a })).data.conversation.id;
  let r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "hi", modelKey: key });
  ok(r.status === 200, "an active agent can answer", r.data);
  await c.call("PATCH", `/api/agents/${a}`, { status: "paused" });
  r = await c.call("POST", `/api/conversations/${cid}/messages`, { content: "hi again", modelKey: key });
  ok(r.status === 409 && r.data.error === "AGENT_PAUSED", "a paused agent refuses to run", r.data);
  const n = (await env.DB.prepare("SELECT COUNT(*) n FROM messages WHERE role='user'").first()).n;
  ok(n === 1, "a refused request does not save the user message", n);
}

const only = process.argv[2];
const suites = { auth: testAuth, legacy: testLegacyMigration, crud: testCrud, providers: testProviders, workersai: testWorkersAi, paused: testPaused };
for (const [name, fn] of Object.entries(suites)) {
  if (only && only !== name) continue;
  try { await fn(); } catch (e) { fail++; results.push(`FAIL  suite ${name} crashed: ${e && e.stack}`); }
}
console.log(results.join("\n"));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
