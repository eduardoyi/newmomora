# Widget database validation

Status: isolated schema validation complete; production validation and release
checks remain separate.

## Isolated database

The existing `supabase_db_frontend` stack was left running and was not reset.
Validation used a copy of the older `supabase_db_Momora2Integration` volume:

```sh
clone_volume='momora_widget_validation_db'
docker volume rm "$clone_volume" >/dev/null 2>&1 || true
docker volume create "$clone_volume"
docker run --rm --entrypoint sh \
  -v supabase_db_Momora2Integration:/from:ro \
  -v "$clone_volume":/to \
  public.ecr.aws/supabase/postgres:17.6.1.121 \
  -c 'cp -a /from/. /to/'
docker run -d --name momora_widget_db_validation \
  -v "$clone_volume":/var/lib/postgresql/data \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=supabase_admin \
  -e POSTGRES_DB=postgres \
  -p 55432:5432 \
  public.ecr.aws/supabase/postgres:17.6.1.121
```

After the database became ready, the migrations after the copied volume's
`20260731110000` revision were applied directly inside this container. This
avoids changing any configured local or production project:

```sh
docker exec momora_widget_db_validation sh -c \
  'rm -rf /tmp/migrations && mkdir -p /tmp/migrations'
docker cp supabase/migrations/. momora_widget_db_validation:/tmp/migrations/
docker exec -e PGPASSWORD=postgres momora_widget_db_validation sh -c \
  'set -e; for path in $(find /tmp/migrations -maxdepth 1 -type f \( \
     -name "202608*.sql" -o -name "2026090*.sql" \) | sort); do
     psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f "$path" >/tmp/widget_migration.log;
   done'
docker cp supabase/migrations/20260915140000_widget_memory_candidates.sql \
  momora_widget_db_validation:/tmp/widget.sql
docker exec -e PGPASSWORD=postgres momora_widget_db_validation \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/widget.sql
docker cp supabase/migrations/20260916100000_widget_memory_candidate_scope.sql \
  momora_widget_db_validation:/tmp/widget_scope.sql
docker exec -e PGPASSWORD=postgres momora_widget_db_validation \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -f /tmp/widget_scope.sql
```

The original migration applied both RPCs, and the follow-up migration replaced
only `get_widget_memory_candidates`, followed by its authenticated-only grant.
The candidate RPC remains `SECURITY INVOKER`; the narrow timezone helper remains
`SECURITY DEFINER`.

## SQL assertions

The database test was run without `npm run db:reset`, because that command
would target the user's existing local project. The copied validation database
was given pgTAP, the test file was copied in, and it was run in one transaction:

```sh
docker exec -e PGPASSWORD=postgres momora_widget_db_validation \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -c 'create extension if not exists pgtap;'
docker cp supabase/tests/widget_memory_candidates.sql \
  momora_widget_db_validation:/tmp/widget_memory_candidates.sql
docker exec -e PGPASSWORD=postgres momora_widget_db_validation \
  psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -f /tmp/widget_memory_candidates.sql
```

Observed result: `1..47`, every assertion `ok 1` through `ok 47`, `finish`
returned zero rows, and the test transaction rolled back. The two content-report
fixture calls emitted the existing test-environment warning
`content-report email alert enqueue failed`; no pgTAP assertion failed.

The fixture proves:

- authenticated-only function grants, anonymous privilege denial, exact-family
  membership, removed-membership denial, and an authenticated anonymous account;
- no ordinary owner-profile read for a viewer, while the helper returns the
  owner timezone through its validated definer path;
- owner/manager/viewer candidate parity before local safety state and
  Family-A-to-Family-B denial;
- current owner-local date metadata and next local midnight boundary;
- under-90-day, exact 90-day, exact 18-month, exact 36-month, deep, future, and
  legacy illustrated rows whose generation id is null;
- only ready `text_illustration` rows with a key and media rows with at least
  one photo asset are eligible; text-only, audio-only, and video-only rows are
  excluded, while a mixed photo/video carousel remains eligible;
- pending/failed illustrations, retained illustrations on text-only rows, and
  onboarding-pending media are excluded before sampling;
- 40 distinct IDs, ten-per-band quotas with deterministic recent backfill, and
  no null sentinel when candidates exist;
- reporter-local whole-memory reports and account blocks before capping;
  an active report for the current illustration generation persistently removes
  that image-only memory from the candidate pool, while report state remains
  reporter-local;
- an empty family null-id sentinel carrying clock metadata and UTC fallback for
  an invalid owner timezone.

## Type regeneration

The type command was run against a second isolated copy, without installing
pgTAP in the public schema so test helper functions did not enter generated
client types:

```sh
npm exec supabase -- gen types typescript \
  --db-url 'postgresql://supabase_admin:postgres@127.0.0.1:55433/postgres' \
  > /tmp/widget_database_clean.ts
cp /tmp/widget_database_clean.ts src/types/database.ts
```

The generated file changed only by adding the two widget function contracts:
`get_widget_family_timezone(p_family_id)` and
`get_widget_memory_candidates(p_family_id)`. The service calls the typed RPC
directly; it does not use an `any` Supabase escape hatch.

## Scan benchmark

A temporary benchmark variant of the fixture inserted 10,000 additional
`text_only` rows into the cap family, ran `ANALYZE public.memories`, and timed
the function through:

```sql
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, SUMMARY ON, FORMAT TEXT)
SELECT *
FROM public.get_widget_memory_candidates(
  'a2000000-0000-4000-8000-000000000002'
);
```

Three warm calls without the proposed duplicate index measured 188.831 ms,
180.404 ms, and 174.811 ms. Three calls with a temporary
`(family_id, memory_date DESC, id)` index measured 172.801 ms, 162.177 ms,
and 161.697 ms. The repository's existing
`idx_memories_family_id_memory_date` already serves the family/date predicate;
the candidate ordering is hash-based. The extra index therefore was not kept
in the migration because its modest read difference did not justify another
write-maintained family/date index. The benchmark transaction was rolled back.

These timings are local synthetic evidence, not a production SLO. They also
include the existing RLS and safety helper work; no production data or service
credentials were used.

The final tested authoritative-child-assets guard was split into
`20260916110000_widget_authoritative_photo_assets.sql` because the image-only
`20260916100000` migration had already been deployed before that guard was
finalized. Both migrations are now applied to the linked database. Apply both
after the original candidate migration when reproducing these 47 assertions.
