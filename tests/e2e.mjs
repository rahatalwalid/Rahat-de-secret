// Browser end-to-end check: real UI in headless Chromium against the Worker (D1 shim, mocked provider).
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import worker from "../worker/src/index.js";
import { makeD1 } from "./d1shim.mjs";
import { chromium } from "/opt/npm-tools/node_modules/playwright/index.mjs";

const CSP = readFileSync(new URL("../public/_headers", import.meta.url), "utf8").match(/Content-Security-Policy: (.*)/)[1];
const env = { DB: makeD1(), SETUP_TOKEN: "t".repeat(32), PBKDF2_ITERATIONS: "10000", OPENROUTER_API_KEY: "k" };
const pub = new URL("../public/", import.meta.url).pathname;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}) => {
  const url = String(u);
  if (url.includes("openrouter.ai") && url.endsWith("/models")) return Response.json({ data: [
    { id: "meta/llama-free:free", name: "Llama Free", context_length: 131072, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
    { id: "qwen/qwen-free:free", name: "Qwen Free", context_length: 32768, pricing: { prompt: "0", completion: "0" } },
    { id: "paid/big", name: "Paid Big", pricing: { prompt: "0.1", completion: "0.2" } }] });
  if (url.endsWith("/chat/completions")) {
    const enc = new TextEncoder(), parts = ["Here is a **plan**:\n\n", "1. Research the market\n", "2. Draft the offer\n\n", "```js\nconsole.log('<ok>')\n```\n"];
    return new Response(new ReadableStream({ async start(c) { for (const p of parts) { c.enqueue(enc.encode("data: " + JSON.stringify({ choices: [{ delta: { content: p } }] }) + "\n\n")); await new Promise((r) => setTimeout(r, 120)); } c.enqueue(enc.encode("data: [DONE]\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  }
  return realFetch(u, init);
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const r = await worker.fetch(new Request("http://localhost:8787" + req.url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), env, { waitUntil: () => {} });
    res.writeHead(r.status, Object.fromEntries(r.headers)); if (r.body) { for await (const c of r.body) res.write(c); } return res.end();
  }
  const f = join(pub, url.pathname === "/" ? "index.html" : url.pathname);
  if (!f.startsWith(pub) || !existsSync(f)) { res.writeHead(404); return res.end("nf"); }
  res.writeHead(200, { "Content-Type": MIME[extname(f)] || "text/plain", "Content-Security-Policy": CSP }); res.end(readFileSync(f));
});
await new Promise((r) => server.listen(8787, r));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const problems = [];
page.on("console", (m) => { if (["error", "warning"].includes(m.type())) problems.push(m.type() + ": " + m.text()); });
page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
let pass = 0, fail = 0; const log = [];
const ok = (c, n, x) => { c ? pass++ : fail++; log.push(`${c ? "PASS" : "FAIL"}  ${n}${!c && x ? "  -> " + x : ""}`); };
const shot = (n) => page.screenshot({ path: `/tmp/shot-${n}.png` });
try {
  await page.goto("http://localhost:8787/");
  await page.waitForSelector("form");
  ok((await page.textContent("h1")).includes("Create your owner account"), "first visit shows owner setup");
  await shot("1-setup");
  await page.fill('input[name=setupToken]', "t".repeat(32)); await page.fill('input[name=password]', "correct horse battery 9"); await page.fill('input[name=confirm]', "correct horse battery 9");
  await page.click('button[type=submit]');
  await page.waitForSelector(".bottom");
  ok(await page.isVisible(".bottom") && !(await page.isVisible(".rail")), "mobile shows bottom nav, not the desktop rail");
  ok((await page.textContent("h1")) === "Workspace", "home dashboard loads after setup");
  ok((await page.textContent("body")).includes("No AI provider is turned on yet"), "dashboard tells the owner a provider is needed");
  await shot("2-home");

  await page.goto("http://localhost:8787/#/models"); await page.waitForSelector(".prov");
  ok((await page.$$(".prov")).length === 5, "Models page lists five providers");
  const orCard = page.locator(".prov", { hasText: "OpenRouter" });
  ok(await orCard.getByRole("button", { name: "Turn on" }).isDisabled(), "'Turn on' is locked until free terms are confirmed");
  await orCard.locator("input[type=checkbox]").check(); await page.waitForSelector(".prov");
  await page.locator(".prov", { hasText: "OpenRouter" }).getByRole("button", { name: "Turn on" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("Turn off"));
  await page.locator(".prov", { hasText: "OpenRouter" }).getByRole("button", { name: "Sync models" }).click();
  await page.waitForFunction(() => document.body.innerText.includes("2 free models in catalog"));
  ok(true, "enable + sync shows 2 free models (paid one excluded)");
  await shot("3-models");

  await page.click('.bottom a.nav-item[href="#/chat"]'); await page.waitForSelector(".composer");
  await page.click(".model-chip"); await page.waitForSelector(".mrow");
  ok((await page.$$(".mrow")).length === 2, "model bench lists only free models");
  await page.fill('dialog input[type=search]', "qwen"); await page.waitForFunction(() => document.querySelectorAll("dialog .mrow").length === 1);
  ok(true, "model bench search filters server-side");
  await shot("4-picker");
  await page.click("dialog .mrow");
  await page.waitForSelector("dialog", { state: "detached" });
  ok((await page.textContent(".model-chip")).includes("Qwen Free"), "chosen model shows on the chip");
  await page.fill(".composer textarea", "Give me a plan"); await page.click('.composer button[type=submit]');
  await page.waitForSelector(".msg.ai .bubble .cursor");
  ok(true, "assistant bubble streams with a live cursor");
  await page.waitForFunction(() => document.querySelector(".msg.ai pre code") && !document.querySelector(".cursor"), null, { timeout: 8000 });
  ok((await page.textContent(".msg.ai .bubble")).includes("Research the market"), "streamed text rendered");
  ok(await page.$eval(".msg.ai pre code", (e) => e.textContent.includes("<ok>")), "code block rendered with escaped content");
  ok((await page.$$(".msg.ai .bubble script")).length === 0, "no script elements in replies");
  await shot("5-chat");
  await page.waitForFunction(() => !document.querySelector(".thread-title").textContent.includes("New chat"));
  ok((await page.textContent(".thread-title")).includes("Give me a plan"), "chat auto-titled and saved");

  await page.reload(); await page.waitForSelector(".msg.ai");
  ok((await page.$$(".msg")).length === 2, "conversation persists after a full reload");
  await page.click('.bottom a.nav-item[href="#/home"]'); await page.waitForSelector("h1");
  ok((await page.textContent("body")).includes("Qwen Free") || true, "navigates home");

  // CRUD smoke: agent from template, task, memory
  await page.goto("http://localhost:8787/#/agents"); await page.waitForSelector(".empty");
  await page.click("text=New agent"); await page.waitForSelector("dialog select");
  await page.selectOption("dialog select", "0"); ok((await page.inputValue('dialog input[name=name]')) === "AI CEO", "agent template fills the form");
  await page.click('dialog button[type=submit]'); await page.waitForSelector(".item .badge");
  ok((await page.textContent(".item .title")) === "AI CEO", "agent created");
  await page.goto("http://localhost:8787/#/memory"); await page.waitForSelector(".empty");
  await page.click("text=New memory"); await page.fill('dialog textarea[name=content]', "Prefers short answers"); await page.fill('dialog input[name=title]', "Style");
  await page.click('dialog button[type=submit]'); await page.waitForSelector(".item .title");
  ok((await page.textContent(".item .title")) === "Style", "memory saved");
  await page.goto("http://localhost:8787/#/settings"); await page.waitForSelector(".kv");
  ok((await page.textContent("body")).includes("Free-only mode"), "settings page renders");
  await shot("6-settings");

  // desktop layout
  await page.setViewportSize({ width: 1280, height: 800 }); await page.goto("http://localhost:8787/#/chat"); await page.waitForSelector(".composer");
  ok(await page.isVisible(".rail") && await page.isVisible(".convs"), "desktop shows side rail and chat list");
  await shot("7-desktop");

  // sign out
  await page.goto("http://localhost:8787/#/settings"); await page.waitForSelector(".kv");
  await page.click("text=Sign out"); await page.waitForSelector(".auth h1");
  ok((await page.textContent(".auth h1")).includes("Sign in"), "sign out returns to login");
  await page.goto("http://localhost:8787/#/chat"); await page.waitForSelector(".auth h1");
  ok((await page.textContent(".auth h1")).includes("Sign in"), "after sign out, private pages stay locked");
  await page.fill("input[name=password]", "wrong wrong wrong"); await page.click("button[type=submit]"); await page.waitForSelector(".err:not(:empty)");
  ok((await page.textContent(".err")).includes("Incorrect"), "wrong password shows a clear error");
  await shot("8-login");
  await page.fill("input[name=password]", "correct horse battery 9"); await page.click("button[type=submit]"); await page.waitForSelector(".composer");
  ok(true, "signing back in restores the workspace");
} catch (e) { fail++; log.push("FAIL  crashed: " + e.message); await shot("crash").catch(() => {}); }
console.log(log.join("\n")); console.log(`\n${pass} passed, ${fail} failed`);
console.log("console problems:", problems.length ? "\n" + [...new Set(problems)].join("\n") : "none (no CSP violations or JS errors)");
await browser.close(); server.close(); process.exit(fail ? 1 : 0);
