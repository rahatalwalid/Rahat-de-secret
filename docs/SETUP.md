# Setup (no computer needed)

Never paste passwords or API keys into any chat. Secrets go only into Cloudflare's "Secret" fields.

## 1. Put the files in GitHub
**From a phone, no computer:**
1. In your repo, tap **Add file > Upload files** and upload `rahat-desecret-v0.2.zip` to the repo root. Commit.
2. Tap **Add file > Create new file**, name it exactly `.github/workflows/unpack.yml`, paste the contents of the `unpack.yml` file, commit.
3. Open the **Actions** tab, choose **Unpack release zip**, tap **Run workflow**. When it finishes, the repo contains the real files.
   (GitHub Actions is documented as free for public repositories; check the Actions page if it asks for anything.)

**With a computer or Codespace:** `unzip rahat-desecret-v0.2.zip`, commit and push.

## 2. Fix the database ID
Cloudflare dashboard > Storage & Databases > D1 > `rahat-desecret-db`: copy the **Database ID** (not a secret).
In GitHub, open `wrangler.toml`, tap the pencil, replace `REPLACE_WITH_D1_DATABASE_ID`, commit.

## 3. Connect the Worker to the repo
Workers & Pages > `rahatdesecret` > Settings > Build (Git repository) > Connect. Choose this repo, root `/`,
keep the default deploy command (`npx wrangler deploy`). The Worker name in `wrangler.toml` already matches.

## 4. Add secrets (Settings > Variables and Secrets > type **Secret**)
| Name | Value |
|---|---|
| `SETUP_TOKEN` | 40+ random characters you make up and save in a password manager. Needed once to create the owner account, and later for break-glass password reset. |
| `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `HF_TOKEN` | Only for providers you choose to use. |

## 5. First run
Open `https://rahatdesecret.<your-subdomain>.workers.dev`. You will see "Create your owner account": enter the setup token and choose a
password (12+ characters). Then Settings > Two-step sign-in is recommended.

## 6. Turn on a free provider
Models > pick a provider > read its terms yourself > tick the confirmation > Turn on > Sync models > Settings default model.
Workers AI needs no key (the `AI` binding is in `wrangler.toml`); press **Test** on a model to confirm it runs on your account.

## If login fails with a CPU-limit error
Password hashing is the heaviest step on the Free plan. It runs only at sign-in. If Cloudflare logs show "exceeded CPU", set a
`PBKDF2_ITERATIONS` variable lower (minimum 10000; default and maximum 100000) and use a long random password to compensate.
Existing hashes keep working because the iteration count is stored with each hash.

## Locked out?
Use "Forgot password" on the sign-in page with your `SETUP_TOKEN`. It resets the password, turns off 2FA and signs out all devices.
