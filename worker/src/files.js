// File storage: binaries live in Backblaze B2, metadata lives in D1. Free-only, hard stop at quota.
import { HttpError, bad, json, now, readJson, str, uid } from "./lib/util.js";
import { audit, list, one, run } from "./lib/db.js";
import { readConfig, s3Request, sha256Hex } from "./lib/s3.js";

const MB = 1024 * 1024;
const GI = 1024 * MB;

const num = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : d; };
const quotaBytes = (env) => num(env.STORAGE_QUOTA_BYTES, 10 * GI);        // 10 GB free on B2
const maxImage = (env) => num(env.MAX_IMAGE_BYTES, 10 * MB);              // your stated target
const maxOther = (env) => num(env.MAX_FILE_BYTES, 30 * MB);               // your stated target

const isImage = (mime) => /^image\/(jpeg|png|gif|webp|avif|heic|bmp)$/i.test(mime || "");

const safeName = (n) => String(n || "file")
  .replace(/[\u0000-\u001f\u007f]/g, "")
  .replace(/[\\/:*?"<>|]/g, "-")
  .replace(/\s+/g, " ")
  .trim().slice(0, 120) || "file";

const keyFor = (name) => {
  const d = new Date();
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `rds/${y}/${m}/${uid()}/${safeName(name)}`;
};

const publicFile = (r) => ({
  id: r.id, name: r.name, mime: r.mime, size: r.size_bytes, sha256: r.sha256,
  createdAt: r.created_at, provider: r.provider,
});

async function usedBytes(db) {
  const r = await one(db, "SELECT COALESCE(SUM(size_bytes),0) AS n FROM files WHERE deleted_at IS NULL");
  return Number(r?.n || 0);
}

function needStorage(env) {
  const cfg = readConfig(env);
  if (!cfg) throw new HttpError(503, "STORAGE_NOT_CONFIGURED",
    "Add the Backblaze secrets to this Worker first: B2_BUCKET, B2_ENDPOINT, B2_KEY_ID, B2_APP_KEY.");
  if (cfg.problem) throw new HttpError(503, "STORAGE_CONFIG", cfg.problem);
  return cfg;
}

function b2Error(status, text) {
  const t = String(text || "").slice(0, 300);
  if (status === 401 || status === 403) return new HttpError(502, "STORAGE_AUTH", "Backblaze rejected the key. Check B2_KEY_ID / B2_APP_KEY, and that the key is allowed to use this bucket.");
  if (status === 404) return new HttpError(404, "STORAGE_NOT_FOUND", "That bucket or file was not found at Backblaze. Check B2_BUCKET and B2_ENDPOINT.");
  if (status === 429 || status === 503) return new HttpError(503, "STORAGE_BUSY", "Backblaze is rate-limiting or unavailable. Nothing was deleted; try again shortly.");
  if (/InvalidBucketName|NoSuchBucket/i.test(t)) return new HttpError(502, "STORAGE_BUCKET", "That bucket name is wrong or does not exist.");
  return new HttpError(502, "STORAGE_ERROR", `Backblaze returned an error (${status}).`);
}

export async function filesRoutes(c) {
  const { req, env, path, method, url } = c;
  const db = env.DB;
  let m;

  // ---------- status board ----------
  if (path === "/api/storage" && method === "GET") {
    const cfg = readConfig(env);
    const problem = cfg && cfg.problem ? cfg.problem : null;
    const good = !!cfg && !problem;
    const used = await usedBytes(db);
    const total = quotaBytes(env);
    const rows = await list(db, "SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200");
    const trash = await one(db, "SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NOT NULL");
    return json({
      configured: good,
      configProblem: problem,
      provider: "Backblaze B2",
      bucket: good ? cfg.bucket : (env.B2_BUCKET || "").trim(),
      endpoint: good ? cfg.endpoint : (env.B2_ENDPOINT || "").trim(),
      region: good ? cfg.region : "",
      usedBytes: used,
      totalBytes: total,
      remainingBytes: Math.max(0, total - used),
      full: used >= total,
      fileCount: rows.length,
      deletedCount: Number(trash?.n || 0),
      limits: { imageBytes: maxImage(env), otherBytes: maxOther(env) },
      files: rows.map(publicFile),
    });
  }

  // ---------- connection test ----------
  if (path === "/api/storage/test" && method === "POST") {
    const cfg = needStorage(env);
    const t0 = Date.now();
    let res;
    try { res = await s3Request(cfg, { method: "GET", query: "list-type=2&max-keys=1" }); }
    catch (e) { throw new HttpError(504, "STORAGE_UNREACHABLE", "Could not reach Backblaze: " + (e && e.message || e)); }
    if (!res.ok) throw b2Error(res.status, await res.text().catch(() => ""));
    const xml = await res.text();
    const objects = (xml.match(/<Key>/g) || []).length;
    await audit(env, "storage_test_ok", `${cfg.bucket} reachable`);
    return json({ ok: true, ms: Date.now() - t0, bucket: cfg.bucket, region: cfg.region, sampleObjects: objects });
  }

  // ---------- upload ----------
  if (path === "/api/files" && method === "POST") {
    const cfg = needStorage(env);
    const name = safeName(decodeURIComponent(req.headers.get("X-File-Name") || ""));
    const mime = (req.headers.get("Content-Type") || "application/octet-stream").split(";")[0].trim().slice(0, 120);
    const declared = parseInt(req.headers.get("Content-Length") || "0", 10) || 0;

    const cap = isImage(mime) ? maxImage(env) : maxOther(env);
    if (declared > cap) {
      throw new HttpError(413, "FILE_TOO_LARGE",
        `${isImage(mime) ? "Images" : "Files"} are limited to ${Math.round(cap / MB)} MB. This one is ${(declared / MB).toFixed(1)} MB.`);
    }
    const total = quotaBytes(env), used = await usedBytes(db);
    // Hard stop: refuse before a single byte leaves the device. No upgrade, no provider switch, no auto-delete.
    if (used + Math.max(declared, 0) > total) {
      throw new HttpError(507, "STORAGE_FULL",
        `Storage is full: ${(used / GI).toFixed(2)} GB used of ${(total / GI).toFixed(2)} GB. Delete something, or raise STORAGE_QUOTA_BYTES if you have more free space. Nothing was uploaded and nothing was deleted.`,
        { used, total });
    }

    const body = await req.arrayBuffer();
    if (body.byteLength === 0) throw bad("The file is empty.", "EMPTY_FILE");
    if (body.byteLength > cap) throw new HttpError(413, "FILE_TOO_LARGE", `That file is larger than the ${Math.round(cap / MB)} MB limit.`);
    if (used + body.byteLength > total) throw new HttpError(507, "STORAGE_FULL", "Storage is full. Nothing was uploaded.");

    const key = keyFor(name);
    const sha256 = await sha256Hex(body);
    let res;
    try {
      res = await s3Request(cfg, {
        method: "PUT", key, body, contentType: mime,
        payloadHash: sha256,
      });
    } catch (e) {
      throw new HttpError(504, "STORAGE_UNREACHABLE", "The upload could not reach Backblaze: " + (e && e.message || e));
    }
    if (!res.ok) throw b2Error(res.status, await res.text().catch(() => ""));

    const id = uid(), t = now();
    await run(db, "INSERT INTO files(id,name,mime,size_bytes,storage_key,provider,sha256,created_at) VALUES(?,?,?,?,?,'b2',?,?)",
      id, name, mime, body.byteLength, key, sha256, t);
    await audit(env, "file_uploaded", `${name} (${body.byteLength} bytes)`);
    return json({ file: publicFile({ id, name, mime, size_bytes: body.byteLength, sha256, created_at: t, provider: "b2" }) }, 201);
  }

  // ---------- list ----------
  if (path === "/api/files" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
    const rows = q
      ? await list(db, "SELECT * FROM files WHERE deleted_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT 200", "%" + q.replace(/[\\%_]/g, "\\$&") + "%")
      : await list(db, "SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 200");
    return json({ files: rows.map(publicFile) });
  }

  // ---------- suggestions: AI may point at files, never remove them ----------
  if (path === "/api/storage/suggestions" && method === "GET") {
    const rows = await list(db, "SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 500");
    const byHash = new Map();
    for (const r of rows) { if (!byHash.has(r.sha256)) byHash.set(r.sha256, []); byHash.get(r.sha256).push(r); }
    const dupes = [...byHash.values()].filter((g) => g.length > 1).map((g) => ({
      reason: "duplicate", totalBytes: g.reduce((s, r) => s + r.size_bytes, 0) - g[0].size_bytes,
      files: g.map(publicFile),
    }));
    const cutoffOld = Date.now() - 90 * 86400000;
    return json({
      large: rows.filter((r) => r.size_bytes > 5 * MB).map(publicFile).slice(0, 50),
      old: rows.filter((r) => Date.parse(r.created_at) < cutoffOld).map(publicFile).slice(0, 50),
      duplicates: dupes.slice(0, 20),
      note: "Suggestions only. Nothing is deleted unless you confirm it yourself.",
    });
  }

  // ---------- download ----------
  m = path.match(/^\/api\/files\/([0-9a-f-]{36})\/download$/);
  if (m && method === "GET") {
    const cfg = needStorage(env);
    const row = await one(db, "SELECT * FROM files WHERE id=? AND deleted_at IS NULL", m[1]);
    if (!row) throw new HttpError(404, "NOT_FOUND", "That file is not in the index.");
    let res;
    try { res = await s3Request(cfg, { method: "GET", key: row.storage_key }); }
    catch (e) { throw new HttpError(504, "STORAGE_UNREACHABLE", "Could not reach Backblaze: " + (e && e.message || e)); }
    if (!res.ok) throw b2Error(res.status, await res.text().catch(() => ""));
    const headers = new Headers();
    headers.set("Content-Type", row.mime || "application/octet-stream");
    headers.set("Content-Length", String(row.size_bytes));
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    return new Response(res.body, { status: 200, headers });
  }

  // ---------- delete (explicit owner confirmation required) ----------
  m = path.match(/^\/api\/files\/([0-9a-f-]{36})$/);
  if (m && method === "DELETE") {
    const cfg = needStorage(env);
    const row = await one(db, "SELECT * FROM files WHERE id=? AND deleted_at IS NULL", m[1]);
    if (!row) throw new HttpError(404, "NOT_FOUND", "That file is already gone.");
    if (url.searchParams.get("confirm") !== row.name) {
      throw new HttpError(400, "CONFIRM_REQUIRED", "Type the file name to confirm deleting it.");
    }
    let res;
    try { res = await s3Request(cfg, { method: "DELETE", key: row.storage_key }); }
    catch (e) { throw new HttpError(504, "STORAGE_UNREACHABLE", "Could not reach Backblaze: " + (e && e.message || e)); }
    if (!res.ok && res.status !== 404) throw b2Error(res.status, await res.text().catch(() => ""));
    await run(db, "UPDATE files SET deleted_at=? WHERE id=?", now(), row.id);
    await audit(env, "file_deleted", `${row.name} (${row.size_bytes} bytes)`);
    return json({ ok: true, freed: row.size_bytes });
  }

  return null;
}
