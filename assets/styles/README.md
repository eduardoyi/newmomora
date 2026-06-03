# Illustration style reference assets

Source PNGs for AI style references. Upload to your R2 bucket (`R2_BUCKET`, e.g. `momora-prod`).

| Token | Local file | R2 object key |
|-------|------------|---------------|
| `default` | `default.png` | `_assets/styles/default.png` |

## Upload

From the repo root (requires `supabase/.env.local` with R2 credentials):

```bash
deno run --allow-env --allow-read --allow-net --env-file=supabase/.env.local \
  supabase/scripts/upload-style-asset.ts
```

Edge Functions load style references from R2 directly via the S3 API. An optional public CDN URL (`R2_PUBLIC_ASSETS_BASE_URL`) can be configured later as a fallback.

When adding a new style:

1. Add `assets/styles/{token}.png`
2. Upload with the script (extend for other tokens as needed)
3. Register the token in `supabase/functions/_shared/styles.ts`
