import { HttpError, bad, bool, dateOrNull, int, json, now, oneOf, readJson, sseResponse, str, uid } from "./lib/util.js";
import { audit, list, one, run, schemaWarnings, SCHEMA_VERSION } from "./lib/db.js";
import { deltaOf, generate, loadRoutable, recordSuccess, sseData } from "./llm.js";

const TASK_STATUS = ["pending", "in_progress", "waiting_for_approval", "completed", "failed", "cancelled"];
const PRIORITY = ["low", "normal", "high", "urgent"];
const MEM_CAT = ["personal", "business", "project", "instruction", "decision", "research", "general"];
const PROJ_STATUS = ["active", "paused", "completed", "archived"];

export const AGENT_TEMPLATES = [
  { name: "AI CEO", role: "Strategic planning and coordination", description: "Breaks goals into strategy, priorities and next steps.", instructions: "Think like a pragmatic CEO. Clarify the goal, list options with trade-offs, recommend one, and end with concrete next actions." },
  { name: "Research Agent", role: "Research and information analysis", description: "Gathers and compares information, states uncertainty.", instructions: "Be rigorous. Separate facts from assumptions, say what you could not verify, and never invent sources." },
  { name: "Developer Agent", role: "Software development assistance", description: "Designs, writes and reviews code.", instructions: "Write clear, tested, secure code. Explain trade-offs briefly. Ask before making destructive changes." },
  { name: "Marketing Agent", role: "Marketing strategy and content planning", description: "Positioning, audience and content plans.", instructions: "Be specific about audience and channel. Propose experiments with a measurable goal. Drafts only; the owner publishes." },
  { name: "Business Analyst", role: "Business analysis and reporting", description: "Evaluates opportunities, costs and risks.", instructions: "Structure findings as problem, evidence, options, recommendation. Show assumptions behind every number." },
  { name: "Project Manager", role: "Project and task coordination", description: "Turns plans into tasks with owners and dates.", instructions: "Produce small, verifiable tasks with priority and a definition of done. Never call unfinished work complete." },
  { name: "Creative Agent", role: "Creative concepts and content ideas", description: "Brainstorms concepts, names and stories.", instructions: "Offer varied, original ideas, then help the owner narrow them. Label wild ideas as such." },
];

const enc = new TextEncoder();
const idParam = (s) => { const v = decodeURIComponent(s); if (!v || v.length > 120) throw bad("Bad id."); return v; };
const must = async (db, table, id, what) => { const r = await one(db, `SELECT * FROM ${table} WHERE id=?`, id); if (!r) throw new HttpError(404, "NOT_FOUND", `${what} not found.`); return r; };
const exists = async (db, table, id, what) => { if (id && !(await one(db, `SELECT id FROM ${table} WHERE id=?`, id))) throw bad(`${what} does not exist.`, "BAD_REFERENCE"); };
const sets = (obj) => { const k = Object.keys(obj).filter((x) => obj[x] !== undefined); return { sql: k.map((x) => `${x}=?`).join(","), vals: k.map((x) => obj[x]), n: k.length }; };

function keywords(text) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9\u0980-\u09ff]{3,}/g) || [])].slice(0, 14);
}
export async function relevantMemory(db, text, projectId) {
  const kw = keywords(text);
  const rows = await list(db, "SELECT id,title,content,category,tags,pinned FROM memory WHERE project_id IS NULL OR project_id=? ORDER BY pinned DESC, COALESCE(updated_at,created_at) DESC LIMIT 200", projectId || "");
  return rows.map((r) => {
    const hay = (r.title + " " + r.content + " " + r.tags).toLowerCase();
    return { r, score: kw.reduce((s, k) => s + (hay.includes(k) ? 1 : 0), 0) + (r.pinned ? 0.5 : 0) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 6).map((x) => x.r);
}

function systemPrompt({ agent, project, memories }) {
  const parts = [];
  parts.push(agent ? `You are ${agent.name}, ${agent.role}.${agent.description ? " " + agent.description : ""}` : "You are Rahat DeSecret, a careful AI assistant in a private owner workspace.");
  if (agent?.personality) parts.push("Personality: " + agent.personality);
  if (agent?.instructions) parts.push("Instructions: " + agent.instructions);
  if (project) parts.push(`Project: ${project.name}.${project.description ? " " + project.description : ""}${project.goals ? "\nGoals: " + project.goals : ""}`);
  if (memories.length) parts.push("Saved memory (may be outdated; use only if relevant):\n" + memories.map((m) => `- [${m.category}] ${m.title ? m.title + ": " : ""}${m.content.slice(0, 600)}`).join("\n"));
  parts.push("Be honest about uncertainty. Never claim an external action (sending, publishing, buying, deleting) was done; you can only draft or recommend it.");
  return parts.join("\n\n");
}

async function history(db, cid) {
  const rows = (await list(db, "SELECT role,content FROM messages WHERE conversation_id=? AND role IN ('user','assistant') ORDER BY created_at DESC, rowid DESC LIMIT 24", cid)).reverse();
  let budget = 14000; const out = [];
  for (let i = rows.length - 1; i >= 0; i--) { budget -= rows[i].content.length; if (budget < 0 && out.length) break; out.unshift(rows[i]); }
  return out;
}

async function saveAssistant(env, cid, m, text, usage, ctxUsed) {
  const t = now(), id = uid();
  await run(env.DB, "INSERT INTO messages(id,conversation_id,role,content,created_at,model_key,tokens_in,tokens_out,context_used) VALUES(?,?,?,?,?,?,?,?,?)", id, cid, "assistant", text, t, m.key, usage?.prompt_tokens ?? usage?.input_tokens ?? null, usage?.completion_tokens ?? usage?.output_tokens ?? null, ctxUsed.length ? JSON.stringify(ctxUsed) : null);
  await run(env.DB, "UPDATE conversations SET updated_at=?, model_key=? WHERE id=?", t, m.key, cid);
  return { id, role: "assistant", content: text, created_at: t, model_key: m.key };
}

async function chatRoute(c, cid) {
  const { req, env, ctx } = c, db = env.DB;
  const b = await readJson(req, 100000);
  const content = str(b.content, "Message", { max: 12000 }), stream = b.stream === true, retry = b.retry === true;
  const conv = await must(db, "conversations", cid, "Conversation");
  const settings = await one(db, "SELECT value FROM settings WHERE key='default_model_key'");
  const modelKey = str(b.modelKey, "Model", { max: 300 }) || conv.model_key || (settings && settings.value);
  if (!modelKey) throw new HttpError(400, "NO_MODEL", "Choose a model first.");
  const model = await loadRoutable(env, modelKey); // enforces FREE_ONLY, attestation, key, cooldown
  const agent = conv.agent_id ? await one(db, "SELECT * FROM agents WHERE id=?", conv.agent_id) : null;
  if (agent && agent.status !== "active") throw new HttpError(409, "AGENT_PAUSED", `${agent.name} is paused. Activate it or choose another agent.`);
  const project = conv.project_id ? await one(db, "SELECT * FROM projects WHERE id=?", conv.project_id) : null;

  let userText = content;
  if (retry) {
    const last = await one(db, "SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1", cid);
    if (!last || last.role !== "user") throw bad("Nothing to retry.");
    userText = last.content;
  } else {
    if (!content) throw bad("Message is required.");
    await run(db, "INSERT INTO messages(id,conversation_id,role,content,created_at) VALUES(?,?,?,?,?)", uid(), cid, "user", content, now());
    if (conv.title === "New conversation") await run(db, "UPDATE conversations SET title=? WHERE id=?", content.replace(/\s+/g, " ").slice(0, 48), cid);
  }
  const memories = await relevantMemory(db, userText, conv.project_id);
  const ctxUsed = memories.map((x) => ({ id: x.id, title: x.title || x.content.slice(0, 40), category: x.category }));
  const messages = [{ role: "system", content: systemPrompt({ agent, project, memories }) }, ...(await history(db, cid))];

  if (!stream) {
    const g = await generate(env, model, messages, { signal: req.signal });
    await recordSuccess(env, model, g.usage, g.started);
    return json({ message: await saveAssistant(env, cid, model, g.text, g.usage, ctxUsed), context: ctxUsed });
  }

  const g = await generate(env, model, messages, { stream: true, signal: req.signal });
  let ctrl; const abort = new AbortController();
  const emit = (o) => { try { ctrl.enqueue(enc.encode("data: " + JSON.stringify(o) + "\n\n")); } catch { /* client went away */ } };
  const rs = new ReadableStream({ start(cc) { ctrl = cc; }, cancel() { abort.abort(); } });
  const pump = (async () => {
    let text = "", usage = null, failure = null;
    emit({ meta: { model: model.key, modelName: model.name, context: ctxUsed } });
    try {
      for await (const d of sseData(g.stream)) {
        if (d === "[DONE]") break;
        let o; try { o = JSON.parse(d); } catch { continue; }
        if (o.error) throw new HttpError(502, "PROVIDER_ERROR", "The provider reported an error mid-reply.");
        const t = deltaOf(o); if (t) { text += t; emit({ t }); }
        if (o.usage) usage = o.usage;
        if (abort.signal.aborted) break;
      }
    } catch (e) { failure = e; }
    try {
      let saved = null;
      if (text.trim()) { saved = await saveAssistant(env, cid, model, text, usage, ctxUsed); await recordSuccess(env, model, usage, g.started); }
      if (failure && !text.trim()) emit({ error: { code: failure.code || "PROVIDER_ERROR", message: failure.message || "The reply failed." } });
      else if (!text.trim()) emit({ error: { code: "EMPTY_RESPONSE", message: "The model returned an empty reply." } });
      else emit({ done: true, id: saved.id, partial: !!failure || abort.signal.aborted });
    } finally { try { ctrl.close(); } catch { /* closed */ } }
  })();
  ctx.waitUntil(pump);
  return sseResponse(rs);
}

export async function crudRoutes(c) {
  const { req, env, path, method, url } = c, db = env.DB;
  let m;

  // ---------- overview / system / audit ----------
  if (path === "/api/overview" && method === "GET") {
    const midnight = new Date(); midnight.setUTCHours(0, 0, 0, 0);
    const [tasks, agents, counts, recentConv, recentAudit, usage] = (await db.batch([
      db.prepare("SELECT status, COUNT(*) n FROM tasks GROUP BY status"),
      db.prepare("SELECT status, COUNT(*) n FROM agents GROUP BY status"),
      db.prepare("SELECT (SELECT COUNT(*) FROM projects) projects,(SELECT COUNT(*) FROM conversations) conversations,(SELECT COUNT(*) FROM memory) memory,(SELECT COUNT(*) FROM models WHERE free=1 AND status='active') models,(SELECT COUNT(*) FROM providers WHERE enabled=1) providers"),
      db.prepare("SELECT id,title,updated_at FROM conversations ORDER BY updated_at DESC LIMIT 5"),
      db.prepare("SELECT action,detail,created_at FROM audit_log ORDER BY created_at DESC LIMIT 8"),
      db.prepare("SELECT provider_id, COUNT(*) requests, SUM(ok) ok, SUM(COALESCE(tokens_in,0)+COALESCE(tokens_out,0)) tokens FROM usage_records WHERE created_at>=? GROUP BY provider_id").bind(midnight.toISOString()),
    ])).map((r) => r.results);
    const by = (rows) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
    const settings = await one(db, "SELECT value FROM settings WHERE key='default_model_key'");
    return json({ tasks: by(tasks), agents: by(agents), counts: counts[0], recentConversations: recentConv, recentActivity: recentAudit, usageToday: usage, defaultModelKey: settings ? settings.value : "" });
  }
  if (path === "/api/system/status" && method === "GET") {
    const v = await one(db, "SELECT value FROM schema_meta WHERE key='version'");
    return json({ app: "Rahat DeSecret", version: "0.3.0", schemaVersion: v ? +v.value : 0, expectedSchemaVersion: SCHEMA_VERSION, warnings: await schemaWarnings(db), freeOnly: true, bindings: { db: true, ai: !!env.AI }, setupTokenConfigured: !!(env.SETUP_TOKEN && env.SETUP_TOKEN.length >= 24) });
  }
  if (path === "/api/audit" && method === "GET") {
    const limit = Math.min(200, parseInt(url.searchParams.get("limit") || "50", 10) || 50);
    return json({ entries: await list(db, "SELECT action,detail,actor,created_at FROM audit_log ORDER BY created_at DESC LIMIT ?", limit) });
  }

  // ---------- conversations ----------
  if (path === "/api/conversations" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    const rows = q
      ? await list(db, "SELECT id,title,pinned,updated_at,model_key,agent_id,project_id FROM conversations WHERE title LIKE ? ESCAPE '\\' ORDER BY pinned DESC, updated_at DESC LIMIT 100", "%" + q.replace(/[\\%_]/g, "\\$&") + "%")
      : await list(db, "SELECT id,title,pinned,updated_at,model_key,agent_id,project_id FROM conversations ORDER BY pinned DESC, updated_at DESC LIMIT 100");
    return json({ conversations: rows });
  }
  if (path === "/api/conversations" && method === "POST") {
    const b = await readJson(req), id = uid(), t = now();
    const agentId = b.agentId || null, projectId = b.projectId || null;
    await exists(db, "agents", agentId, "Agent"); await exists(db, "projects", projectId, "Project");
    await run(db, "INSERT INTO conversations(id,title,created_at,updated_at,model_key,agent_id,project_id) VALUES(?,?,?,?,?,?,?)", id, str(b.title, "Title", { max: 120 }) || "New conversation", t, t, str(b.modelKey, "Model", { max: 300 }) || null, agentId, projectId);
    return json({ conversation: await one(db, "SELECT id,title,pinned,updated_at,model_key,agent_id,project_id FROM conversations WHERE id=?", id) }, 201);
  }
  m = path.match(/^\/api\/conversations\/([^/]+)$/);
  if (m) {
    const id = idParam(m[1]);
    if (method === "GET") {
      const conv = await must(db, "conversations", id, "Conversation");
      const msgs = (await list(db, "SELECT id,role,content,created_at,model_key,context_used FROM messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200", id)).reverse();
      return json({ conversation: conv, messages: msgs.map((x) => ({ ...x, context_used: x.context_used ? JSON.parse(x.context_used) : null })) });
    }
    if (method === "PATCH") {
      await must(db, "conversations", id, "Conversation");
      const b = await readJson(req);
      const f = { title: str(b.title, "Title", { min: 1, max: 120 }), pinned: b.pinned === undefined ? undefined : (bool(b.pinned, "pinned") ? 1 : 0), model_key: b.modelKey === undefined ? undefined : (b.modelKey === null ? null : str(b.modelKey, "Model", { max: 300 })), agent_id: b.agentId, project_id: b.projectId };
      await exists(db, "agents", f.agent_id, "Agent"); await exists(db, "projects", f.project_id, "Project");
      const s = sets(f); if (!s.n) return json({ ok: true });
      await run(db, `UPDATE conversations SET ${s.sql} WHERE id=?`, ...s.vals, id);
      return json({ ok: true });
    }
    if (method === "DELETE") { await must(db, "conversations", id, "Conversation"); await run(db, "DELETE FROM conversations WHERE id=?", id); await audit(env, "conversation_deleted", id); return json({ ok: true }); }
  }
  m = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (m && method === "POST") return chatRoute(c, idParam(m[1]));

  // ---------- agents ----------
  if (path === "/api/agents/templates" && method === "GET") return json({ templates: AGENT_TEMPLATES });
  if (path === "/api/agents" && method === "GET") {
    const rows = await list(db, "SELECT * FROM agents ORDER BY created_at DESC");
    const links = await list(db, "SELECT agent_id, project_id FROM agent_projects");
    return json({ agents: rows.map((a) => ({ ...a, project_ids: links.filter((l) => l.agent_id === a.id).map((l) => l.project_id) })) });
  }
  const agentFields = (b) => ({ name: str(b.name, "Name", { max: 60 }), role: str(b.role, "Role", { max: 80 }), description: str(b.description, "Description", { max: 400 }), instructions: str(b.instructions, "Instructions", { max: 4000 }), personality: str(b.personality, "Personality", { max: 600 }), capabilities: str(b.capabilities, "Capabilities", { max: 600 }), tools: str(b.tools, "Tools", { max: 300 }), model_key: b.modelKey === undefined ? undefined : (b.modelKey || null) });
  const linkProjects = async (agentId, ids) => {
    if (!Array.isArray(ids)) return;
    for (const p of ids) await exists(db, "projects", p, "Project");
    await run(db, "DELETE FROM agent_projects WHERE agent_id=?", agentId);
    for (const p of ids.slice(0, 50)) await run(db, "INSERT OR IGNORE INTO agent_projects(agent_id,project_id) VALUES(?,?)", agentId, p);
  };
  if (path === "/api/agents" && method === "POST") {
    const b = await readJson(req), f = agentFields(b);
    if (!f.name || !f.role) throw bad("Name and role are required.");
    const id = uid(), t = now();
    await run(db, "INSERT INTO agents(id,name,role,instructions,status,created_at,description,personality,capabilities,tools,model_key,updated_at) VALUES(?,?,?,?,'active',?,?,?,?,?,?,?)", id, f.name, f.role, f.instructions || "", t, f.description || "", f.personality || "", f.capabilities || "", f.tools || "", f.model_key || null, t);
    await linkProjects(id, b.projectIds); await audit(env, "agent_created", f.name);
    return json({ agent: await one(db, "SELECT * FROM agents WHERE id=?", id) }, 201);
  }
  m = path.match(/^\/api\/agents\/([^/]+)$/);
  if (m) {
    const id = idParam(m[1]);
    if (method === "PATCH") {
      const a = await must(db, "agents", id, "Agent"), b = await readJson(req);
      const f = { ...agentFields(b), status: oneOf(b.status, "Status", ["active", "paused"]), updated_at: now() };
      const s = sets(f); await run(db, `UPDATE agents SET ${s.sql} WHERE id=?`, ...s.vals, id);
      await linkProjects(id, b.projectIds);
      if (b.status && b.status !== a.status) await audit(env, "agent_" + b.status, a.name);
      return json({ ok: true });
    }
    if (method === "DELETE") { const a = await must(db, "agents", id, "Agent"); await run(db, "DELETE FROM agents WHERE id=?", id); await audit(env, "agent_deleted", a.name); return json({ ok: true }); }
  }

  // ---------- projects ----------
  if (path === "/api/projects" && method === "GET") {
    return json({ projects: await list(db, "SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id) task_count, (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status='completed') done_count FROM projects p ORDER BY p.updated_at DESC") });
  }
  if (path === "/api/projects" && method === "POST") {
    const b = await readJson(req), id = uid(), t = now();
    await run(db, "INSERT INTO projects(id,name,description,status,created_at,updated_at,goals,notes) VALUES(?,?,?,'active',?,?,?,?)", id, str(b.name, "Name", { req: true, max: 100 }), str(b.description, "Description", { max: 3000 }) || "", t, t, str(b.goals, "Goals", { max: 3000 }) || "", str(b.notes, "Notes", { max: 8000 }) || "");
    await audit(env, "project_created", b.name);
    return json({ project: await one(db, "SELECT * FROM projects WHERE id=?", id) }, 201);
  }
  m = path.match(/^\/api\/projects\/([^/]+)$/);
  if (m) {
    const id = idParam(m[1]);
    if (method === "PATCH") {
      await must(db, "projects", id, "Project"); const b = await readJson(req);
      const s = sets({ name: str(b.name, "Name", { min: 1, max: 100 }), description: str(b.description, "Description", { max: 3000 }), goals: str(b.goals, "Goals", { max: 3000 }), notes: str(b.notes, "Notes", { max: 8000 }), status: oneOf(b.status, "Status", PROJ_STATUS), updated_at: now() });
      await run(db, `UPDATE projects SET ${s.sql} WHERE id=?`, ...s.vals, id);
      return json({ ok: true });
    }
    if (method === "DELETE") {
      const p = await must(db, "projects", id, "Project");
      if (url.searchParams.get("confirm") !== p.name) throw new HttpError(400, "CONFIRM_REQUIRED", "Type the project name to confirm deleting it. Its tasks stay but become unassigned.");
      await run(db, "UPDATE memory SET project_id=NULL WHERE project_id=?", id);
      await run(db, "DELETE FROM projects WHERE id=?", id); await audit(env, "project_deleted", p.name);
      return json({ ok: true });
    }
  }

  // ---------- tasks ----------
  if (path === "/api/tasks" && method === "GET") {
    const w = [], bind = [];
    for (const [qp, col] of [["projectId", "project_id"], ["agentId", "agent_id"], ["status", "status"]]) { const v = url.searchParams.get(qp); if (v) { w.push(`${col}=?`); bind.push(v); } }
    return json({ tasks: await list(db, `SELECT * FROM tasks ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'waiting_for_approval' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, COALESCE(due_at,'9999') LIMIT 300`, ...bind) });
  }
  const taskEvent = (id, event, detail = "") => run(db, "INSERT INTO task_events(id,task_id,event,detail,created_at) VALUES(?,?,?,?,?)", uid(), id, event, detail, now());
  if (path === "/api/tasks" && method === "POST") {
    const b = await readJson(req), id = uid(), t = now();
    await exists(db, "projects", b.projectId, "Project"); await exists(db, "agents", b.agentId, "Agent");
    await run(db, "INSERT INTO tasks(id,project_id,agent_id,title,details,status,requires_approval,created_at,updated_at,priority,due_at,progress) VALUES(?,?,?,?,?,'pending',0,?,?,?,?,0)", id, b.projectId || null, b.agentId || null, str(b.title, "Title", { req: true, max: 160 }), str(b.details, "Details", { max: 5000 }) || "", t, t, oneOf(b.priority, "Priority", PRIORITY) || "normal", dateOrNull(b.dueAt, "Due date") || null);
    await taskEvent(id, "created"); await audit(env, "task_created", b.title);
    return json({ task: await one(db, "SELECT * FROM tasks WHERE id=?", id) }, 201);
  }
  m = path.match(/^\/api\/tasks\/([^/]+)(\/events)?$/);
  if (m) {
    const id = idParam(m[1]);
    if (m[2] && method === "GET") return json({ events: await list(db, "SELECT event,detail,created_at FROM task_events WHERE task_id=? ORDER BY created_at DESC LIMIT 100", id) });
    if (!m[2] && method === "PATCH") {
      const tk = await must(db, "tasks", id, "Task"), b = await readJson(req);
      await exists(db, "projects", b.projectId, "Project"); await exists(db, "agents", b.agentId, "Agent");
      const status = oneOf(b.status, "Status", TASK_STATUS);
      const f = { title: str(b.title, "Title", { min: 1, max: 160 }), details: str(b.details, "Details", { max: 5000 }), status, priority: oneOf(b.priority, "Priority", PRIORITY), due_at: dateOrNull(b.dueAt, "Due date"), progress: int(b.progress, "Progress", { max: 100 }), result: str(b.result, "Result", { max: 5000 }), project_id: b.projectId, agent_id: b.agentId, updated_at: now() };
      if (status === "completed") { f.progress = 100; f.completed_at = now(); } else if (status && tk.status === "completed") f.completed_at = null;
      const s = sets(f); await run(db, `UPDATE tasks SET ${s.sql} WHERE id=?`, ...s.vals, id);
      if (status && status !== tk.status) await taskEvent(id, "status", `${tk.status} -> ${status}`);
      return json({ ok: true });
    }
    if (!m[2] && method === "DELETE") { const tk = await must(db, "tasks", id, "Task"); await run(db, "DELETE FROM tasks WHERE id=?", id); await audit(env, "task_deleted", tk.title); return json({ ok: true }); }
  }

  // ---------- memory ----------
  if (path === "/api/memory" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80), w = [], bind = [];
    const cat = url.searchParams.get("category"), pid = url.searchParams.get("projectId");
    if (cat) { w.push("category=?"); bind.push(cat); }
    if (pid) { w.push("project_id=?"); bind.push(pid); }
    if (q) { w.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')"); const l = "%" + q.replace(/[\\%_]/g, "\\$&") + "%"; bind.push(l, l, l); }
    return json({ items: await list(db, `SELECT * FROM memory ${w.length ? "WHERE " + w.join(" AND ") : ""} ORDER BY pinned DESC, COALESCE(updated_at,created_at) DESC LIMIT 200`, ...bind), categories: MEM_CAT });
  }
  if (path === "/api/memory" && method === "POST") {
    const b = await readJson(req), id = uid(), t = now();
    await exists(db, "projects", b.projectId, "Project");
    await run(db, "INSERT INTO memory(id,scope,content,created_at,category,title,project_id,tags,pinned,updated_at) VALUES(?,'owner',?,?,?,?,?,?,?,?)", id, str(b.content, "Content", { req: true, max: 5000 }), t, oneOf(b.category, "Category", MEM_CAT) || "general", str(b.title, "Title", { max: 120 }) || "", b.projectId || null, str(b.tags, "Tags", { max: 200 }) || "", bool(b.pinned, "pinned") ? 1 : 0, t);
    return json({ item: await one(db, "SELECT * FROM memory WHERE id=?", id) }, 201);
  }
  m = path.match(/^\/api\/memory\/([^/]+)$/);
  if (m) {
    const id = idParam(m[1]);
    if (method === "PATCH") {
      await must(db, "memory", id, "Memory"); const b = await readJson(req);
      await exists(db, "projects", b.projectId, "Project");
      const s = sets({ content: str(b.content, "Content", { min: 1, max: 5000 }), title: str(b.title, "Title", { max: 120 }), category: oneOf(b.category, "Category", MEM_CAT), tags: str(b.tags, "Tags", { max: 200 }), pinned: b.pinned === undefined ? undefined : (bool(b.pinned, "pinned") ? 1 : 0), project_id: b.projectId, updated_at: now() });
      await run(db, `UPDATE memory SET ${s.sql} WHERE id=?`, ...s.vals, id);
      return json({ ok: true });
    }
    if (method === "DELETE") { await must(db, "memory", id, "Memory"); await run(db, "DELETE FROM memory WHERE id=?", id); await audit(env, "memory_deleted", id); return json({ ok: true }); }
  }
  return null;
}
