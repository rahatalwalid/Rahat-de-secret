# File storage (v0.3) — Backblaze B2

## What this is, in one paragraph

Binary files (images, PDFs, documents, audio, video) are stored in **Backblaze B2**, which gives you **10 GB free, forever, with no credit card**. Your D1 database stores only the file's name, type, size, checksum and B2 key — never the file itself. When the 10 GB is used up, uploads are refused. Nothing is ever upgraded, moved to another provider, or deleted automatically.

## Why B2 and not MEGA

| | Backblaze B2 | MEGA |
|---|---|---|
| Free space | 10 GB | 20 GB |
| Credit card needed | No | No |
| Where the work happens | **Cloudflare Worker** (like your OpenRouter key) | Phone's browser (Cloudflare Free gives only 10 ms of CPU per request — not enough to encrypt a 30 MB file) |
| Your account password in the app | **Never** | Would be needed in the browser |
| Extra library to trust | None | An unofficial third-party SDK |

MEGA has twice the space, but it cannot be driven from a Cloudflare Worker on the free plan, and it would require typing your MEGA password into the app. B2 keeps everything server-side, exactly like the API keys you already manage. If 10 GB turns out to be too small, we revisit it then.

## Setup — from an Android phone

### 1. Create the bucket

1. Go to **backblaze.com** → **Sign up** for **B2 Cloud Storage**. It does **not** ask for a card.
2. Confirm your email.
3. **Buckets → Create a Bucket**
   - **Bucket Unique Name:** `rahat-desecret` (must be globally unique — add a number if taken)
   - **Files in Bucket are:** **Private** ← important
   - **Default Encryption:** leave off
   - **Region:** pick the one nearest you, e.g. `us-west-004`
4. Open the bucket afterwards and note the **Endpoint**, e.g. `https://s3.us-west-004.backblazeb2.com`

### 2. Create a key

**Application Keys → Add a New Application Key**

- **Name:** `rahat-desecret-app`
- **Allow access to Bucket(s):** choose only `rahat-desecret`
- **Type of Access:** **Read and Write**
- Create it. It shows **keyID** and **applicationKey** **once** — copy both now.

### 3. Put the four values into Cloudflare

Worker **`rahatdesecret`** → **Settings** → **Variables and Secrets** → add:

| Name | Type | Value |
|---|---|---|
| `B2_BUCKET` | Text | `rahat-desecret` |
| `B2_ENDPOINT` | Text | `https://s3.us-west-004.backblazeb2.com` |
| `B2_KEY_ID` | **Secret** | the keyID |
| `B2_APP_KEY` | **Secret** | the applicationKey |

Optional, if you want different limits:

| Name | Default | Meaning |
|---|---|---|
| `STORAGE_QUOTA_BYTES` | `10737418240` (10 GB) | When used space reaches this, uploads stop |
| `MAX_IMAGE_BYTES` | `10485760` (10 MB) | Largest image |
| `MAX_FILE_BYTES` | `31457280` (30 MB) | Largest anything else |

### 4. Use it

Open your site → **More → Files** → tap **Test**. You should see *"Connected to rahat-desecret in 120 ms"*. Then **Upload**.

## The rules this feature enforces

These are not warnings in a document — they are enforced in `worker/src/files.js`:

- **Hard stop.** Before a byte is read, the Worker compares used space + this file's size against `STORAGE_QUOTA_BYTES`. Over the line → `507 STORAGE_FULL`, upload refused. No upgrade path exists anywhere in the code.
- **No provider switching.** The provider is a fixed column on each row. There is no code that moves a file elsewhere.
- **Nothing is auto-deleted.** Files are only removed by an explicit delete in the UI, which requires typing the file name to confirm.
- **Existing files survive a full disk.** Reaching the quota makes the app read-only for uploads; it does not touch a single stored file.
- **Suggestions are suggestions.** `GET /api/storage/suggestions` lists large, old and duplicate files. It has no delete path at all.
- **Size limits** are enforced twice: from the declared `Content-Length` before reading, then again from the actual byte count.
- **Owner only.** Every route runs through the same session + CSRF checks as the rest of the app.

## Honest limits

- **10 GB is 10 GB.** B2's free allowance is the first 10 GB of storage; downloads are free up to 3× what you store. If you store 10 GB, roughly 30 GB of downloads per month is free.
- **Never add a payment method to Backblaze.** With no card on file, B2 cannot bill you. The app's own quota check should stop you long before B2's limit, but the second guard matters.
- **Uploads pass through the Worker**, so a 30 MB file costs 30 MB of Worker memory while it is copied to B2. The Free plan allows 128 MB, so this is safe, but do not raise `MAX_FILE_BYTES` past ~50 MB without thinking about it.
- **Tested against a mock, not against Backblaze.** `tests/storage.mjs` mocks the S3 endpoint and proves the logic, the hard stop and the error handling — 39 tests. It has **not** been run against a real bucket, because that needs your credentials. The **Test** button in the Files view is that verification; if it fails it will tell you exactly which setting is wrong.

## If something goes wrong

| Message | Meaning |
|---|---|
| `STORAGE_NOT_CONFIGURED` | One of the four values is missing in Cloudflare |
| `STORAGE_AUTH` | `B2_KEY_ID` / `B2_APP_KEY` wrong, or the key is not allowed to use this bucket |
| `STORAGE_BUCKET` / 404 | `B2_BUCKET` name wrong, or `B2_ENDPOINT` points at the wrong region |
| `STORAGE_BUSY` | Backblaze is rate-limiting. Nothing was lost; retry |
| `STORAGE_FULL` | Quota reached. Delete something, or raise `STORAGE_QUOTA_BYTES` if you bought/earned more space |
| `FILE_TOO_LARGE` | Over the 10 MB image / 30 MB other limit |
