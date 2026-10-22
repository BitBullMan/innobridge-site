# Innobridge Regulatory Enforcement Intelligence v1

## Implemented scope

- China and Hong Kong official-source registry in Supabase.
- Source-linked candidate ingestion through `regintel-api`.
- AnySearch corroboration followed by schema-constrained DeepSeek analysis in n8n.
- AI analysis is normalized into reviewable cases, subjects, violations, penalties, and control findings.
- Human-review boundary: n8n cannot create `verified` or `published` records.
- Public Compliance workspace reads only cases with `review_status = published`.
- Admin `Enforcement Review` provides the two-step verify and publish workflow.

No business-development, lead-generation, opportunity-scoring, or sales fields are included.

## Files

- `supabase/migrations/202610230001_regulatory_enforcement_intelligence_v1.sql`
- `supabase/migrations/202610230002_seed_verified_hkma_enforcement_cases.sql`
- `supabase/functions/regintel-api/index.ts`
- `n8n/Innobridge_RegIntel_CN_HK_v1_AnySearch_AI.json`
- `compliance.html`
- `admin.html`

## Required secrets

Set a strong random value as `REGINTEL_INGEST_KEY` in both:

1. Supabase Edge Function secrets.
2. The n8n server environment or an n8n credential.

Set these in n8n only:

- `ANYSEARCH_API_KEY`
- `DEEPSEEK_API_KEY`
- `REGINTEL_INGEST_URL=https://hbfdelixtwkegxpmfyea.supabase.co/functions/v1/regintel-api?action=candidates`

Do not put any of these secrets in workflow JSON or frontend files.

## First n8n run

1. Import `Innobridge_RegIntel_CN_HK_v1_AnySearch_AI.json`.
2. Leave it inactive.
3. Configure the four values above.
4. Run each branch manually and inspect the official listing, official candidate, AnySearch, AI, validation, and ingestion outputs.
5. Confirm formal enforcement candidates create normalized `needs_review` cases while uncertain or irrelevant items remain unpublished.
6. Configure the n8n error workflow, execution retention, retry, and alert settings.
7. Activate the three-hour schedule only after the manual run is clean.

## Source status

Validated for initial automated collection:

- PBOC Beijing branch administrative penalties.
- HKMA official press-release API.
- Hong Kong Customs money-service-operator enforcement news.

Registered but intentionally disabled pending a dedicated adapter:

- NFRA: dynamically populated listing and pagination.
- CSRC: current listing response does not reliably expose decision links.
- SAFE: search endpoint and branch routing.
- SFC: client-rendered enforcement listing.
- Hong Kong Insurance Authority: live request returned HTTP 403; do not bypass access controls.

The source-health view keeps these gaps visible. The current MVP does not claim nationwide PBOC coverage or comprehensive CN/HK enforcement coverage.

## Review and publication

Candidate ingestion can create normalized `needs_review` cases but never publishes them automatically. In Admin → Enforcement Review, a reviewer must:

1. Confirm the official document and decision reference.
2. Preserve verbatim violation evidence.
3. Separate institutions and named individuals.
4. Preserve exact original currency and amount.
5. Leave missing amounts as `null`.
6. Mark composite amounts as unallocated unless the source explicitly apportions them.
7. Distinguish regulator-confirmed controls from analyst inference.
8. Approve the normalized case. An `admin` or `super_admin` then publishes it.

Only published cases appear in the Compliance page.

## Verified seed cases

The second migration adds five idempotent, published HKMA decisions that were
manually checked against the regulator's official documents. Each decision keeps
its own source URL, respondent, original HKD amount, legal citation, violation
classification, and confirmed control findings. The migration does not combine
penalties and does not substitute zero for an unstated amount.

## API smoke tests

Public endpoints:

```text
GET /functions/v1/regintel-api?action=summary
GET /functions/v1/regintel-api?action=cases&limit=20
GET /functions/v1/regintel-api?action=sources
GET /functions/v1/regintel-api?action=case&id=<uuid>
```

Ingestion:

```text
POST /functions/v1/regintel-api?action=candidates
X-Ingest-Key: <REGINTEL_INGEST_KEY>
Content-Type: application/json
```

Review:

```text
GET /functions/v1/regintel-api?action=review_queue&limit=100
Authorization: Bearer <Supabase admin access token>

POST /functions/v1/regintel-api?action=review
Authorization: Bearer <Supabase admin access token>
Content-Type: application/json
```

The review queue and decision endpoint accept only active, unexpired `editor`, `admin`, or `super_admin` users. Editors can verify; publishing and unpublishing require `admin` or `super_admin`.
