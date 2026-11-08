// AWS Signature V4 for the Backblaze B2 S3-compatible API, using only Web Crypto.
// No Node APIs, no dependencies, runs in a Cloudflare Worker.
const enc = new TextEncoder();
const HEX = [...Array(256)].map((_, i) => i.toString(16).padStart(2, "0"));
const hex = (buf) => { const b = new Uint8Array(buf); let s = ""; for (const x of b) s += HEX[x]; return s; };

export const sha256Hex = async (data) =>
  hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, typeof data === "string" ? enc.encode(data) : data));
}

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encodeKeyPath = (p) => p.split("/").map(rfc3986).join("/");

function amzStamp(d = new Date()) {
  const iso = d.toISOString().replace(/[-:]|\.\d{3}/g, ""); // 20261108T022000Z
  return { long: iso, short: iso.slice(0, 8) };
}

/** Signs a request for an S3-compatible endpoint and returns the headers to send. */
export async function signS3({ method, host, bucket, key = "", query = "", region, accessKey, secretKey, payloadHash, contentType, extraHeaders = {} }) {
  const { long, short } = amzStamp();
  const canonicalUri = "/" + rfc3986(bucket) + (key ? "/" + encodeKeyPath(key) : "");
  const payload = payloadHash || "UNSIGNED-PAYLOAD";

  const headers = { host, "x-amz-content-sha256": payload, "x-amz-date": long };
  if (contentType) headers["content-type"] = contentType;
  for (const [k, v] of Object.entries(extraHeaders)) headers[k.toLowerCase()] = v;

  const lower = (s) => String(s).trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((k) => `${k}:${lower(headers[k])}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payload].join("\n");
  const scope = `${short}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", long, scope, await sha256Hex(canonicalRequest)].join("\n");

  const kDate = await hmac(enc.encode("AWS4" + secretKey), short);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, "s3");
  const kSigning = await hmac(kService, "aws4_request");
  const signature = hex(await hmac(kSigning, stringToSign));

  const out = {};
  for (const [k, v] of Object.entries(headers)) if (k !== "host") out[k] = v;
  out.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return out;
}

/** Reads B2 settings from the Worker environment. Returns null when unset, or {problem} when malformed. */
export function readConfig(env) {
  const bucket = (env.B2_BUCKET || "").trim();
  const keyId = (env.B2_KEY_ID || "").trim();
  const appKey = (env.B2_APP_KEY || "").trim();
  let raw = (env.B2_ENDPOINT || "").trim();
  if (!raw || !bucket || !keyId || !appKey) return null;

  // Forgiving by design: accept a missing scheme, a trailing slash, or a pasted URL.
  let endpoint = raw.replace(/\/+$/, "");
  if (!/^[a-z]+:\/\//i.test(endpoint)) endpoint = "https://" + endpoint;
  endpoint = endpoint.replace(/^http:\/\//i, "https://");

  let host;
  try { host = new URL(endpoint).host; } catch {
    return { problem: "B2_ENDPOINT is not a valid address. It should be https://s3.<region>.backblazeb2.com" };
  }
  if (!host.endsWith(".backblazeb2.com")) {
    return { problem: `B2_ENDPOINT points at "${host}", which is not a Backblaze address. It should look like https://s3.us-west-004.backblazeb2.com` };
  }
  const m = host.match(/(?:^|\.)s3\.([a-z0-9-]+)\.backblazeb2\.com$/i);
  if (!m) {
    return { problem: `B2_ENDPOINT is missing the "s3." part. It should be https://s3.<region>.backblazeb2.com — not the f001.backblazeb2.com/file/... download link.` };
  }
  return { endpoint, bucket, keyId, appKey, region: m[1], host };
}

/** One signed call. Returns the raw Response so callers can stream bodies. */
export async function s3Request(cfg, { method, key = "", query = "", body, contentType, payloadHash, extraHeaders, signal }) {
  const headers = await signS3({
    method, host: cfg.host, bucket: cfg.bucket, key, query,
    region: cfg.region, accessKey: cfg.keyId, secretKey: cfg.appKey,
    payloadHash, contentType, extraHeaders,
  });
  const url = `${cfg.endpoint}/${rfc3986(cfg.bucket)}${key ? "/" + encodeKeyPath(key) : ""}${query ? "?" + query : ""}`;
  return fetch(url, { method, headers, body, signal });
}
