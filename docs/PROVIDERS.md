# Free provider reality check (checked 7 Nov 2026)

Free tiers change often. The app never trusts this table: each provider stays **off** until you confirm its terms, and
each model must be verified free (OpenRouter by listed price $0; others by the provider's free tier).

| Provider | What "free" means | Limits seen in docs/trackers | Models you can really call |
|---|---|---|---|
| OpenRouter | Models with id ending `:free` (price $0) | 20 requests/min; 50/day until you have ever bought $10 of credits (then 1,000/day). A negative balance returns 402 even on free models. | About 16 free model ids at last check, out of ~470 |
| Groq | Free tier, no card | Per model, e.g. gpt-oss-120b: 30 req/min, 1,000/day, 200K tokens/day. Check your console's limits page. | About 13 hosted models |
| Cerebras | Free tier (third-party list, unverified by me) | ~1M tokens/day, 8K context cap on free, some models only 100 requests/day | A handful |
| Hugging Face | Small monthly free credits, not unlimited | Credit-metered; tracker figures conflict ($0.10/month vs "100K credits"). 402 when used up. Adding a payment method or PRO makes usage billable. | Chat models routed to partner providers |
| Cloudflare Workers AI | 10,000 Neurons/day | Resets 00:00 UTC. Some models require the Paid plan (changelog 2026-07-28). | Tens; the app ships 5 unverified seeds, add others by id |

**On "thousands of models":** free tiers do not offer that. Realistically you get tens of callable free chat models across these
providers. Hugging Face Hub hosts huge numbers of models, but only a curated subset is runnable through free inference.
The picker is built to handle thousands (server-side search, paging), but it can only list what providers truly offer free.

**Not verified, so not enabled:** your eligibility. Each provider's terms may have age or region rules. The app asks you to check
them yourself and records your confirmation. Google AI Studio is intentionally not used.

**How FREE_ONLY is enforced:** no code path calls a model unless provider is on + terms confirmed + model flagged free.
OpenRouter requests also send `max_price` of 0 as a second guard. A used-up quota stops the request; there is no automatic fallback
to another provider. The real protection against charges is not attaching a payment method to any of these accounts.
