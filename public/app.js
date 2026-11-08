import { md } from "./md.js";

/* ---------- tiny DOM kit ---------- */
const NS = "http://www.w3.org/2000/svg";
const ICON = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10", chat: "M4 5h16v11H9l-5 4z", folder: "M3 6h6l2 2h10v11H3z", check: "M4 12l5 5L20 6",
  bot: "M6 8h12v10H6zM12 8V4M9 13h.01M15 13h.01", book: "M5 4h11a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h11",
  cpu: "M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM4 12h2M18 12h2M12 4v2M12 18v2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M17.7 6.3l-1.4 1.4M7.7 16.3l-1.4 1.4",
  menu: "M4 7h16M4 12h16M4 17h16", plus: "M12 5v14M5 12h14", send: "M4 12l16-8-6 16-3-7z", stop: "M7 7h10v10H7z",
  star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z", search: "M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5",
  trash: "M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13", x: "M6 6l12 12M18 6L6 18", pin: "M9 4h6l-1 6 3 3H7l3-3zM12 13v7", more: "M5 12h.01M12 12h.01M19 12h.01",
  disk: "M4 6h16v12H4zM8 10h8M8 14h5",
};
function svg(name, cls = "icon") {
  const s = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", class: cls, fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) s.setAttribute(k, v);
  const p = document.createElementNS(NS, "path"); p.setAttribute("d", ICON[name]); s.append(p); return s;
}
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "for") e.htmlFor = v;
    else if (["value", "checked", "disabled", "hidden", "selected"].includes(k)) e[k] = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) { if (c === undefined || c === null || c === false) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return e;
}
const $ = (s, r = document) => r.querySelector(s);
const btn = (label, props = {}, icon) => h("button", { type: "button", ...props, class: "btn " + (props.class || "") }, icon ? svg(icon) : null, label);

function toast(msg, kind = "") {
  const t = h("div", { class: "toast " + kind, role: "status" }, msg);
  $("#toasts").append(t); setTimeout(() => t.remove(), kind === "bad" ? 6000 : 3200);
}
const ago = (iso) => {
  if (!iso) return ""; const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago"; if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n ?? 0));
const BASIS = { pricing_zero: "price verified $0", provider_free_tier: "provider free tier", monthly_credits: "monthly free credits", manual: "added by you", seed_unverified: "unverified, press Test" };

/* ---------- state + API ---------- */
const S = { csrf: "", modelNames: {}, defaultModelKey: "", abort: null, chat: null };
class ApiError extends Error { constructor(d, status) { super(d.message || d.error || "Request failed"); this.code = d.error; this.status = status; this.data = d; } }
async function api(path, { method = "GET", body } = {}) {
  const headers = {}; const opts = { method, headers, credentials: "same-origin" };
  if (body !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  if (method !== "GET") headers["X-CSRF-Token"] = S.csrf;
  const res = await fetch("/api" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/auth/login") && !path.startsWith("/auth/password") && !path.startsWith("/auth/totp")) { S.csrf = ""; boot(); throw new ApiError(data, 401); }
  if (!res.ok) throw new ApiError(data, res.status);
  return data;
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { if (e.status !== 401) toast(e.message, "bad"); } };

/* ---------- dialogs ---------- */
function openDialog(content, cls = "") {
  const dlg = h("dialog", { class: cls }, h("div", { class: "sheet-in" }, content));
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg); dlg.showModal(); return dlg;
}
function formDialog({ title, fields, values = {}, submit = "Save", extra = [], onSubmit }) {
  return new Promise((resolve) => {
    const err = h("p", { class: "err", role: "alert" });
    const form = h("form", { class: "stack", novalidate: true });
    const inputs = {};
    for (const f of fields) {
      let input;
      const v = values[f.name] ?? f.default ?? "";
      if (f.type === "textarea") input = h("textarea", { name: f.name, rows: f.rows || 4, maxlength: f.max, value: v });
      else if (f.type === "select") { input = h("select", { name: f.name }, (f.options || []).map(([val, lab]) => h("option", { value: val, selected: String(val) === String(v) }, lab))); if (f.onChange) input.addEventListener("change", () => f.onChange(input.value, inputs)); }
      else if (f.type === "checkbox") input = h("input", { type: "checkbox", name: f.name, checked: !!v });
      else input = h("input", { type: f.type || "text", name: f.name, value: v, maxlength: f.max, autocomplete: f.type === "password" ? "off" : "off", inputmode: f.inputmode });
      inputs[f.name] = input;
      form.append(f.type === "checkbox"
        ? h("label", { class: "check" }, input, h("span", {}, f.label))
        : h("label", { class: "field" }, h("span", {}, f.label), input, f.hint ? h("div", { class: "hint" }, f.hint) : null));
    }
    let dlg;
    const done = h("button", { type: "submit", class: "btn primary" }, submit);
    form.append(err, h("div", { class: "sheet-foot" }, extra, btn("Cancel", { class: "ghost", onclick: () => dlg.close() }), done));
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = ""; done.disabled = true;
      const out = {};
      for (const f of fields) { const i = inputs[f.name]; out[f.name] = f.type === "checkbox" ? i.checked : i.value; }
      try { await onSubmit(out); resolve(true); dlg.close(); } catch (ex) { err.textContent = ex.message; done.disabled = false; }
    });
    dlg = openDialog([h("div", { class: "sheet-head" }, h("h2", { class: "grow" }, title)), form]);
    dlg.addEventListener("close", () => resolve(false));
    setTimeout(() => form.querySelector("input,textarea,select")?.focus(), 30);
  });
}
const confirmType = (what, name, onOk) => formDialog({ title: `Delete ${what}`, submit: "Delete", fields: [{ name: "c", label: `Type "${name}" to confirm`, hint: "This cannot be undone." }], onSubmit: async (v) => { if (v.c.trim() !== name) throw new Error("The name does not match."); await onOk(); } });
function confirmBox(msg, label, onOk) {
  return new Promise((resolve) => {
    let dlg; dlg = openDialog([h("p", {}, msg), h("div", { class: "sheet-foot" }, btn("Cancel", { class: "ghost", onclick: () => dlg.close() }), btn(label, { class: "danger", onclick: async () => { try { await onOk(); dlg.close(); resolve(true); } catch (e) { toast(e.message, "bad"); } } }))]);
    dlg.addEventListener("close", () => resolve(false));
  });
}

/* ---------- auth ---------- */
async function boot() {
  const app = $("#app"); app.className = ""; document.body.classList.remove("in");
  let st;
  try { st = await (await fetch("/api/auth/session", { credentials: "same-origin" })).json(); }
  catch { app.replaceChildren(h("div", { class: "boot" }, "Cannot reach the server. Check your connection.")); return; }
  if (st.authenticated) { S.csrf = st.csrf; return startShell(); }
  showAuth(st.setupRequired ? "setup" : "login", st);
}
function showAuth(mode, st = {}) {
  const app = $("#app"); const err = h("p", { class: "err", role: "alert" });
  const f = (name, label, type = "password", extra = {}) => h("label", { class: "field" }, h("span", {}, label), h("input", { name, type, autocomplete: type === "password" ? (mode === "login" ? "current-password" : "new-password") : "off", required: true, ...extra }));
  const titles = { setup: ["Create your owner account", "This workspace is private. Enter the setup token you saved as a Worker secret, then choose a password."], login: ["Sign in", "Owner access only."], reset: ["Reset password", "Use your setup token to set a new password. Two-step sign-in is turned off and every device is signed out."] };
  const fields = mode === "setup" ? [f("setupToken", "Setup token", "password"), f("password", "Password (12+ characters)"), f("confirm", "Confirm password")]
    : mode === "reset" ? [f("setupToken", "Setup token"), f("password", "New password (12+ characters)"), f("confirm", "Confirm password")]
    : [f("password", "Password"), h("label", { class: "field", hidden: true, id: "totpBox" }, h("span", {}, "Authenticator code"), h("input", { name: "totp", type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", pattern: "[0-9]*" }))];
  const submit = h("button", { class: "btn primary", type: "submit" }, mode === "setup" ? "Create account" : mode === "reset" ? "Reset password" : "Sign in");
  const form = h("form", { class: "stack" },
    h("div", { class: "logo" }, "Rahat DeSecret"), h("h1", {}, titles[mode][0]), h("p", { class: "muted" }, titles[mode][1]), fields, err, submit,
    mode === "login" ? h("button", { type: "button", class: "btn ghost sm", onclick: () => showAuth("reset", st) }, "Forgot password") : h("button", { type: "button", class: "btn ghost sm", onclick: () => showAuth(st.setupRequired ? "setup" : "login", st) }, mode === "reset" ? "Back to sign in" : ""));
  form.addEventListener("submit", async (e) => {
    e.preventDefault(); err.textContent = ""; submit.disabled = true;
    const v = Object.fromEntries(new FormData(form));
    try {
      if ((mode === "setup" || mode === "reset") && v.password !== v.confirm) throw new Error("The passwords do not match.");
      if (mode === "reset") { await api("/auth/reset", { method: "POST", body: { setupToken: v.setupToken, password: v.password } }); toast("Password reset. Sign in with the new one.", "ok"); return showAuth("login", st); }
      const r = await api("/auth/" + mode, { method: "POST", body: mode === "setup" ? { setupToken: v.setupToken, password: v.password } : { password: v.password, totp: v.totp || undefined } });
      S.csrf = r.csrf; startShell();
    } catch (ex) {
      if (ex.code === "TOTP_REQUIRED") { $("#totpBox").hidden = false; $("#totpBox input").required = true; $("#totpBox input").focus(); err.textContent = ex.message; }
      else err.textContent = ex.message + (ex.data?.retryAfter ? ` (about ${Math.ceil(ex.data.retryAfter / 60)} min)` : "");
      submit.disabled = false;
    }
  });
  app.replaceChildren(h("div", { class: "auth" }, form));
  form.querySelector("input")?.focus();
}

/* ---------- shell + router ---------- */
// v0.4: chat is home. Tasks and Models are no longer main navigation (reachable from Settings).
const NAV = [["chat", "Chat", "chat"], ["projects", "Projects", "folder"], ["agents", "Agents", "bot"], ["memory", "Memory", "book"], ["files", "Files", "disk"], ["settings", "Settings", "gear"]];
const BOTTOM = ["chat", "agents", "files", "projects"];
const DEFAULT_AGENT = "rahat-ceo";
async function startShell() {
  const app = $("#app");
  const link = ([id, label, icon]) => h("a", { class: "nav-item", href: "#/" + id, "data-nav": id }, svg(icon), label);
  const more = h("button", { type: "button", class: "nav-item", onclick: openMore, "data-nav": "more" }, svg("more"), "More");
  app.replaceChildren(h("div", { class: "shell" },
    h("header", { class: "top" },
      h("div", { class: "brand" }, "rahatdesecret"),
      h("nav", { class: "rail", "aria-label": "Main" }, NAV.map(link))),
    h("main", { class: "main" }, h("div", { class: "view", id: "view" })),
    h("nav", { class: "bottom", "aria-label": "Main" }, NAV.filter((n) => BOTTOM.includes(n[0])).map(link), more)));
  // v0.4: no longer depends on /api/overview, which was the endpoint failing with a 500.
  try { const st = await api("/settings"); S.defaultModelKey = st.defaultModelKey || (st.settings && st.settings.default_model_key) || ""; } catch { /* chat shows it */ }
  if (!location.hash || location.hash === "#/home" || location.hash === "#/") location.hash = "#/chat";
  route();
}
function openMore() {
  let dlg;
  const item = (id, label, icon) => h("a", { class: "item click", href: "#/" + id, onclick: () => dlg.close() }, svg(icon), h("span", { class: "title" }, label));
  dlg = openDialog([h("h2", {}, "More"), h("div", { class: "list" }, item("projects", "Projects", "folder"), item("agents", "Agents", "bot"), item("memory", "Memory", "book"), item("files", "Files", "disk"), item("settings", "Settings", "gear")), h("div", { class: "sheet-foot" }, btn("Close", { class: "ghost", onclick: () => dlg.close() }))]);
}
const VIEWS = {};
async function route() {
  if (!S.csrf) return;
  const [, raw = "chat", arg] = location.hash.slice(1).split("/");
  const name = raw === "home" ? "chat" : raw;
  const id = VIEWS[name] ? name : "chat";
  if (S.abort) { S.abort.abort(); S.abort = null; }
  document.querySelectorAll("[data-nav]").forEach((a) => (id === a.dataset.nav ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
  const el = $("#view"); el.className = "view"; el.replaceChildren(h("p", { class: "muted" }, "Loading"));
  try { await VIEWS[id](el, arg); } catch (e) { if (e.status !== 401) el.replaceChildren(h("div", { class: "page" }, h("div", { class: "notice bad" }, e.message))); }
}
window.addEventListener("hashchange", route);

/* ---------- model bench (picker) ---------- */
function pickModel({ onPick, title = "Choose a model" } = {}) {
  return new Promise(async (resolve) => {
    let q = "", prov = "", fav = false, offset = 0, total = 0, dlg, timer;
    const list = h("div", { class: "scroll" }), count = h("span", { class: "muted small" }), chips = h("div", { class: "chips" });
    const more = btn("Show more", { class: "sm", onclick: () => load(false) });
    const search = h("input", { type: "search", placeholder: "Search by name or id", "aria-label": "Search models", oninput: () => { clearTimeout(timer); timer = setTimeout(() => { q = search.value.trim(); load(true); }, 250); } });
    const row = (m) => {
      const star = h("button", { type: "button", class: "star", "aria-pressed": String(m.favorite), "aria-label": "Favorite", onclick: guard(async (e) => { e.stopPropagation(); m.favorite = !m.favorite; star.setAttribute("aria-pressed", String(m.favorite)); await api("/models/" + encodeURIComponent(m.key), { method: "PATCH", body: { favorite: m.favorite } }); }) }, svg("star"));
      return h("div", { class: "mrow", role: "button", tabindex: "0", onclick: () => { S.modelNames[m.key] = m.name; resolve(m); dlg.close(); if (onPick) onPick(m); }, onkeydown: (e) => { if (e.key === "Enter") e.currentTarget.click(); } },
        h("div", { class: "grow" }, h("div", { class: "nm" }, m.name), h("div", { class: "small muted" }, [m.providerName, m.context ? `${fmtN(m.context)} context` : null, m.tools ? "tools" : null].filter(Boolean).join(", "))),
        h("span", { class: "badge free", title: BASIS[m.basis] || "" }, "free"), star);
    };
    async function load(reset) {
      if (reset) { offset = 0; list.replaceChildren(); }
      const p = new URLSearchParams({ q, provider: prov, limit: "40", offset: String(offset) }); if (fav) p.set("favorites", "1");
      try {
        const r = await api("/models?" + p); total = r.total; r.models.forEach((m) => list.append(row(m))); offset += r.models.length;
      } catch (e) { list.replaceChildren(h("p", { class: "err" }, e.message)); return; }
      more.hidden = offset >= total; count.textContent = `${total} free ${total === 1 ? "model" : "models"}`;
      if (!total && reset) list.replaceChildren(h("div", { class: "empty" }, h("b", {}, q || prov || fav ? "No matches" : "No free models yet"), q || prov || fav ? "Try a different search or filter." : "Turn on a provider in Models, then sync its catalog.", h("div", { class: "section" }, q || prov || fav ? null : btn("Open Models", { class: "primary", onclick: () => { dlg.close(); location.hash = "#/models"; } }))));
    }
    const mkChip = (label, on, pressed) => h("button", { type: "button", class: "chip", "aria-pressed": String(pressed), onclick: () => { on(); paintChips(); load(true); } }, label);
    let provs = [];
    function paintChips() {
      chips.replaceChildren(mkChip("All", () => { prov = ""; fav = false; }, !prov && !fav), mkChip("Favorites", () => { fav = !fav; prov = ""; }, fav), ...provs.map((p) => mkChip(p.name, () => { prov = p.id; fav = false; }, prov === p.id)));
    }
    dlg = openDialog([h("div", { class: "sheet-head" }, h("h2", { class: "grow" }, title), btn("", { class: "ghost sm", "aria-label": "Close", onclick: () => dlg.close() }, "x")), search, chips, count, list, h("div", { class: "sheet-foot" }, more)], "tall");
    dlg.addEventListener("close", () => resolve(null));
    try { provs = (await api("/providers")).providers.filter((p) => p.enabled && p.modelCount > 0); } catch { /* chips optional */ }
    paintChips(); load(true);
  });
}
const modelLabel = (key) => (key ? S.modelNames[key] || key.split(":").slice(1).join(":") : "Choose a model");

/* ---------- Home ---------- */
VIEWS.home = async (el) => {
  const [o, pv] = await Promise.all([api("/overview"), api("/providers")]);
  const on = pv.providers.filter((p) => p.enabled);
  const t = o.tasks, ts = (k) => t[k] || 0, total = Object.values(t).reduce((a, b) => a + b, 0);
  const kv = (rows) => h("dl", { class: "kv" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  S.defaultModelKey = o.defaultModelKey || S.defaultModelKey;
  el.replaceChildren(h("div", { class: "page" },
    h("div", { class: "head" }, h("h1", { class: "grow" }, "Workspace"), btn("New chat", { class: "primary", onclick: () => (location.hash = "#/chat") }, "plus")),
    on.length ? null : h("div", { class: "notice" }, h("b", {}, "No AI provider is turned on yet. "), "Chat needs one. ", h("a", { href: "#/models" }, "Set up a free provider")),
    h("div", { class: "cols" },
      h("div", {}, h("h2", {}, "AI right now"), kv([["Default model", S.defaultModelKey ? modelLabel(S.defaultModelKey) : "None chosen"], ["Providers on", on.length ? on.map((p) => p.name).join(", ") : "None"], ["Free models available", String(o.counts.models)], ["Mode", "Free only, no paid fallback"]])),
      h("div", {}, h("h2", {}, "Requests today (UTC)"), o.usageToday.length ? kv(o.usageToday.map((u) => [pv.providers.find((p) => p.id === u.provider_id)?.name || u.provider_id, `${u.requests} requests, ${u.requests - u.ok} failed, ${fmtN(u.tokens || 0)} tokens`])) : h("p", { class: "muted" }, "No requests yet today.")),
      h("div", {}, h("h2", {}, "Tasks"), total ? kv([["Pending", ts("pending")], ["In progress", ts("in_progress")], ["Waiting for approval", ts("waiting_for_approval")], ["Completed", ts("completed")], ["Failed", ts("failed")]]) : h("p", { class: "muted" }, "No tasks yet. ", h("a", { href: "#/tasks" }, "Add one"))),
      h("div", {}, h("h2", {}, "Workspace"), kv([["Active agents", `${o.agents.active || 0} of ${(o.agents.active || 0) + (o.agents.paused || 0)}`], ["Projects", o.counts.projects], ["Conversations", o.counts.conversations], ["Memory entries", o.counts.memory]]))),
    h("div", { class: "section" }, h("h2", {}, "Recent conversations"), o.recentConversations.length ? h("div", { class: "list" }, o.recentConversations.map((c) => h("a", { class: "item click", href: "#/chat/" + c.id}, h("div", { class: "grow" }, h("div", { class: "title" }, c.title)), h("span", { class: "muted small" }, ago(c.updated_at))))) : h("p", { class: "muted" }, "Nothing yet.")),
    h("div", { class: "section" }, h("h2", {}, "Recent activity"), o.recentActivity.length ? h("div", { class: "list" }, o.recentActivity.map((a) => h("div", { class: "item" }, h("div", { class: "grow" }, h("div", { class: "title" }, a.action.replace(/_/g, " ")), a.detail ? h("div", { class: "sub" }, a.detail) : null), h("span", { class: "muted small" }, ago(a.created_at))))) : h("p", { class: "muted" }, "Nothing yet."))));
};

/* ---------- Chat ---------- */
const NOT_SAVED = new Set(["NO_MODEL", "MODEL_NOT_FOUND", "MODEL_UNAVAILABLE", "NOT_FREE", "PROVIDER_DISABLED", "FREE_NOT_VERIFIED", "PROVIDER_COOLDOWN", "NO_API_KEY", "AGENT_PAUSED", "VALIDATION", "BAD_JSON", "TOO_LARGE"]);
VIEWS.chat = async (el, arg) => {
  el.className = "view flush";
  const st = (S.chat = { id: arg || null, conv: null, modelKey: "", agentId: "", projectId: "", busy: false });
  const [agents, projects] = await Promise.all([api("/agents"), api("/projects")]);
  if (!S.defaultModelKey) { try { S.defaultModelKey = (await api("/settings")).defaultModelKey || ""; } catch { /* server will auto-pick */ } }
  if (!st.modelKey) st.modelKey = S.defaultModelKey;
  let convList = h("div", { class: "scroll" }), convSearch = h("input", { type: "search", placeholder: "Search chats", "aria-label": "Search chats" });
  const drawer = h("aside", { class: "convs" }, h("div", { class: "convs-head" }, btn("New chat", { class: "primary grow", onclick: () => { drawer.classList.remove("open"); backdrop.classList.remove("open"); location.hash = "#/chat"; } }, "plus")), h("div", { class: "convs-head" }, convSearch), convList);
  const backdrop = h("div", { class: "backdrop", onclick: () => { drawer.classList.remove("open"); backdrop.classList.remove("open"); } });
  const title = h("button", { type: "button", class: "thread-title", onclick: rename }, "New chat");
  const agentSel = h("select", { "aria-label": "Agent", onchange: () => ctxChange("agentId", agentSel.value) }, h("option", { value: "" }, "No agent"), agents.agents.map((a) => h("option", { value: a.id }, a.name + (a.status === "paused" ? " (paused)" : ""))));
  // v0.4: a fresh chat starts with the Rahat CEO agent already selected.
  if (!arg && agents.agents.some((a) => a.id === DEFAULT_AGENT && a.status === "active")) { st.agentId = DEFAULT_AGENT; agentSel.value = DEFAULT_AGENT; }
  const projSel = h("select", { "aria-label": "Project", onchange: () => ctxChange("projectId", projSel.value) }, h("option", { value: "" }, "No project"), projects.projects.map((p) => h("option", { value: p.id }, p.name)));
  const msgsIn = h("div", { class: "msgs-in" }), msgs = h("div", { class: "msgs", "aria-live": "polite" }, msgsIn);
  const input = h("textarea", { rows: "1", placeholder: "Message", "aria-label": "Message", maxlength: "12000" });
  const sendBtn = h("button", { type: "submit", class: "btn primary", "aria-label": "Send" }, svg("send"));
  const composer = h("form", { class: "composer" }, input, sendBtn);
  const del = btn("", { class: "ghost sm", "aria-label": "Delete chat", onclick: delConv }, "trash");
  const thread = h("section", { class: "thread" },
    h("div", { class: "thread-head" }, btn("", { class: "ghost sm convs-toggle", "aria-label": "Chats", onclick: () => { drawer.classList.add("open"); backdrop.classList.add("open"); } }, "menu"), title,
      btn("", { class: "ghost sm", "aria-label": "Chat settings", onclick: () => {
        let d2;
        d2 = openDialog([
          h("h2", {}, "This chat"),
          h("label", { class: "field" }, "Agent", agentSel),
          h("label", { class: "field" }, "Project", projSel),
          h("p", { class: "hint" }, "The model is chosen for you."),
          h("div", { class: "sheet-foot" }, btn("Done", { class: "primary", onclick: () => d2.close() })),
        ]);
      } }, "more"), del),
    msgs, composer);
  el.replaceChildren(h("div", { class: "chat" }, drawer, backdrop, thread));

  const paintChip = () => { /* v0.6: the model is never shown in the chat */ };
  const nearBottom = () => msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 140;
  const toBottom = () => { msgs.scrollTop = msgs.scrollHeight; };
  const hint = () => msgsIn.replaceChildren(h("div", { class: "empty" }, h("b", {}, "Start a conversation"), st.modelKey ? "Ask anything. Pick an agent or project above to give it context." : "Choose a free model first, then ask anything."));

  function copyBtn(getText) { return h("button", { type: "button", class: "copy", onclick: async () => { try { await navigator.clipboard.writeText(getText()); toast("Copied", "ok"); } catch { toast("Copy is not available here", "bad"); } } }, "Copy"); }
  function addMsg(m) {
    if (msgsIn.querySelector(".empty")) msgsIn.replaceChildren();
    const ai = m.role === "assistant", bubble = h("div", { class: "bubble" });
    if (ai) bubble.innerHTML = md(m.content); else bubble.textContent = m.content;
    const wrap = h("div", { class: "msg " + (ai ? "ai" : "user") }, h("div", { class: "who" }, ai ? "Assistant" : "You"), bubble);
    if (ai) {
      const ctx = m.context_used || [];
      wrap.append(h("div", { class: "msg-meta" }, m.model_key ? h("span", {}, modelLabel(m.model_key)) : null, ctx.length ? h("span", { class: "badge", title: ctx.map((c) => c.title).join(", ") }, `Used ${ctx.length} memory ${ctx.length === 1 ? "entry" : "entries"}: ${ctx.map((c) => c.title).join(", ").slice(0, 80)}`) : null, copyBtn(() => m.content)));
    }
    msgsIn.append(wrap); return { wrap, bubble };
  }
  msgs.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]"); if (!b) return;
    try { await navigator.clipboard.writeText(b.closest(".code").querySelector("code").textContent); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1200); } catch { toast("Copy is not available here", "bad"); }
  });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 180) + "px"; });
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !matchMedia("(pointer:coarse)").matches) { e.preventDefault(); composer.requestSubmit(); } });

  async function loadConvs() {
    try {
      const r = await api("/conversations" + (convSearch.value.trim() ? "?q=" + encodeURIComponent(convSearch.value.trim()) : ""));
      convList.replaceChildren(...(r.conversations.length ? r.conversations.map((c) => h("button", { type: "button", class: "conv", "aria-current": String(c.id === st.id), onclick: () => { location.hash = "#/chat/" + c.id; } }, c.pinned ? svg("pin") : null, h("span", { class: "t" }, c.title))) : [h("p", { class: "empty" }, convSearch.value ? "No chats match." : "No chats yet.")]));
    } catch { /* list is optional */ }
  }
  let st2; convSearch.addEventListener("input", () => { clearTimeout(st2); st2 = setTimeout(loadConvs, 250); });
  async function choose() { const m = await pickModel(); if (!m) return; st.modelKey = m.key; paintChip(); if (st.id) api(`/conversations/${st.id}`, { method: "PATCH", body: { modelKey: m.key } }).catch(() => {}); if (msgsIn.querySelector(".empty")) hint(); }
  async function ctxChange(k, v) { st[k] = v; if (st.id) await guard(() => api(`/conversations/${st.id}`, { method: "PATCH", body: { [k]: v || null } }))(); }
  async function rename() { if (!st.id) return toast("Send a message first, then rename."); await formDialog({ title: "Rename chat", fields: [{ name: "title", label: "Title", max: 120 }], values: { title: title.textContent }, onSubmit: async (v) => { await api("/conversations/" + st.id, { method: "PATCH", body: { title: v.title } }); title.textContent = v.title; loadConvs(); } }); }
  async function delConv() { if (!st.id) return; await confirmBox("Delete this chat and all its messages?", "Delete chat", async () => { await api("/conversations/" + st.id, { method: "DELETE" }); location.hash = "#/chat"; }); }

  // load existing conversation
  if (st.id) {
    try {
      const r = await api("/conversations/" + st.id); st.conv = r.conversation;
      st.modelKey = r.conversation.model_key || S.defaultModelKey; st.agentId = r.conversation.agent_id || ""; st.projectId = r.conversation.project_id || "";
      title.textContent = r.conversation.title; agentSel.value = st.agentId; projSel.value = st.projectId;
      if (r.messages.length) r.messages.forEach(addMsg); else hint();
    } catch (e) { toast(e.message, "bad"); location.hash = "#/chat"; return; }
  } else { st.modelKey = S.defaultModelKey; hint(); }
  paintChip(); loadConvs(); setTimeout(toBottom, 0);

  async function send(retry) {
    if (st.busy) return;
    const text = input.value.trim(); if (!retry && !text) return;
    if (!st.modelKey) { await choose(); if (!st.modelKey) return; }
    st.busy = true; const ctl = (S.abort = new AbortController());
    sendBtn.replaceChildren(svg("stop")); sendBtn.type = "button"; sendBtn.setAttribute("aria-label", "Stop"); sendBtn.onclick = () => ctl.abort();
    let userEl = null; const errBox = msgsIn.querySelector(".chat-err"); if (errBox) errBox.remove();
    try {
      if (!st.id) {
        const r = await api("/conversations", { method: "POST", body: { modelKey: st.modelKey, agentId: st.agentId || null, projectId: st.projectId || null } });
        st.id = r.conversation.id; history.replaceState(null, "", "#/chat/" + st.id);
      }
      if (!retry) { userEl = addMsg({ role: "user", content: text }).wrap; input.value = ""; input.style.height = "auto"; }
      const { wrap, bubble } = addMsg({ role: "assistant", content: "" }); bubble.append(h("span", { class: "cursor" })); toBottom();
      let body = "", got = false, meta = null, doneInfo = null, streamErr = null, raf = 0;
      const paint = () => { raf = 0; const stick = nearBottom(); bubble.innerHTML = md(body); if (!doneInfo && !streamErr) bubble.append(h("span", { class: "cursor" })); if (stick) toBottom(); };
      try {
        const res = await fetch(`/api/conversations/${st.id}/messages`, { method: "POST", credentials: "same-origin", signal: ctl.signal, headers: { "Content-Type": "application/json", "X-CSRF-Token": S.csrf }, body: JSON.stringify({ content: retry ? "" : text, modelKey: st.modelKey, stream: true, retry }) });
        if (!res.ok || !(res.headers.get("content-type") || "").includes("event-stream")) throw new ApiError(await res.json().catch(() => ({})), res.status);
        const reader = res.body.getReader(), dec = new TextDecoder(); let buf = "";
        for (;;) {
          const { value, done } = await reader.read(); if (done) break;
          buf += dec.decode(value, { stream: true });
          let i; while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i); buf = buf.slice(i + 2);
            if (!frame.startsWith("data: ")) continue;
            let o; try { o = JSON.parse(frame.slice(6)); } catch { continue; }
            if (o.meta) { meta = o.meta; S.modelNames[meta.model] = meta.modelName; paintChip(); }
            else if (o.t) { got = true; body += o.t; if (!raf) raf = requestAnimationFrame(paint); }
            else if (o.error) streamErr = o.error;
            else if (o.done) doneInfo = o;
          }
        }
      } catch (e) {
        if (e.name !== "AbortError") { wrap.remove(); throw e; }
      }
      if (raf) cancelAnimationFrame(raf);
      if (streamErr && !got) { wrap.remove(); throw Object.assign(new Error(streamErr.message), { code: streamErr.code }); }
      if (!got) { wrap.remove(); if (ctl.signal.aborted) toast("Stopped"); return; }
      wrap.remove();
      addMsg({ role: "assistant", content: body + (ctl.signal.aborted || doneInfo?.partial ? "\n\n_Stopped early._" : ""), model_key: st.modelKey, context_used: meta?.context });
      if (streamErr) toast(streamErr.message, "bad");
      toBottom(); loadConvs();
      if (title.textContent === "New chat") api("/conversations/" + st.id).then((r) => (title.textContent = r.conversation.title)).catch(() => {});
    } catch (e) {
      if (e.status === 401) return;
      const saved = !NOT_SAVED.has(e.code);
      if (!saved && userEl) { userEl.remove(); input.value = text; }
      const box = h("div", { class: "notice bad chat-err" }, h("b", {}, e.message), h("div", { class: "row wrap section" },
        saved ? btn("Try again", { class: "sm", onclick: () => send(true) }) : null,
        ["NO_MODEL", "NOT_FREE", "MODEL_NOT_FOUND", "MODEL_UNAVAILABLE", "PROVIDER_DISABLED", "FREE_NOT_VERIFIED", "NO_API_KEY"].includes(e.code) ? btn("Open Models", { class: "sm", onclick: () => (location.hash = "#/models") }) : null,
        ["QUOTA_EXHAUSTED", "RATE_LIMITED", "PROVIDER_COOLDOWN", "PROVIDER_AUTH", "PROVIDER_ERROR", "PROVIDER_UNREACHABLE", "EMPTY_RESPONSE"].includes(e.code) ? btn("Choose another model", { class: "sm", onclick: choose }) : null));
      msgsIn.append(box); toBottom();
    } finally {
      st.busy = false; S.abort = null; sendBtn.replaceChildren(svg("send")); sendBtn.type = "submit"; sendBtn.setAttribute("aria-label", "Send"); sendBtn.onclick = null;
    }
  }
  composer.addEventListener("submit", (e) => { e.preventDefault(); send(false); });
};

/* ---------- Projects ---------- */
const PSTAT = [["active", "Active"], ["paused", "Paused"], ["completed", "Completed"], ["archived", "Archived"]];
VIEWS.projects = async (el) => {
  const { projects } = await api("/projects");
  const edit = (p) => formDialog({
    title: p ? "Edit project" : "New project", values: p || {}, submit: p ? "Save" : "Create",
    fields: [{ name: "name", label: "Name", max: 100 }, { name: "description", label: "Description", type: "textarea", max: 3000 }, { name: "goals", label: "Goals", type: "textarea", max: 3000 }, { name: "notes", label: "Notes", type: "textarea", max: 8000, rows: 5 }, ...(p ? [{ name: "status", label: "Status", type: "select", options: PSTAT }] : [])],
    extra: p ? [btn("Delete", { class: "danger", onclick: () => confirmType("project", p.name, async () => { await api(`/projects/${p.id}?confirm=${encodeURIComponent(p.name)}`, { method: "DELETE" }); VIEWS.projects(el); }) })] : [],
    onSubmit: async (v) => { await api(p ? "/projects/" + p.id : "/projects", { method: p ? "PATCH" : "POST", body: v }); VIEWS.projects(el); },
  });
  el.replaceChildren(h("div", { class: "page" }, h("div", { class: "head" }, h("h1", { class: "grow" }, "Projects"), btn("New project", { class: "primary", onclick: () => edit() }, "plus")),
    projects.length ? h("div", { class: "list" }, projects.map((p) => { const bar = h("div", { class: "progress" }, h("i")); bar.firstChild.style.setProperty("--p", p.task_count ? Math.round((p.done_count / p.task_count) * 100) : 0);
      return h("div", { class: "item click", onclick: () => edit(p) }, h("div", { class: "grow" }, h("div", { class: "title" }, p.name), h("div", { class: "sub" }, p.description || "No description")), p.task_count ? [h("span", { class: "muted small" }, `${p.done_count}/${p.task_count} tasks`), bar] : null, h("span", { class: "badge" }, p.status)); }))
      : h("div", { class: "empty" }, h("b", {}, "No projects yet"), "A project keeps its own tasks, chats and memory so businesses never mix.")));
};

/* ---------- Tasks ---------- */
const TSTAT = [["pending", "Pending"], ["in_progress", "In progress"], ["waiting_for_approval", "Waiting for approval"], ["completed", "Completed"], ["failed", "Failed"], ["cancelled", "Cancelled"]];
const PRI = [["low", "Low"], ["normal", "Normal"], ["high", "High"], ["urgent", "Urgent"]];
const day = (iso) => (iso ? iso.slice(0, 10) : "");
VIEWS.tasks = async (el) => {
  let fStatus = "", fProj = "";
  const [{ projects }, { agents }] = await Promise.all([api("/projects"), api("/agents")]);
  const pn = Object.fromEntries(projects.map((p) => [p.id, p.name])), an = Object.fromEntries(agents.map((a) => [a.id, a.name]));
  const popts = [["", "No project"], ...projects.map((p) => [p.id, p.name])], aopts = [["", "Unassigned"], ...agents.map((a) => [a.id, a.name])];
  const list = h("div", { class: "list" });
  const edit = (t) => formDialog({
    title: t ? "Edit task" : "New task", values: t ? { ...t, due_at: day(t.due_at), project_id: t.project_id || "", agent_id: t.agent_id || "" } : { priority: "normal" }, submit: t ? "Save" : "Create",
    fields: [{ name: "title", label: "Title", max: 160 }, { name: "details", label: "Details", type: "textarea", max: 5000 }, ...(t ? [{ name: "status", label: "Status", type: "select", options: TSTAT }, { name: "progress", label: "Progress (0 to 100)", type: "number", inputmode: "numeric" }, { name: "result", label: "Completion details", type: "textarea", max: 5000, rows: 3 }] : []), { name: "priority", label: "Priority", type: "select", options: PRI }, { name: "due_at", label: "Deadline", type: "date" }, { name: "project_id", label: "Project", type: "select", options: popts }, { name: "agent_id", label: "Assigned agent", type: "select", options: aopts }],
    extra: t ? [btn("History", { class: "ghost", onclick: guard(async () => { const r = await api(`/tasks/${t.id}/events`); openDialog([h("h2", {}, "Task history"), r.events.length ? h("div", { class: "list" }, r.events.map((e) => h("div", { class: "item" }, h("div", { class: "grow" }, h("div", { class: "title" }, e.event), e.detail ? h("div", { class: "sub" }, e.detail) : null), h("span", { class: "muted small" }, ago(e.created_at))))) : h("p", { class: "muted" }, "No history yet.")]); }) }), btn("Delete", { class: "danger", onclick: () => confirmBox(`Delete "${t.title}"?`, "Delete task", async () => { await api("/tasks/" + t.id, { method: "DELETE" }); load(); }) })] : [],
    onSubmit: async (v) => { const body = { ...v, projectId: v.project_id || null, agentId: v.agent_id || null, dueAt: v.due_at ? new Date(v.due_at + "T00:00:00Z").toISOString() : null, progress: v.progress === "" || v.progress === undefined ? undefined : Number(v.progress) }; delete body.project_id; delete body.agent_id; delete body.due_at; if (!t) { delete body.status; delete body.progress; delete body.result; } await api(t ? "/tasks/" + t.id : "/tasks", { method: t ? "PATCH" : "POST", body }); load(); },
  });
  async function load() {
    const q = new URLSearchParams(); if (fStatus) q.set("status", fStatus); if (fProj) q.set("projectId", fProj);
    const { tasks } = await api("/tasks?" + q);
    list.replaceChildren(...(tasks.length ? tasks.map((t) => {
      const sel = h("select", { class: "inline", "aria-label": "Status", onclick: (e) => e.stopPropagation(), onchange: guard(async () => { await api("/tasks/" + t.id, { method: "PATCH", body: { status: sel.value } }); load(); }) }, TSTAT.map(([v, l]) => h("option", { value: v, selected: v === t.status }, l)));
      return h("div", { class: "item click", onclick: () => edit(t) }, h("div", { class: "grow" }, h("div", { class: "title" }, t.title), h("div", { class: "sub" }, [t.project_id ? pn[t.project_id] : null, t.agent_id ? an[t.agent_id] : null, t.due_at ? "due " + day(t.due_at) : null].filter(Boolean).join(", ") || "No project or deadline")), t.priority !== "normal" ? h("span", { class: "badge " + (t.priority === "urgent" ? "bad" : t.priority === "high" ? "warn" : "") }, t.priority) : null, sel);
    }) : [h("div", { class: "empty" }, h("b", {}, "No tasks here"), "Add a task, link it to a project and assign an agent.")]));
  }
  const fs = h("select", { class: "inline", "aria-label": "Filter by status", onchange: () => { fStatus = fs.value; load(); } }, h("option", { value: "" }, "All statuses"), TSTAT.map(([v, l]) => h("option", { value: v }, l)));
  const fp = h("select", { class: "inline", "aria-label": "Filter by project", onchange: () => { fProj = fp.value; load(); } }, h("option", { value: "" }, "All projects"), projects.map((p) => h("option", { value: p.id }, p.name)));
  el.replaceChildren(h("div", { class: "page" }, h("div", { class: "head" }, h("h1", { class: "grow" }, "Tasks"), btn("New task", { class: "primary", onclick: () => edit() }, "plus")), h("div", { class: "row wrap" }, fs, fp), h("div", { class: "section" }, list)));
  load();
};

/* ---------- Agents ---------- */
VIEWS.agents = async (el) => {
  const [{ agents }, { projects }, { templates }] = await Promise.all([api("/agents"), api("/projects"), api("/agents/templates")]);
  const edit = (a) => {
    const fields = [...(a ? [] : [{ name: "tpl", label: "Start from a template", type: "select", options: [["", "Blank agent"], ...templates.map((t, i) => [i, t.name])], onChange: (v, inp) => { const t = templates[+v]; if (!t) return; for (const k of ["name", "role", "description", "instructions"]) inp[k].value = t[k]; } }]),
      { name: "name", label: "Name", max: 60 }, { name: "role", label: "Role", max: 80 }, { name: "description", label: "Description", max: 400 }, { name: "instructions", label: "System instructions", type: "textarea", max: 4000, rows: 5 }, { name: "personality", label: "Personality", max: 600 }, { name: "capabilities", label: "Capabilities", max: 600 }];
    return formDialog({
      title: a ? "Edit agent" : "New agent", values: a || {}, submit: a ? "Save" : "Create", fields,
      extra: a ? [btn("Delete", { class: "danger", onclick: () => confirmType("agent", a.name, async () => { await api("/agents/" + a.id, { method: "DELETE" }); VIEWS.agents(el); }) })] : [],
      onSubmit: async (v) => { const b = { ...v }; delete b.tpl; await api(a ? "/agents/" + a.id : "/agents", { method: a ? "PATCH" : "POST", body: b }); VIEWS.agents(el); },
    });
  };
  el.replaceChildren(h("div", { class: "page" }, h("div", { class: "head" }, h("h1", { class: "grow" }, "Agents"), btn("New agent", { class: "primary", onclick: () => edit() }, "plus")),
    agents.length ? h("div", { class: "list" }, agents.map((a) => h("div", { class: "item" },
      h("div", { class: "grow click", onclick: () => edit(a) }, h("div", { class: "title" }, a.name), h("div", { class: "sub" }, a.role)),
      h("span", { class: "badge " + (a.status === "active" ? "ok" : "warn") }, a.status),
      btn("Chat", { class: "sm", onclick: guard(async () => { const r = await api("/conversations", { method: "POST", body: { agentId: a.id } }); location.hash = "#/chat/" + r.conversation.id; }) }),
      btn(a.status === "active" ? "Pause" : "Activate", { class: "sm", onclick: guard(async () => { await api("/agents/" + a.id, { method: "PATCH", body: { status: a.status === "active" ? "paused" : "active" } }); VIEWS.agents(el); }) }))))
      : h("div", { class: "empty" }, h("b", {}, "No agents yet"), "Create one from a template (AI CEO, Researcher, Developer and more) or write your own.")));
};

/* ---------- Memory ---------- */
VIEWS.memory = async (el) => {
  const { projects } = await api("/projects"); const pn = Object.fromEntries(projects.map((p) => [p.id, p.name]));
  let q = "", cat = "", cats = [];
  const CAT = { personal: "Personal preferences", business: "Business information", project: "Project knowledge", instruction: "Instructions", decision: "Decisions", research: "Research", general: "General knowledge" };
  const list = h("div", { class: "list" });
  const edit = (m) => formDialog({
    title: m ? "Edit memory" : "New memory", values: m ? { ...m, project_id: m.project_id || "" } : { category: "general" }, submit: m ? "Save" : "Save memory",
    fields: [{ name: "title", label: "Title", max: 120 }, { name: "content", label: "What should be remembered", type: "textarea", max: 5000, rows: 5 }, { name: "category", label: "Category", type: "select", options: Object.entries(CAT) }, { name: "tags", label: "Tags (comma separated)", max: 200 }, { name: "project_id", label: "Project", type: "select", options: [["", "All projects"], ...projects.map((p) => [p.id, p.name])] }, { name: "pinned", label: "Always include when relevant to the chat", type: "checkbox" }],
    extra: m ? [btn("Delete", { class: "danger", onclick: () => confirmBox("Delete this memory?", "Delete", async () => { await api("/memory/" + m.id, { method: "DELETE" }); load(); }) })] : [],
    onSubmit: async (v) => { const b = { ...v, projectId: v.project_id || null }; delete b.project_id; await api(m ? "/memory/" + m.id : "/memory", { method: m ? "PATCH" : "POST", body: b }); load(); },
  });
  async function load() {
    const p = new URLSearchParams(); if (q) p.set("q", q); if (cat) p.set("category", cat);
    const r = await api("/memory?" + p); cats = r.categories;
    list.replaceChildren(...(r.items.length ? r.items.map((m) => h("div", { class: "item click", onclick: () => edit(m) }, h("div", { class: "grow" }, h("div", { class: "title" }, m.title || m.content.slice(0, 60)), h("div", { class: "sub" }, m.content.slice(0, 120))), m.pinned ? h("span", { class: "badge warn" }, "pinned") : null, m.project_id ? h("span", { class: "badge" }, pn[m.project_id] || "project") : null, h("span", { class: "badge" }, CAT[m.category] || m.category))) : [h("div", { class: "empty" }, h("b", {}, q || cat ? "No matches" : "Nothing saved yet"), "Memory holds facts and preferences worth reusing. Relevant entries are added to the chat automatically, and each reply shows which ones were used.")]));
  }
  let tm; const search = h("input", { type: "search", placeholder: "Search memory", "aria-label": "Search memory", oninput: () => { clearTimeout(tm); tm = setTimeout(() => { q = search.value.trim(); load(); }, 250); } });
  const cs = h("select", { class: "inline", "aria-label": "Category", onchange: () => { cat = cs.value; load(); } }, h("option", { value: "" }, "All categories"), Object.entries(CAT).map(([v, l]) => h("option", { value: v }, l)));
  el.replaceChildren(h("div", { class: "page" }, h("div", { class: "head" }, h("h1", { class: "grow" }, "Memory"), btn("New memory", { class: "primary", onclick: () => edit() }, "plus")), h("div", { class: "row wrap" }, h("div", { class: "grow" }, search), cs), h("div", { class: "section" }, list)));
  load();
};

/* ---------- Files (binary storage in Backblaze B2, metadata in D1) ---------- */
const fmtB = (n) => {
  n = Number(n) || 0;
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
};
VIEWS.files = async (el) => {
  let q = "";
  const body = h("div", {});
  const picker = h("input", { type: "file", multiple: true, hidden: true, onchange: () => upload(picker.files) });

  async function upload(list) {
    const files = [...(list || [])];
    if (!files.length) return;
    for (const f of files) {
      try {
        const res = await fetch("/api/files", {
          method: "POST", credentials: "same-origin",
          headers: {
            "X-File-Name": encodeURIComponent(f.name),
            "Content-Type": f.type || "application/octet-stream",
            "X-CSRF-Token": S.csrf,
          },
          body: f,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new ApiError(data, res.status);
        toast(f.name + " uploaded", "ok");
      } catch (e) {
        if (e.status === 401) return boot();
        toast(f.name + ": " + e.message, "bad");
        if (e.code === "STORAGE_FULL") break;   // quota is a hard stop: stop offering more
      }
    }
    picker.value = "";
    paint();
  }

  async function testConn() {
    try {
      const r = await api("/storage/test", { method: "POST", body: {} });
      toast("Connected to " + r.bucket + " in " + r.ms + " ms", "ok");
    } catch (e) { if (e.status !== 401) toast(e.message, "bad"); }
  }

  async function del(f) {
    await confirmType("file", f.name, async () => {
      await api("/files/" + f.id + "?confirm=" + encodeURIComponent(f.name), { method: "DELETE" });
      toast("Deleted " + f.name, "ok");
      paint();
    });
  }

  async function paint() {
    let st;
    try { st = await api("/storage"); } catch (e) { if (e.status === 401) return; body.replaceChildren(h("div", { class: "notice bad" }, e.message)); return; }

    const head = h("div", { class: "head" },
      h("h1", { class: "grow" }, "Files"),
      st.configured ? btn("Upload", { class: "primary", onclick: () => picker.click() }, "plus") : null);

    if (!st.configured) {
      body.replaceChildren(head, h("div", { class: "section" }, h("div", { class: "notice" },
        h("b", {}, "Storage is not connected yet. "),
        st.configProblem ? h("div", { class: "notice bad section" }, st.configProblem) : null,
        "Add these four values in Cloudflare: Worker, Settings, Variables and Secrets.",
        h("div", { class: "small section" },
          h("div", {}, "B2_BUCKET — your bucket name, for example rahat-desecret"),
          h("div", {}, "B2_ENDPOINT — for example https://s3.us-west-004.backblazeb2.com"),
          h("div", {}, "B2_KEY_ID — Secret"),
          h("div", {}, "B2_APP_KEY — Secret")),
        h("p", { class: "small muted section" }, "Then reload this page. Nothing is uploaded anywhere until you do."))));
      return;
    }

    const pct = st.totalBytes ? Math.min(100, (st.usedBytes / st.totalBytes) * 100) : 0;
    const bar = h("div", { class: "section" },
      h("div", { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "title" }, "Storage"),
          h("div", { class: "small muted" }, fmtB(st.usedBytes) + " used of " + fmtB(st.totalBytes) + " · " + fmtB(st.remainingBytes) + " free")),
        st.full ? h("span", { class: "badge bad" }, "full") : h("span", { class: "badge ok" }, pct.toFixed(1) + "%")));

    // set width without inline styles (CSP blocks the style attribute)
    const track = h("div", { class: "bar" + (st.full ? " full" : "") }, h("i", {}));
    track.firstChild.style.width = pct.toFixed(2) + "%";
    bar.append(track, h("p", { class: "small muted" }, "Binaries live in Backblaze B2; this database only holds names, sizes and ids. Nothing is ever moved or upgraded automatically."));

    if (st.full) {
      bar.append(h("div", { class: "notice section" }, h("b", {}, "Storage is full. "), "New uploads are refused. Delete something to free space — nothing was deleted for you."));
    }

    const search = h("input", { type: "search", placeholder: "Search files", "aria-label": "Search files", value: q, oninput: () => { clearTimeout(search._t); search._t = setTimeout(() => { q = search.value.trim(); list_(); }, 250); } });

    const listEl = h("div", { class: "list" });
    async function list_() {
      let r;
      try { r = await api("/files" + (q ? "?q=" + encodeURIComponent(q) : "")); } catch (e) { if (e.status !== 401) toast(e.message, "bad"); return; }
      listEl.replaceChildren(...(r.files.length ? r.files.map((f) => h("div", { class: "item" },
        h("div", { class: "grow" },
          h("div", { class: "title" }, f.name),
          h("div", { class: "sub" }, fmtB(f.size) + " · " + ago(f.createdAt))),
        h("span", { class: "badge" }, (f.mime || "").split("/")[0] || "file"),
        h("div", { class: "fileacts" },
          h("a", { class: "btn sm", href: "/api/files/" + f.id + "/download", download: f.name }, "Open"),
          btn("", { class: "sm danger", "aria-label": "Delete " + f.name, onclick: () => del(f) }, "trash"))))
        : [h("div", { class: "empty" }, h("b", {}, q ? "No matches" : "No files yet"),
            q ? "Try another search." : "Tap Upload to add images, PDFs, audio or video. Images are limited to " + Math.round(st.limits.imageBytes / 1048576) + " MB, other files to " + Math.round(st.limits.otherBytes / 1048576) + " MB.")]));
    }

    body.replaceChildren(head, bar,
      h("div", { class: "row section" }, h("div", { class: "grow" }, search), btn("Test", { class: "sm", onclick: guard(testConn) })),
      h("div", { class: "section" }, listEl));
    list_();
  }

  el.replaceChildren(h("div", { class: "page" }, body, picker));
  paint();
};

/* ---------- Models ---------- */
const POLICY = { pricing: "A model counts as free only when the provider lists a price of $0 for it.", tier: "Free tier with rate limits. Stays free only while no payment method or paid plan is on the account.", credits: "Small monthly free credits. Requests fail once used up, unless a payment method is attached.", allowlist: "Daily free allocation. Requests fail above it on the Free plan." };
const ATTEST = (n) => `I checked ${n}'s current free-tier terms and that my account may use them. No payment method or paid plan is attached.`;
VIEWS.models = async (el) => {
  const { providers } = await api("/providers");
  let health = {};
  const body = h("div", {});
  const setDefault = () => pickModel({ title: "Default model", onPick: guard(async (m) => { await api("/settings", { method: "PUT", body: { defaultModelKey: m.key } }); S.defaultModelKey = m.key; toast("Default model set", "ok"); VIEWS.models(el); }) });
  const reload = () => VIEWS.models(el);
  const card = (p) => {
    const hl = health[p.id];
    const att = h("input", { type: "checkbox", checked: !!p.attestedAt, onchange: guard(async () => { await api("/providers/" + p.id, { method: "PATCH", body: { attest: att.checked } }); reload(); }) });
    return h("div", { class: "prov" },
      h("div", { class: "prov-top" }, h("h3", { class: "grow" }, p.name), h("span", { class: "badge " + (p.hasKey ? "ok" : "warn") }, p.kind === "workersai" ? (p.hasKey ? "binding attached" : "no binding") : p.hasKey ? "key found" : "key missing"), h("span", { class: "badge " + (p.enabled ? "ok" : "") }, p.enabled ? "on" : "off"), hl ? h("span", { class: "badge " + (hl.status === "ok" || hl.status === "binding_present" ? "ok" : "bad") }, hl.status.replace(/_/g, " ")) : null, p.cooldownUntil ? h("span", { class: "badge warn" }, "paused until " + new Date(p.cooldownUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : null),
      h("p", { class: "small muted section" }, POLICY[p.policy]),
      !p.hasKey && p.keyEnv ? h("p", { class: "small section" }, "Add a secret named ", h("b", {}, p.keyEnv), " in Cloudflare: Worker, Settings, Variables and Secrets (type Secret).") : null,
      h("p", { class: "small muted" }, p.modelCount + " free models in catalog", p.lastSyncAt ? `. Last sync ${ago(p.lastSyncAt)}: ${p.lastSyncNote}` : ""),
      h("label", { class: "check section" }, att, h("span", { class: "small" }, ATTEST(p.name))),
      h("div", { class: "prov-actions" },
        btn(p.enabled ? "Turn off" : "Turn on", { class: "sm " + (p.enabled ? "" : "primary"), disabled: !p.enabled && !p.attestedAt, onclick: guard(async () => { await api("/providers/" + p.id, { method: "PATCH", body: { enabled: !p.enabled } }); reload(); }) }),
        p.kind !== "workersai" ? btn("Sync models", { class: "sm", disabled: !p.hasKey && p.policy !== "pricing", onclick: guard(async (e) => { e.currentTarget.disabled = true; const r = await api(`/providers/${p.id}/sync`, { method: "POST", body: {} }); toast(r.note, "ok"); reload(); }) }) : null,
        p.policy !== "pricing" ? btn("Add model by id", { class: "sm", onclick: () => formDialog({ title: "Add model to " + p.name, submit: "Add", fields: [{ name: "modelId", label: "Model id", max: 200 }, { name: "name", label: "Display name (optional)", max: 160 }], onSubmit: async (v) => { await api("/models", { method: "POST", body: { providerId: p.id, ...v } }); reload(); } }) }) : null,
        p.custom ? btn("Remove", { class: "sm danger", onclick: () => confirmBox(`Remove ${p.name} and its models?`, "Remove", async () => { await api("/providers/" + p.id, { method: "DELETE" }); reload(); }) }) : null));
  };
  el.replaceChildren(h("div", { class: "page" },
    h("div", { class: "head" }, h("h1", { class: "grow" }, "Models"), btn("Browse free models", { class: "primary", onclick: () => pickModel({ title: "Free models", onPick: () => {} }) }, "search")),
    h("div", { class: "notice" }, h("b", {}, "Free only. "), "A model can be used only if its provider is on, you confirmed the free terms, and the model is verified free. Nothing is ever routed to a paid model, and a used-up quota stops the request instead of falling back."),
    h("div", { class: "section row wrap" }, h("div", { class: "grow" }, h("div", { class: "title" }, "Default model"), h("div", { class: "muted small" }, S.defaultModelKey ? modelLabel(S.defaultModelKey) : "None chosen")), btn("Change", { class: "sm", onclick: setDefault }), S.defaultModelKey ? btn("Test it", { class: "sm", onclick: guard(async (e) => { e.currentTarget.disabled = true; try { const r = await api(`/models/${encodeURIComponent(S.defaultModelKey)}/test`, { method: "POST", body: {} }); toast(`Replied in ${r.ms} ms`, "ok"); } finally { e.currentTarget.disabled = false; } }) }) : null),
    h("div", { class: "section row" }, h("h2", { class: "grow" }, "Providers"), btn("Check connections", { class: "sm", onclick: guard(async () => { const r = await api("/providers/health"); health = Object.fromEntries(r.health.map((x) => [x.id, x])); if (!r.health.length) toast("Turn on a provider first"); VIEWS.models.paint(); }) }), btn("Add provider", { class: "sm", onclick: () => formDialog({ title: "Add an OpenAI-compatible provider", submit: "Add", fields: [{ name: "id", label: "Short id (letters, numbers, dashes)", max: 31 }, { name: "name", label: "Name", max: 60 }, { name: "baseUrl", label: "Base URL (https://…/v1)", max: 300 }, { name: "keyEnv", label: "Secret name (e.g. MY_API_KEY)", max: 60, hint: "Store the key as a Worker secret with this name." }], onSubmit: async (v) => { await api("/providers", { method: "POST", body: v }); reload(); } }) })),
    body));
  VIEWS.models.paint = () => body.replaceChildren(...providers.map(card));
  VIEWS.models.paint();
};

/* ---------- Settings ---------- */
/* ---------- diagnostics ---------- */
async function showDiagnostics() {
  const d = await api("/diagnostics");
  const row = (x, kind) => {
    const isEnv = kind === "env";
    const badge = isEnv ? (x.ok ? "ok" : "warn") : (x.ok ? "ok" : "bad");
    const text = isEnv ? (x.ok ? "set" : "missing") : (x.ok ? String(x.value) : "failed");
    return h("div", { class: "item" },
      h("div", { class: "grow" },
        h("div", { class: "title" }, x.name),
        x.error ? h("div", { class: "sub" }, x.error) : null),
      h("span", { class: "badge " + badge }, text));
  };
  openDialog([
    h("h2", {}, d.ok ? "All checks passed" : "Something is broken"),
    h("p", { class: "small muted" }, "Database schema " + d.schemaVersion + " of " + d.expected),
    h("div", { class: "list" }, d.checks.map((x) => row(x, "db"))),
    h("div", { class: "list" }, d.environment.map((x) => row(x, "env"))),
    h("p", { class: "small muted" }, "Send this screen if any row says failed."),
  ]);
}

VIEWS.settings = async (el) => {
  const [sess, status, aud, me] = await Promise.all([api("/auth/sessions"), api("/system/status"), api("/audit?limit=25"), fetch("/api/auth/session", { credentials: "same-origin" }).then((r) => r.json())]);
  const reload = () => VIEWS.settings(el);
  const pw = () => formDialog({ title: "Change password", submit: "Change password", fields: [{ name: "current", label: "Current password", type: "password" }, { name: "next", label: "New password (12+ characters)", type: "password" }, { name: "again", label: "Repeat new password", type: "password" }], onSubmit: async (v) => { if (v.next !== v.again) throw new Error("The new passwords do not match."); await api("/auth/password", { method: "POST", body: { current: v.current, next: v.next } }); toast("Password changed. Other devices were signed out.", "ok"); reload(); } });
  const enable2fa = guard(async () => {
    const r = await api("/auth/totp/begin", { method: "POST", body: {} });
    await formDialog({ title: "Turn on two-step sign-in", submit: "Turn on", fields: [{ name: "code", label: "6-digit code from your authenticator app", inputmode: "numeric", max: 6 }],
      extra: [], onSubmit: async (v) => { await api("/auth/totp/enable", { method: "POST", body: { code: v.code } }); toast("Two-step sign-in is on. Other devices were signed out.", "ok"); reload(); } }).catch(() => {});
  });
  const show2fa = async () => { const r = await api("/auth/totp/begin", { method: "POST", body: {} }); const dlg = openDialog([h("h2", {}, "Add to your authenticator"), h("p", { class: "muted" }, "Open an authenticator app (Google Authenticator, Aegis, 2FAS and similar) and add a key by hand with this secret. Time-based, 6 digits."), h("p", { class: "code-secret" }, h("code", {}, r.secret)), h("a", { class: "btn", href: r.uri }, "Open in authenticator app"), h("div", { class: "sheet-foot" }, btn("I added it", { class: "primary", onclick: () => { dlg.close(); enable2fa(); } }))]); };
  const off2fa = () => formDialog({ title: "Turn off two-step sign-in", submit: "Turn off", fields: [{ name: "password", label: "Password", type: "password" }, { name: "code", label: "Authenticator code", inputmode: "numeric", max: 6 }], onSubmit: async (v) => { await api("/auth/totp/disable", { method: "POST", body: v }); toast("Two-step sign-in is off.", "ok"); reload(); } });
  const kv = (rows) => h("dl", { class: "kv" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
  el.replaceChildren(h("div", { class: "page" }, h("div", { class: "head" }, h("h1", { class: "grow" }, "Settings"), btn("Sign out", { onclick: guard(async () => { await api("/auth/logout", { method: "POST", body: {} }); S.csrf = ""; location.hash = ""; boot(); }) })),
    h("div", { class: "section" }, h("h2", {}, "Security"),
      h("div", { class: "item" }, h("div", { class: "grow" }, h("div", { class: "title" }, "Password"), h("div", { class: "sub" }, "Changing it signs out every other device.")), btn("Change", { class: "sm", onclick: pw })),
      h("div", { class: "item" }, h("div", { class: "grow" }, h("div", { class: "title" }, "Two-step sign-in"), h("div", { class: "sub" }, me.totpEnabled ? "On. Login needs your password and an authenticator code." : "Off. Recommended: adds a code from an authenticator app.")), me.totpEnabled ? btn("Turn off", { class: "sm danger", onclick: off2fa }) : btn("Turn on", { class: "sm primary", onclick: guard(show2fa) }))),
    h("div", { class: "section" }, h("h2", {}, "Advanced"),
      h("p", { class: "small muted" }, "Tasks and the model catalog left the main menu. Nothing was deleted and both are still here."),
      h("div", { class: "row wrap section" },
        btn("Tasks", { class: "sm", onclick: () => (location.hash = "#/tasks") }),
        btn("Models", { class: "sm", onclick: () => (location.hash = "#/models") }),
        btn("Diagnostics", { class: "sm", onclick: guard(showDiagnostics) }))),
    h("div", { class: "section" }, h("div", { class: "row" }, h("h2", { class: "grow" }, "Signed-in devices"), sess.sessions.length > 1 ? btn("Sign out others", { class: "sm", onclick: guard(async () => { await api("/auth/logout-all", { method: "POST", body: {} }); toast("Other devices signed out", "ok"); reload(); }) }) : null),
      h("div", { class: "list" }, sess.sessions.map((s) => h("div", { class: "item" }, h("div", { class: "grow" }, h("div", { class: "title" }, s.userAgent ? s.userAgent.slice(0, 60) : "Unknown device"), h("div", { class: "sub" }, "Active " + ago(s.lastSeenAt) + ", expires " + new Date(s.expiresAt).toLocaleDateString())), s.current ? h("span", { class: "badge ok" }, "this device") : btn("Sign out", { class: "sm", onclick: guard(async () => { await api("/auth/sessions/" + s.sid, { method: "DELETE" }); reload(); }) }))))),
    h("div", { class: "section" }, h("h2", {}, "System"), kv([["Version", status.version], ["Database schema", `${status.schemaVersion} of ${status.expectedSchemaVersion}`], ["Free-only mode", "On, not switchable"], ["Workers AI binding", status.bindings.ai ? "Attached" : "Not attached"], ["Setup token secret", status.setupTokenConfigured ? "Configured" : "Missing"]]), status.warnings.length ? h("div", { class: "notice section" }, status.warnings.map((w) => h("p", {}, w))) : null),
    h("div", { class: "section" }, h("h2", {}, "Activity log"), h("div", { class: "list" }, aud.entries.map((a) => h("div", { class: "item" }, h("div", { class: "grow" }, h("div", { class: "title" }, a.action.replace(/_/g, " ")), a.detail ? h("div", { class: "sub" }, a.detail) : null), h("span", { class: "muted small" }, ago(a.created_at))))))));
};

boot();
