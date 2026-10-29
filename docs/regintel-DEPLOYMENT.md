# Regulatory Enforcement Intelligence P0 Deployment

## Safety state

The v3 workflow is exported as **inactive** and defaults to `REGINTEL_DRY_RUN=true`. The production database migration, Edge Function deployment, n8n import, recurring activation, and backfill are intentionally not performed by this change set. The implementation brief requires an impact review, backup, and explicit approval first.

The migration is additive, except for one deliberate activation guard: all CN/HK collectors other than `pbc` and `hkma` are set to `enabled=false` and `production_ready=false` until their adapters are verified.

## Files

- Migration: `supabase/migrations/202610270001_regintel_pipeline_observability.sql`
- Edge Function: `supabase/functions/regintel-api/index.ts`
- Workflow: `n8n/Innobridge_RegIntel_CN_HK_v3_P0_Observable.json`
- Source registry: `config/regintel-sources.json`
- Tests: `tests/regintel/pipeline.test.cjs`

## Required secrets and credentials

Do not place keys in JSON or Git.

Supabase Edge Function secrets:

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` or `SUPABASE_SERVICE_ROLE_KEY`
- `REGINTEL_INGEST_KEY`

n8n environment:

- `REGINTEL_API_BASE_URL`: base `regintel-api` URL without an `action` query parameter. The imported workflow appends the required action and includes the current project URL as a fallback.
- `REGINTEL_INGEST_KEY`: must match the Edge Function secret.
- `REGINTEL_DRY_RUN=true`: keep true through initial validation.
- `REGINTEL_PAID_CALL_CAP=2`: recommended first-run cap; hard workflow ceiling is 20.

n8n credentials to re-bind after import:

- AnySearch: **Generic Credential Type -> Header Auth**, name `Anysearch`.
- DeepSeek: **Predefined Credential Type -> DeepSeek**, name `DeepSeek account`.

The workflow uses placeholder credential IDs so no credential identifier or secret is committed.

## Staging-first sequence

1. Create a Supabase preview branch or separate staging project. No development branch existed during implementation.
2. Back up all `regintel_*` tables and the deployed `regintel-api` function source/version.
3. Apply `202610270001_regintel_pipeline_observability.sql` in staging.
4. Verify that `regintel_discovery_diagnostics` and `regintel_discovery_candidates` exist, RLS is enabled, and `anon`/`authenticated` have no grants.
5. Deploy the updated `regintel-api` function after the migration. The function is not compatible with a database missing the two new P0 tables when `action=sources`, `diagnostics`, or `preflight` is used.
6. Import `Innobridge_RegIntel_CN_HK_v3_P0_Observable.json` into n8n and re-bind `Anysearch` and `DeepSeek account`.
7. Keep the schedule disabled. Set `REGINTEL_DRY_RUN=true` and run manually.
8. Confirm two official diagnostics and two search diagnostics. Empty results must be recorded as `empty`, while request failures must be `failed`.
9. Confirm the dry-run summary reports `paid_calls: 0` and no candidate ledger rows were added.
10. Set `REGINTEL_DRY_RUN=false`, `REGINTEL_PAID_CALL_CAP=2`, and run manually with one PBOC and one HKMA fixture or known official notice.
11. Confirm preflight persistence, paid-call counts, unverified ingestion, and that no case is automatically published.
12. Review the Source Health tab on `/compliance` at desktop and 390 px mobile.
13. Only after the staging evidence is accepted should the same migration/function/workflow sequence be approved for production. Activate the 3-hour schedule last.

## Smoke checks

Public, backward-compatible reads:

```text
GET /functions/v1/regintel-api?action=summary
GET /functions/v1/regintel-api?action=sources
GET /functions/v1/regintel-api?action=cases&limit=20
```

Protected writes require `X-Ingest-Key`:

```text
POST /functions/v1/regintel-api?action=diagnostics
POST /functions/v1/regintel-api?action=preflight
POST /functions/v1/regintel-api?action=candidates
```

Verify a missing or incorrect key returns `401`. Do not expose diagnostics or candidate-ledger tables directly to browser clients.

## Operations

- PBOC Beijing and HKMA are the only enabled P0 adapters.
- PDFs are explicitly marked `pdf_requires_extraction` and routed away from DeepSeek until a supported extractor is added.
- HTTP requests retry three times with a 3-second wait. One source failure is saved independently and does not block the other source.
- Discovery parsers pass result envelopes into Merge even when their candidate arrays are empty. `No Candidates Summary` and `No Paid Candidates Summary` distinguish a healthy zero-result run from a stopped or failed branch.
- `Expand Deduplicated Candidates` and `Expand Preflight Accepted` must remain in `Run Once for All Items` mode because they emit multiple n8n items. Their summary siblings also run once for all items and read the bundle with `$input.first().json`.
- Workflow URL normalization is implemented without the n8n-incompatible global `URL` constructor; tracking parameters are removed and final hosts still pass the source allowlist.
- Identical content is rejected by preflight before AnySearch corroboration or DeepSeek. A changed content hash is scheduled again.
- AI output is always `unverified`/`needs_review`; existing human review and publication gates remain in force.
- Watch `consecutive_failures`, latest diagnostic status, rejected reasons, unverified queue size, and candidate `processing_status`.

## Rollback

1. Disable the n8n schedule immediately.
2. Restore the prior `regintel-api` function version.
3. Restore the prior frontend revision if needed. The frontend remains tolerant of missing diagnostic fields.
4. Leave the two additive tables in place during incident review; dropping them is not required for rollback and should require a separate approved migration.
5. Restore collector enablement flags from the backup if the activation-guard update was not intended.

No bulk backfill is part of P0. Any future backfill must be date-bounded, rate-limited, and separately approved.
