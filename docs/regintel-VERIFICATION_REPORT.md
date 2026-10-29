# Regulatory Enforcement Intelligence P0 Verification Report

Date: 2026-10-27

## What changed

### Database and API

- Added a private diagnostics table for per-source raw, parsed, accepted, rejected, HTTP, timing, and rejection-reason telemetry.
- Added a private candidate ledger for stable IDs, content versions, processing states, retries, paid-call counts, and model token usage.
- Added protected Edge Function actions `diagnostics` and `preflight` behind the existing `X-Ingest-Key` contract.
- Added database-backed cross-run dedup/change detection before paid calls.
- Preserved existing public `cases`, `case`, `summary`, and `sources` routes, existing review actions, and existing case normalization.
- Extended `sources` with safe latest-diagnostic and queue-count summaries; no raw evidence or secret data is exposed.

### n8n

- Created an importable 34-node v3 P0 workflow.
- Only PBOC Beijing and HKMA are enabled. Other configured CN/HK sources remain disabled and visible in the source registry.
- Added source-specific PBOC HTML and HKMA API adapters.
- Correctly reads AnySearch `data.results` and records explicit rejection reasons.
- Removed positional response pairing, reliance on the unavailable n8n `URL` global, and diagnostic sentinel candidates.
- Discovery result envelopes now reach Merge even when their candidate arrays are empty; explicit IF/summary nodes handle zero discovery and zero preflight candidates without silently stopping execution.
- Fetches official evidence before preflight, skips unsupported PDFs with an explicit diagnostic, and sends only accepted changed/new candidates to paid analysis.
- Added retries, bounded paid calls, dry-run mode, strict AI validation, execution summaries with search/model/token usage, and unverified-only ingestion.

### Frontend

- Preserved the existing Enforcement Intelligence layout and case/detail behavior.
- Expanded Source Health to show configured/enabled state, adapter type, latest accepted/rejected counts, queue/unverified/error counts, published count, freshness dates, and rejection reasons.
- Frontend remains backward compatible when the production API does not yet return P0 diagnostic fields.

## How verified and observed results

### Confirmed production observations before changes

- The Supabase project was healthy and had no development branch.
- Eight CN/HK sources were configured.
- Five published enforcement cases existed, all in Hong Kong.
- Five announcements existed; no collection-run or document rows existed.
- Existing RegIntel tables had RLS enabled, no browser-facing policies, and service-role-only grants.
- The deployed function had working public/read and protected ingest/review routes but no diagnostics or preflight route.
- PBOC Beijing returned static UTF-8 HTML with resolvable penalty links and adjacent dates.
- HKMA returned `result.records` with `title`, `link`, and `date`; generic press items required relevance filtering.

These are read-only observations, not claims that the new pipeline is deployed.

### Automated fixture results

Command:

```text
node --test tests/regintel/pipeline.test.cjs
```

Observed result: **14 tests passed, 0 failed**.

Verified cases:

- PBOC Beijing fixture produced one official enforcement candidate and its publication date.
- HKMA fixture produced one relevant official record and rejected two non-case records.
- AnySearch nested response accepted the official action and rejected homepage/third-party results with reasons.
- 80-hit mixed fixture produced 20 accepted and 60 rejected: 20 duplicate, 10 homepage, 10 third-party domain, 10 invalid URL, and 10 irrelevant title.
- Official-only, search-only, and both-empty branch inputs produced the expected merged candidate counts.
- Generated n8n parser code accepted an official AnySearch URL without relying on the unavailable `URL` global.
- Empty discovery and empty preflight inputs produced explicit summary items instead of terminating the workflow silently.
- Multi-record expansion nodes ran in `Run Once for All Items` mode and returned valid n8n `{ json: object }` items; all-items summary nodes read their bundle through `$input.first().json`.
- A failed middle response was matched by `request_id` and did not shift the next response onto the wrong request.
- Unchanged content was skipped; changed content and due retry states were scheduled.
- Malformed AI JSON, unrelated content, and unsafe composite-penalty allocation produced review/rejection states.
- Candidate IDs were stable after safe tracking-parameter removal.
- Workflow JSON parsed successfully, stayed inactive, contained 34 nodes, used retries on paid nodes, aggregated paid-call/token metrics, and contained no positional `.all()[index]` pairing, `new URL()` sandbox dependency, or `_process:false` candidate sentinel.
- Migration checks confirmed additive tables, RLS, revoked browser roles, and no `DROP TABLE`.
- Edge Function checks confirmed old routes remained and new write routes required the ingest-key guard.

### Syntax and UI checks

- All inline scripts in `compliance.html` parsed successfully.
- All 18 n8n Code nodes compiled successfully from the generated workflow JSON.
- All 18 Code nodes passed an execution-mode audit: no all-items node referenced `$json`, and no per-item node returned an array of n8n items.
- A Node type-stripping syntax harness executed the complete Edge Function after replacing only the two runtime imports and `Deno.serve` with inert test stubs; exit code was 0. This validates TypeScript syntax, not Supabase runtime behavior.
- Playwright loaded the local page against the current live read API at 1440 x 1100 and 390 x 844, opened Source Health, and found 8 source cards at both sizes.
- Browser measurements reported `scrollWidth === clientWidth` at both sizes, so no horizontal page overflow was introduced.
- Playwright observed no browser console errors, no page exceptions, and no RegIntel error panel in either viewport.

## Remaining limitations and risks

- The migration and Edge Function have **not** been applied to production. This is intentional pending impact review, backup, and explicit approval.
- The v3 workflow has **not** been imported or run against staging credentials. Credential binding and real HTTP execution remain to be verified in n8n.
- A true staging end-to-end result with one CN and one HK record is still required. Fixture success must not be represented as live enforcement evidence.
- PDF text extraction is not implemented. PDF candidates are safely flagged and excluded from paid AI calls rather than parsed incorrectly.
- Only PBOC Beijing and HKMA are operational P0 adapters. NFRA, CSRC, SAFE, SFC, IA, and HK Customs remain configured but disabled.
- The PBOC adapter covers the Beijing branch only, not nationwide PBOC branches.
- No backfill was run. Existing five published HK cases remain unchanged.
- Supabase CLI/Deno were unavailable in the local shell, so migration application and Edge runtime type-check/deployment could not be executed locally.
- The current production API still reports the pre-P0 source flags (including HK Customs as enabled). Applying the reviewed migration will enforce the P0-only `pbc`/`hkma` activation allowlist.
- Production health should not be inferred from configured-source count. It must come from the new diagnostics after deployment.
