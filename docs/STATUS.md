# Status and security checklist (v0.6)

## Implemented and tested locally
114 backend integration tests + 46 storage tests pass against the SQLite-backed D1 shim and mocked storage/provider responses. No browser visual or real-Cloudflare verification is claimed.
- Owner setup guarded by SETUP_TOKEN; PBKDF2-SHA256 hashing; constant-time compares; HttpOnly + SameSite=Strict (+Secure on https) cookie
- Sessions stored hashed in D1: logout and password change revoke them server-side; idle + absolute expiry; device list and revoke
- Login throttling per client (5 failures, 15 min lock, one DB row per client, no write amplification); no global lockout
- CSRF token + Origin check on every state-changing request; security headers on API; strict CSP for static files
- Optional TOTP 2FA with replay protection and encrypted secret; break-glass reset via SETUP_TOKEN
- Additive migrations that preserved legacy v0.1 rows (conversations, messages, agents, tasks, memory)
- Conversations (create, rename, pin, delete, title search), streaming + non-streaming chat, partial replies saved on Stop
- Provider router, catalog sync, free-only gating, quota / rate-limit / invalid-key / missing-secret handling, cooldown, usage records
- Agents (templates, pause/activate), projects, tasks (statuses, priority, deadline, progress, history), memory (categories, search, pinned, retrieval shown per reply)
- Dashboard from real data; audit log

## Implemented but NOT tested on real Cloudflare
Everything above has only run locally. Unverified there: D1 behavior and quotas, Workers CPU limit for password hashing,
Workers AI binding calls and model names, real provider responses (OpenRouter `max_price`, Groq/Cerebras/HF catalog shapes),
very large catalog syncs under the Free CPU limit, `_headers` handling, Workers Builds deploy.

## Added in v0.6
- **Root cause of the 500:** the existing production `audit_log` table had no `detail` column. `CREATE TABLE IF NOT EXISTS` does not change an existing table, so queries that selected `detail` failed.
- Schema v4 additively adds the missing column if needed; it does not drop tables, reset data, or overwrite the owner record. SQL run only if the column is absent: `ALTER TABLE audit_log ADD COLUMN detail TEXT NOT NULL DEFAULT '';`
- `tests/fixtures/legacy_schema.sql` deliberately reproduces the missing-column production schema. Regression coverage checks `/api/settings`, deleting an old chat, `/api/overview`, and `/api/audit` after migration.
- `/api/overview` no longer selects `audit_log.detail` at all
- No model name or model chip is shown in the chat; the model is still administered under Settings → Advanced → Models
- Agent/project pickers moved out of the chat header into a small menu
- Grok-style layout: pure black canvas, centred 768px column, round composer

## Added in v0.5
- Complete visual rebuild: new stylesheet (design system v1), top-bar shell instead of a left rail, mobile bottom bar
- Wordmark is `rahatdesecret`
- Model selection is automatic (`resolveDefaultModel`): saved default first, otherwise the best free model on an enabled provider. Chat never displays the model name
- Conversation deletion explicitly deletes its messages; this is a robustness measure, not the cause of the reported 500
- Unhandled 500s now return the real error text in `message`/`detail` (single-owner private app only) instead of "Something went wrong on the server."

## Added in v0.4
- Chat is the home screen; unknown routes fall back to chat
- Main navigation reduced to Chat, Projects, Agents, Memory, Files, Settings (Tasks and Models moved under Settings → Advanced; nothing was deleted)
- Grey/black theme
- `Rahat CEO` agent seeded once (`INSERT OR IGNORE`, id `rahat-ceo`) and preselected for new chats
- `GET /api/diagnostics` — per-table health checks so a failure names the broken table instead of "Something went wrong"
- The app shell no longer calls `/api/overview`, the endpoint that was returning 500

## Added in v0.3 (file storage)
- `files` table (additive: `CREATE TABLE IF NOT EXISTS`, schema version 2 — no existing table touched)
- Upload, list, download, delete (name-confirmed), storage status, connection test, suggestions
- Hard stop at `STORAGE_QUOTA_BYTES` (default 10 GB): refused before any byte is read, no upgrade path, no provider switch, no auto-delete
- Per-type caps: 10 MB images, 30 MB other (`MAX_IMAGE_BYTES`, `MAX_FILE_BYTES`)
- 46 storage tests pass locally against a mocked B2 endpoint. **Not yet tested against a real bucket** — the Test button in the Files view is that verification.

## Not implemented
Approval queue (and server-side approval enforcement), multi-agent orchestration, tool registry, agent runs, spend/usage quotas UI,
content search across messages, message regeneration/editing, PWA, Workers AI catalog auto-sync, R2/file storage.
Until the approval queue exists, nothing in the app performs external actions; agents can only draft text.

## Requires owner action
Real D1 database_id in wrangler.toml; connect the repo to the Worker; add SETUP_TOKEN and provider secrets; read each provider's terms
and confirm eligibility; keep payment methods off these accounts.

## Blocked / limited by platforms
Free model counts are small (docs/PROVIDERS.md). Free quotas can disappear. Streaming replies are saved after the stream ends; if the
connection drops before that, the partial text may be lost (your message is kept).

## Known limits
Rate limiting keys on client IP (mobile IPs change; it only slows guessing). No QR code for 2FA (type the secret). Memory retrieval is keyword-based.
