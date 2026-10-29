-- Regulatory Enforcement Intelligence P0 observability and idempotency.
-- Additive only: existing source, announcement, case, review, and public API data remain unchanged.

create table if not exists public.regintel_discovery_diagnostics (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  request_id text not null,
  source_id uuid references public.regintel_sources(id) on delete set null,
  source_code text not null,
  jurisdiction text not null check (jurisdiction in ('CN', 'HK')),
  discovery_method text not null check (discovery_method in ('official', 'anysearch')),
  fetch_status text not null check (fetch_status in ('succeeded', 'empty', 'failed', 'partial')),
  http_status integer,
  raw_result_count integer not null default 0 check (raw_result_count >= 0),
  parsed_count integer not null default 0 check (parsed_count >= 0),
  accepted_count integer not null default 0 check (accepted_count >= 0),
  rejected_count integer not null default 0 check (rejected_count >= 0),
  rejection_reason_counts jsonb not null default '{}'::jsonb,
  last_successful_fetch timestamptz,
  last_valid_discovery timestamptz,
  error_message text,
  workflow_execution_id text,
  started_at timestamptz,
  finished_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, request_id, discovery_method)
);

create index if not exists regintel_discovery_diagnostics_source_created_idx
  on public.regintel_discovery_diagnostics(source_code, created_at desc);
create index if not exists regintel_discovery_diagnostics_run_idx
  on public.regintel_discovery_diagnostics(run_id, created_at);

create table if not exists public.regintel_discovery_candidates (
  candidate_id text primary key,
  source_id uuid not null references public.regintel_sources(id) on delete restrict,
  source_code text not null,
  jurisdiction text not null check (jurisdiction in ('CN', 'HK')),
  regulator text not null,
  official_url text not null unique,
  source_listing_url text,
  discovery_method text not null check (discovery_method in ('official', 'anysearch')),
  title text,
  publication_date date,
  verification_status text not null default 'unverified'
    check (verification_status in ('unverified', 'needs_review', 'verified', 'rejected')),
  processing_status text not null default 'discovered'
    check (processing_status in ('discovered', 'queued', 'processing', 'processed', 'failed', 'retryable', 'verified', 'published', 'rejected')),
  content_hash text,
  last_processed_hash text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  processed_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_retry_at timestamptz,
  search_call_count integer not null default 0 check (search_call_count >= 0),
  model_call_count integer not null default 0 check (model_call_count >= 0),
  prompt_tokens integer not null default 0 check (prompt_tokens >= 0),
  completion_tokens integer not null default 0 check (completion_tokens >= 0),
  total_tokens integer not null default 0 check (total_tokens >= 0),
  error_detail text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists regintel_discovery_candidates_queue_idx
  on public.regintel_discovery_candidates(processing_status, next_retry_at, last_seen_at desc);
create index if not exists regintel_discovery_candidates_source_idx
  on public.regintel_discovery_candidates(source_code, last_seen_at desc);
create index if not exists regintel_discovery_candidates_hash_idx
  on public.regintel_discovery_candidates(content_hash)
  where content_hash is not null;

create or replace view public.regintel_latest_source_diagnostics
with (security_invoker = true)
as
select distinct on (source_code)
  source_code,
  fetch_status,
  raw_result_count,
  parsed_count,
  accepted_count,
  rejected_count,
  rejection_reason_counts,
  last_successful_fetch,
  last_valid_discovery,
  created_at
from public.regintel_discovery_diagnostics
order by source_code, created_at desc;

create or replace view public.regintel_source_candidate_counts
with (security_invoker = true)
as
select
  source_code,
  count(*) filter (where processing_status in ('discovered', 'queued', 'processing', 'retryable'))::integer as queued,
  count(*) filter (where verification_status in ('unverified', 'needs_review'))::integer as unverified,
  count(*) filter (where processing_status = 'failed')::integer as errors
from public.regintel_discovery_candidates
group by source_code;

drop trigger if exists regintel_discovery_candidates_updated_at on public.regintel_discovery_candidates;
create trigger regintel_discovery_candidates_updated_at
before update on public.regintel_discovery_candidates
for each row execute function public.regintel_set_updated_at();

alter table public.regintel_discovery_diagnostics enable row level security;
alter table public.regintel_discovery_candidates enable row level security;
revoke all on table public.regintel_discovery_diagnostics from anon, authenticated;
revoke all on table public.regintel_discovery_candidates from anon, authenticated;
grant all on table public.regintel_discovery_diagnostics to service_role;
grant all on table public.regintel_discovery_candidates to service_role;
revoke all on table public.regintel_latest_source_diagnostics from anon, authenticated;
revoke all on table public.regintel_source_candidate_counts from anon, authenticated;
grant select on table public.regintel_latest_source_diagnostics to service_role;
grant select on table public.regintel_source_candidate_counts to service_role;

comment on table public.regintel_discovery_diagnostics is
  'Per-source discovery telemetry. Empty and failed runs are operational records, never candidate records.';
comment on table public.regintel_discovery_candidates is
  'Private idempotency and processing-state ledger used before paid search or model calls.';

-- P0 activation allowlist. The remaining configured adapters stay visible but disabled
-- until their listing, pagination, document fetch, and fixture tests are verified.
update public.regintel_sources
set enabled = case when source_code in ('pbc', 'hkma') then true else false end,
    production_ready = case when source_code in ('pbc', 'hkma') then true else false end,
    updated_at = now()
where jurisdiction in ('CN', 'HK');
