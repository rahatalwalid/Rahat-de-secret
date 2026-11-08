# rahatdesecret — v0.6

A private, owner-only AI workspace on Cloudflare Workers + D1. Free-only by design.

**Current shape:** chat is the home screen; a free model is resolved automatically by the server, so there is no model picker or model name in the chat UI. Agent and project selection live behind Chat settings. The interface uses a black, centred chat layout with a floating composer. Model administration remains under Settings → Advanced → Models.

The app also includes owner login (PBKDF2, throttling, revocable sessions, CSRF, optional authenticator 2FA), conversations, agents, projects, tasks, memory, file metadata with Backblaze B2 storage (10 GB hard stop; images ≤10 MB, other files ≤30 MB), a seeded **Rahat CEO** agent, and diagnostics.

**Important v0.6 fix:** existing databases may have an `audit_log` table without the `detail` column. The schema-v4 migration adds the missing column without resetting data or replacing the owner record. The legacy-schema regression tests recreate that exact database condition and exercise delete-chat, overview, settings, and audit endpoints.

**Not built yet:** approval queue, multi-agent orchestration, and external-action tools. Nothing posts or sends before an approval queue exists.

```
wrangler.toml        Worker config (name must equal your existing Worker: rahatdesecret)
worker/src/          API: auth.js, llm.js (providers + router), crud.js, lib/
public/              Frontend (vanilla JS, no build step) + _headers (CSP)
worker/src/files.js  File index + B2 upload/download/delete + quota enforcement
worker/src/lib/s3.js SigV4 signing with Web Crypto only
tests/               run.mjs (backend), storage.mjs, D1 shim, legacy schema fixture
docs/                SETUP.md, PROVIDERS.md, STATUS.md
```

Run tests with Node 22+: `npm test` (114 backend + 46 storage tests). `npm run check` checks the Worker and frontend syntax. The visual design has not been browser-verified in this sandbox. Setup: `docs/SETUP.md`; storage: `docs/STORAGE.md`.
