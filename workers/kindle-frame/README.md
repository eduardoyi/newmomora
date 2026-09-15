# Momora personal Kindle frame

See [feature documentation](../../docs/features/kindle-frame.md).

Requires Node 22+. Install with `npm ci`; run `npm test`, `npm run typecheck`, and `python3 test/kindle_test.py`.

Deployment uses Wrangler with the configured existing private R2 bucket and Browser Run binding. Run `wrangler whoami` first. Store `SUPABASE_SERVICE_ROLE_KEY`, `FRAME_OWNER_ID`, `FRAME_FAMILY_ID`, `FRAME_TOKEN_HASH` and `ADMIN_TOKEN_HASH` via Wrangler secrets. Never commit their values. `npm run deploy` publishes the Worker and nightly trigger. Invoke `/prepare` with the separate admin credential to provision the first batch; repeated calls on the same day reuse it.

The Kindle client files live under `kindle/`. Installation additionally needs the verified FBInk K5 binary, the upstream kindle-dash xh executable and license notices, plus a private `cloud.conf` with `FRAME_URL`, `FRAME_TOKEN`, `BOOTSTRAP_EPOCH`, `BOOTSTRAP_TIME` and `BOOTSTRAP_BUSYBOX`. These device artifacts are intentionally not committed. Keep credentials out of logs. No persistent boot hook is installed before wireless acceptance.
