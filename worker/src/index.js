import { HttpError, errorResponse, json } from "./lib/util.js";
import { ensureSchema } from "./lib/db.js";
import { authRoutes, authenticate, clientIpHash, guardUnsafe } from "./auth.js";
import { crudRoutes } from "./crud.js";
import { llmRoutes } from "./llm.js";
import { filesRoutes } from "./files.js";

async function handleApi(req, env, ctx, url) {
  if (!env.DB) throw new HttpError(500, "NO_DB", "The D1 binding named DB is missing on this Worker.");
  const path = url.pathname.replace(/\/+$/, "") || "/", method = req.method;
  if (path === "/api/health" && method === "GET") return json({ ok: true });
  await ensureSchema(env);

  const c = { req, env, ctx, url, path, method, ipHash: await clientIpHash(req), session: null };
  // Public auth endpoints are matched before a session is required.
  const pub = ["/api/auth/session", "/api/auth/setup", "/api/auth/login", "/api/auth/reset"];
  if (pub.includes(path)) return (await authRoutes(c)) || json({ error: "NOT_FOUND", message: "Not found." }, 404);

  c.session = await authenticate(req, env, url);
  if (!c.session) throw new HttpError(401, "UNAUTHENTICATED", "Sign in to continue.");
  if (method !== "GET" && method !== "HEAD") await guardUnsafe(req, url, c.session);

  for (const handler of [authRoutes, llmRoutes, crudRoutes, filesRoutes]) {
    const r = await handler(c);
    if (r) return r;
  }
  throw new HttpError(404, "NOT_FOUND", "Not found.");
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/") && url.pathname !== "/api") return env.ASSETS ? env.ASSETS.fetch(req) : new Response("Not found", { status: 404 });
    const rid = crypto.randomUUID().slice(0, 8);
    try { return await handleApi(req, env, ctx, url); }
    catch (e) { return errorResponse(e, rid); }
  },
};
