// Additive-only schema management. Never drops or rewrites existing tables or rows.
// Works whether D1 is empty, holds the v0.1 foundation schema, or a close variant of it.
import { now } from "./util.js";

export const SCHEMA_VERSION = 1;

export const list = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).all()).results;
export const one = (db, sql, ...b) => db.prepare(sql).bind(...b).first();
export const run = (db, sql, ...b) => db.prepare(sql).bind(...b).run();

const BASE = [
  `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New conversation', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('user','assistant','system')), content TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', requires_approval INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS memory (id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'owner', content TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
];

// Columns added on top of the foundation tables (name -> definition; constant defaults only).
const EXTRA_COLS = {
  conversations: { pinned: "INTEGER NOT NULL DEFAULT 0", agent_id: "TEXT", project_id: "TEXT", model_key: "TEXT" },
  messages: { model_key: "TEXT", tokens_in: "INTEGER", tokens_out: "INTEGER", context_used: "TEXT" },
  agents: { description: "TEXT NOT NULL DEFAULT ''", personality: "TEXT NOT NULL DEFAULT ''", capabilities: "TEXT NOT NULL DEFAULT ''", tools: "TEXT NOT NULL DEFAULT ''", model_key: "TEXT", updated_at: "TEXT" },
  projects: { goals: "TEXT NOT NULL DEFAULT ''", notes: "TEXT NOT NULL DEFAULT ''" },
  tasks: { priority: "TEXT NOT NULL DEFAULT 'normal'", due_at: "TEXT", progress: "INTEGER NOT NULL DEFAULT 0", result: "TEXT NOT NULL DEFAULT ''", completed_at: "TEXT" },
  memory: { category: "TEXT NOT NULL DEFAULT 'general'", title: "TEXT NOT NULL DEFAULT ''", project_id: "TEXT", tags: "TEXT NOT NULL DEFAULT ''", pinned: "INTEGER NOT NULL DEFAULT 0", updated_at: "TEXT" },
  audit_log: { actor: "TEXT", ip_hash: "TEXT" },
};

const NEW_TABLES = [
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL, totp_secret TEXT, totp_pending TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0, totp_last_step INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, password_changed_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, sid TEXT NOT NULL, csrf TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL, idle_expires_at TEXT NOT NULL, ip_hash TEXT, user_agent TEXT)`,
  `CREATE TABLE IF NOT EXISTS login_throttle (key TEXT PRIMARY KEY, fails INTEGER NOT NULL, window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, base_url TEXT, key_env TEXT, free_policy TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, free_attested_at TEXT, cooldown_until INTEGER NOT NULL DEFAULT 0, last_sync_at TEXT, last_sync_note TEXT, custom INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS models (key TEXT PRIMARY KEY, provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE, model_id TEXT NOT NULL, name TEXT NOT NULL, context_length INTEGER, free INTEGER NOT NULL DEFAULT 0, free_basis TEXT, supports_tools INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', favorite INTEGER NOT NULL DEFAULT 0, manual INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage_records (id TEXT PRIMARY KEY, provider_id TEXT, model_key TEXT, ok INTEGER NOT NULL, status INTEGER, error_code TEXT, tokens_in INTEGER, tokens_out INTEGER, latency_ms INTEGER, created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS agent_projects (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, PRIMARY KEY(agent_id, project_id))`,
  `CREATE TABLE IF NOT EXISTS task_events (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, event TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)`,
];

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_project ON memory(project_id)`,
  `CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_models_name ON models(name)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_records(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at)`,
];

export const PRESET_PROVIDERS = [
  { id: "openrouter", name: "OpenRouter", kind: "openai", base_url: "https://openrouter.ai/api/v1", key_env: "OPENROUTER_API_KEY", free_policy: "pricing" },
  { id: "groq", name: "Groq", kind: "openai", base_url: "https://api.groq.com/openai/v1", key_env: "GROQ_API_KEY", free_policy: "tier" },
  { id: "cerebras", name: "Cerebras", kind: "openai", base_url: "https://api.cerebras.ai/v1", key_env: "CEREBRAS_API_KEY", free_policy: "tier" },
  { id: "huggingface", name: "Hugging Face", kind: "openai", base_url: "https://router.huggingface.co/v1", key_env: "HF_TOKEN", free_policy: "credits" },
  { id: "workersai", name: "Cloudflare Workers AI", kind: "workersai", base_url: null, key_env: null, free_policy: "allowlist" },
];
// Seeds only. They are marked unverified; use "Test" in the UI to confirm each one runs on your account.
const WORKERS_AI_SEEDS = [
  ["@cf/meta/llama-3.1-8b-instruct", "Llama 3.1 8B Instruct"],
  ["@cf/meta/llama-3.2-3b-instruct", "Llama 3.2 3B Instruct"],
  ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "Llama 3.3 70B Instruct (fast)"],
  ["@cf/mistralai/mistral-small-3.1-24b-instruct", "Mistral Small 3.1 24B"],
  ["@cf/qwen/qwen2.5-coder-32b-instruct", "Qwen2.5 Coder 32B"],
];

async function ensureCols(db, table, defs) {
  const have = new Set((await list(db, `PRAGMA table_info(${table})`)).map((c) => c.name));
  for (const [c, d] of Object.entries(defs)) {
    if (have.has(c)) continue;
    try { await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${c} ${d}`).run(); }
    catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
  }
}

const cache = new WeakMap();
export function ensureSchema(env) {
  let p = cache.get(env.DB);
  if (!p) { p = migrate(env.DB).catch((e) => { cache.delete(env.DB); throw e; }); cache.set(env.DB, p); }
  return p;
}

async function migrate(db) {
  let v = 0;
  try { const r = await one(db, "SELECT value FROM schema_meta WHERE key='version'"); v = r ? parseInt(r.value, 10) : 0; } catch { /* table not created yet */ }
  if (v >= SCHEMA_VERSION) return;
  for (const s of BASE) await db.prepare(s).run();
  for (const s of NEW_TABLES) await db.prepare(s).run();
  for (const [t, defs] of Object.entries(EXTRA_COLS)) await ensureCols(db, t, defs);
  for (const s of INDEXES) await db.prepare(s).run();
  await run(db, "UPDATE tasks SET status='pending' WHERE status='queued'");
  const t = now();
  for (const p of PRESET_PROVIDERS)
    await run(db, "INSERT OR IGNORE INTO providers(id,name,kind,base_url,key_env,free_policy,enabled,created_at) VALUES(?,?,?,?,?,?,0,?)", p.id, p.name, p.kind, p.base_url, p.key_env, p.free_policy, t);
  for (const [mid, name] of WORKERS_AI_SEEDS)
    await run(db, "INSERT OR IGNORE INTO models(key,provider_id,model_id,name,free,free_basis,status,manual,last_seen_at,created_at) VALUES(?,?,?,?,1,'seed_unverified','active',1,?,?)", "workersai:" + mid, "workersai", mid, name, t, t);
  await run(db, "INSERT INTO schema_meta(key,value) VALUES('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", String(SCHEMA_VERSION));
}

// Reports columns we do not know about that are NOT NULL without a default (would break our INSERTs).
export async function schemaWarnings(db) {
  const known = {
    conversations: ["id", "title", "created_at", "updated_at", ...Object.keys(EXTRA_COLS.conversations)],
    messages: ["id", "conversation_id", "role", "content", "created_at", ...Object.keys(EXTRA_COLS.messages)],
    agents: ["id", "name", "role", "instructions", "status", "created_at", ...Object.keys(EXTRA_COLS.agents)],
    projects: ["id", "name", "description", "status", "created_at", "updated_at", ...Object.keys(EXTRA_COLS.projects)],
    tasks: ["id", "project_id", "agent_id", "title", "details", "status", "requires_approval", "created_at", "updated_at", ...Object.keys(EXTRA_COLS.tasks)],
    memory: ["id", "scope", "content", "created_at", ...Object.keys(EXTRA_COLS.memory)],
    audit_log: ["id", "action", "detail", "created_at", ...Object.keys(EXTRA_COLS.audit_log)],
  };
  const out = [];
  for (const [t, cols] of Object.entries(known)) {
    const k = new Set(cols);
    for (const c of await list(db, `PRAGMA table_info(${t})`))
      if (!k.has(c.name) && c.notnull && c.dflt_value == null && !c.pk) out.push(`${t}.${c.name} is NOT NULL with no default; new rows may fail until it is given a default.`);
  }
  return out;
}

export async function audit(env, action, detail = "", actor = "owner", ipHash = null) {
  try { await run(env.DB, "INSERT INTO audit_log(id,action,detail,created_at,actor,ip_hash) VALUES(?,?,?,?,?,?)", crypto.randomUUID(), action, String(detail).slice(0, 500), now(), actor, ipHash); }
  catch (e) { console.error("audit failed", e && e.message); }
}
