// Storage layer tests. Backblaze B2 is mocked at the fetch level; D1 uses the SQLite shim.
// Proves the hard-stop rules without touching a real bucket.
import worker from "../worker/src/index.js";
import { makeD1 } from "./d1shim.mjs";

const ORIGIN = "https://app.test";
const ENDPOINT = "https://s3.us-west-004.backblazeb2.com";
const BUCKET = "test-bucket";

let pass = 0, fail = 0;
const ok = (cond, name, extra) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${!cond && extra !== undefined ? "  -> " + JSON.stringify(extra).slice(0, 300) : ""}`);
};

// ---------- fake B2 ----------
const store = new Map();      // key -> Uint8Array
const calls = [];             // { method, url, headers }
let b2Down = false, b2Status = 0;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (!u.startsWith(ENDPOINT)) throw new Error("unexpected fetch to " + u);
  const method = (init.method || "GET").toUpperCase();
  calls.push({ method, url: u, headers: init.headers || {} });
  if (b2Down) throw new Error("network down");
  if (b2Status) return new Response("<Error><Code>AccessDenied</Code></Error>", { status: b2Status });
  const path = new URL(u).pathname.replace(/^\//, "");
  const key = path.split("/").slice(1).join("/");
  if (method === "PUT") {
    const body = init.body instanceof ArrayBuffer ? new Uint8Array(init.body) : new Uint8Array(0);
    store.set(key, body);
    return new Response(null, { status: 200, headers: { etag: '"abc"' } });
  }
  if (method === "GET" && !key) {
    const keys = [...store.keys()].slice(0, 1);
    return new Response(`<?xml version="1.0"?><ListBucketResult><KeyCount>${keys.length}</KeyCount>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join("")}</ListBucketResult>`, { status: 200 });
  }
  if (method === "GET") {
    const v = store.get(key);
    if (!v) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    return new Response(v, { status: 200 });
  }
  if (method === "DELETE") { store.delete(key); return new Response(null, { status: 204 }); }
  return new Response("?", { status: 400 });
};

// ---------- harness ----------
function makeEnv(extra = {}) {
  return {
    DB: makeD1(), SETUP_TOKEN: "s".repeat(32), PBKDF2_ITERATIONS: "10000",
    ASSETS: { fetch: async () => new Response("asset") },
    ...extra,
  };
}
const CFG = { B2_BUCKET: BUCKET, B2_ENDPOINT: ENDPOINT, B2_KEY_ID: "keyid", B2_APP_KEY: "appkey" };

function client(env) {
  const jar = { cookie: "", csrf: "" };
  async function call(method, path, body, opts = {}) {
    const headers = { Origin: ORIGIN, "CF-Connecting-IP": "1.2.3.4", ...(opts.headers || {}) };
    if (jar.cookie) headers.Cookie = jar.cookie;
    if (jar.csrf && method !== "GET") headers["X-CSRF-Token"] = jar.csrf;
    let payload;
    if (body instanceof Uint8Array) payload = body;
    else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers, body: payload }), env, { waitUntil() {} });
    const sc = res.headers.get("set-cookie");
    if (sc) { const p = sc.split(";")[0]; jar.cookie = p.endsWith("=") ? "" : p; }
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("json") ? await res.json().catch(() => null) : null;
    if (data && data.csrf) jar.csrf = data.csrf;
    return { status: res.status, data, headers: res.headers, res };
  }
  return { call, jar };
}

const PW = "correct horse battery 9";
async function ready(extra = {}) {
  const env = makeEnv(extra);
  const c = client(env);
  const r = await c.call("POST", "/api/auth/setup", { setupToken: env.SETUP_TOKEN, password: PW });
  if (r.status !== 200) throw new Error("setup failed: " + JSON.stringify(r.data));
  return { env, c };
}
const bytes = (n, fill = 7) => new Uint8Array(n).fill(fill);
const up = (c, name, data, mime = "application/octet-stream") =>
  c.call("POST", "/api/files", data, { headers: { "X-File-Name": encodeURIComponent(name), "Content-Type": mime } });

// ---------- tests ----------
async function testUnconfigured() {
  const { c } = await ready();
  let r = await c.call("GET", "/api/storage");
  ok(r.status === 200 && r.data.configured === false, "storage reports not-configured on a fresh install", r.data);
  r = await up(c, "a.txt", bytes(10), "text/plain");
  ok(r.status === 503 && r.data.error === "STORAGE_NOT_CONFIGURED", "upload refuses cleanly when B2 is not set up", r.data);
  ok(calls.length === 0, "no network call was made without credentials");
}

async function testHappyPath() {
  calls.length = 0; store.clear();
  const { env, c } = await ready(CFG);

  let r = await c.call("GET", "/api/storage");
  ok(r.data.configured === true && r.data.totalBytes === 10 * 1024 ** 3, "configured storage shows the 10 GB free quota", r.data);

  r = await c.call("POST", "/api/storage/test", {});
  ok(r.status === 200 && r.data.ok === true, "connection test reaches the bucket", r.data);

  r = await up(c, "photo.jpg", bytes(2048, 5), "image/jpeg");
  ok(r.status === 201 && r.data.file.name === "photo.jpg", "small image uploads", r.data);
  ok(r.data.file.size === 2048, "stored size matches the bytes sent");
  ok(/^rds\/\d{4}\/\d{2}\/[0-9a-f-]{36}\/photo\.jpg$/.test([...store.keys()][0]), "object key is dated and unique", [...store.keys()]);
  const putCall = calls.find((x) => x.method === "PUT");
  ok(/^AWS4-HMAC-SHA256 Credential=keyid\/\d{8}\/us-west-004\/s3\/aws4_request/.test(putCall.headers.authorization || ""), "request is signed with SigV4", putCall.headers.authorization);
  ok(!("host" in putCall.headers) || putCall.headers.host === undefined, "host header is left to fetch");

  r = await c.call("GET", "/api/files");
  ok(r.data.files.length === 1, "file appears in the index");

  r = await c.call("GET", `/api/files/${r.data.files[0].id}/download`);
  ok(r.status === 200 && r.headers.get("content-disposition").includes("photo.jpg"), "download streams with an attachment header", r.status);
  ok(r.headers.get("x-content-type-options") === "nosniff", "downloads are sniff-protected");

  r = await c.call("GET", "/api/files", undefined);
  const id = r.data.files[0].id;
  r = await c.call("DELETE", `/api/files/${id}`);
  ok(r.status === 400 && r.data.error === "CONFIRM_REQUIRED", "delete without typing the name is refused", r.data);
  r = await c.call("DELETE", `/api/files/${id}?confirm=photo.jpg`);
  ok(r.status === 200 && r.data.freed === 2048, "confirmed delete frees the space", r.data);
  ok(store.size === 0, "the object is really gone from the bucket");
}

async function testHardStop() {
  calls.length = 0; store.clear();
  const { c } = await ready({ ...CFG, STORAGE_QUOTA_BYTES: String(1024 * 1024) });   // 1 MB quota

  let r = await up(c, "big.bin", bytes(800 * 1024));
  ok(r.status === 201, "first upload fits", r.status);

  const before = calls.filter((x) => x.method === "PUT").length;
  r = await up(c, "second.bin", bytes(800 * 1024));
  ok(r.status === 507 && r.data.error === "STORAGE_FULL", "upload past the quota is refused with 507", r.data);
  ok(calls.filter((x) => x.method === "PUT").length === before, "the refused upload never reached Backblaze");

  r = await c.call("GET", "/api/storage");
  ok(r.data.remainingBytes === 224 * 1024, "status reports the true remainder", r.data.remainingBytes);
  ok(r.data.files.length === 1, "the existing file was preserved, not deleted", r.data.files.length);
  r = await up(c, "toobig.bin", bytes(300 * 1024));
  ok(r.status === 507, "an upload that would overflow the remainder is still refused", r.status);

  // deleting frees space again, and only then does upload work
  const st = await c.call("GET", "/api/storage");
  const id = st.data.files[0].id;
  await c.call("DELETE", `/api/files/${id}?confirm=big.bin`);
  r = await up(c, "third.bin", bytes(800 * 1024));
  ok(r.status === 201, "upload works again after the owner frees space", r.status);
}

async function testSizeLimits() {
  calls.length = 0; store.clear();
  const { c } = await ready({ ...CFG, MAX_IMAGE_BYTES: String(1024), MAX_FILE_BYTES: String(4096) });

  let r = await up(c, "big.jpg", bytes(2048), "image/jpeg");
  ok(r.status === 413 && r.data.error === "FILE_TOO_LARGE", "image over the image limit is refused", r.data);
  r = await up(c, "doc.pdf", bytes(8192), "application/pdf");
  ok(r.status === 413, "other file over the other limit is refused", r.status);
  r = await up(c, "ok.jpg", bytes(1000), "image/jpeg");
  ok(r.status === 201, "a file just under the limit is accepted", r.status);
  r = await up(c, "empty.txt", new Uint8Array(0), "text/plain");
  ok(r.status === 400 && r.data.error === "EMPTY_FILE", "empty uploads are rejected", r.data);
}

async function testStorageErrors() {
  calls.length = 0; store.clear();
  const { c } = await ready(CFG);

  b2Status = 403;
  let r = await up(c, "x.txt", bytes(10), "text/plain");
  ok(r.status === 502 && r.data.error === "STORAGE_AUTH", "a rejected key is explained clearly", r.data);
  r = await c.call("POST", "/api/storage/test", {});
  ok(r.status === 502 && r.data.error === "STORAGE_AUTH", "connection test reports a bad key", r.data);

  b2Status = 0; b2Down = true;
  r = await up(c, "y.txt", bytes(10), "text/plain");
  ok(r.status === 504 && r.data.error === "STORAGE_UNREACHABLE", "network failure is reported, not swallowed", r.data);
  b2Down = false;

  r = await c.call("GET", "/api/storage");
  ok(r.data.files.length === 0 && r.data.usedBytes === 0, "failed uploads leave no phantom rows", r.data);
}

async function testSuggestions() {
  calls.length = 0; store.clear();
  const { c } = await ready(CFG);
  await up(c, "a.bin", bytes(100, 1));
  await up(c, "b.bin", bytes(100, 1));      // identical bytes -> duplicate
  const r = await c.call("GET", "/api/storage/suggestions");
  ok(r.status === 200 && Array.isArray(r.data.duplicates), "suggestions endpoint answers", r.data && Object.keys(r.data));
  ok(r.data.duplicates.length === 1, "identical files are detected as duplicates", r.data.duplicates.length);
  ok(/nothing is deleted/i.test(r.data.note), "suggestions state that nothing is auto-deleted");
  const before = (await c.call("GET", "/api/files")).data.files.length;
  ok(before === 2, "suggestions never remove files");
}

async function testAuthGate() {
  const env = makeEnv(CFG);
  const c = client(env);
  let r = await c.call("GET", "/api/storage");
  ok(r.status === 401, "storage is owner-only", r.status);
  r = await up(c, "a.txt", bytes(4), "text/plain");
  ok(r.status === 401, "uploads require a session", r.status);

  // CSRF
  await c.call("POST", "/api/auth/setup", { setupToken: env.SETUP_TOKEN, password: PW });
  const saved = c.jar.csrf; c.jar.csrf = "wrong";
  r = await up(c, "b.txt", bytes(4), "text/plain");
  ok(r.status === 403 && r.data.error === "CSRF", "uploads without the CSRF token are refused", r.data);
  c.jar.csrf = saved;
  r = await up(c, "c.txt", bytes(4), "text/plain");
  ok(r.status === 201, "the same upload succeeds with the token", r.status);
}

await testUnconfigured();
await testHappyPath();
await testHardStop();
await testSizeLimits();
await testStorageErrors();
await testSuggestions();
await testAuthGate();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
