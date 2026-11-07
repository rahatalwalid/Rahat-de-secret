# Rahat DeSecret v0.2

A private, owner-only AI workstation that runs on Cloudflare Workers + D1. Free-only by design.

**What works now:** owner login (PBKDF2, throttling, revocable sessions, CSRF, optional authenticator 2FA), streaming chat with a
searchable free-model picker, a provider router (OpenRouter, Groq, Cerebras, Hugging Face, Workers AI, plus custom OpenAI-compatible),
agents, projects, tasks with history, long-term memory that is retrieved into chats, dashboard, audit log.

**Not built yet** (see docs/STATUS.md): approval queue, multi-agent orchestration, tool registry. They are next.

```
wrangler.toml        Worker config (name must equal your existing Worker: rahatdesecret)
worker/src/          API: auth.js, llm.js (providers + router), crud.js, lib/
public/              Frontend (vanilla JS, no build step) + _headers (CSP)
tests/               run.mjs (backend), e2e.mjs (browser), D1 shim
docs/                SETUP.md, PROVIDERS.md, STATUS.md
```

Run the tests locally (Node 22+): `npm test`. Setup guide: `docs/SETUP.md`.
Deployed from Cloudflare.
