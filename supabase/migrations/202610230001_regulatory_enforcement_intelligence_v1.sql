-- Innobridge Regulatory Enforcement Intelligence v1
-- Additive migration. Existing compliance, sanctions, briefing, and AML objects are untouched.

create extension if not exists pgcrypto;

create or replace function public.regintel_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.regintel_sources (
  id uuid primary key default gen_random_uuid(),
  source_code text not null unique,
  regulator text not null,
  regulator_name_local text,
  jurisdiction text not null check (jurisdiction in ('CN', 'HK')),
  source_type text not null default 'official_regulator',
  language text[] not null default array['zh-CN']::text[],
  listing_url text not null,
  allowed_domains text[] not null,
  access_method text not null default 'html',
  adapter_type text not null default 'listing_html',
  adapter_config jsonb not null default '{}'::jsonb,
  enabled boolean not null default false,
  production_ready boolean not null default false,
  parser_version text not null default 'regintel-v1',
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_item_at timestamptz,
  error_status text,
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  coverage_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.regintel_collection_runs (
  id uuid primary key default gen_random_uuid(),
  source_id uuid references public.regintel_sources(id) on delete set null,
  workflow_execution_id text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running','succeeded','partial','failed')),
  found_count integer not null default 0,
  new_count integer not null default 0,
  duplicate_count integer not null default 0,
  failed_count integer not null default 0,
  http_status integer,
  parser_version text,
  error_log jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.regintel_announcements (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.regintel_sources(id) on delete restrict,
  collection_run_id uuid references public.regintel_collection_runs(id) on delete set null,
  canonical_url text not null unique,
  source_page text,
  title text,
  title_en text,
  publication_date date,
  discovered_at timestamptz not null default now(),
  fetched_at timestamptz,
  raw_html text,
  raw_text text,
  content_hash text,
  language text,
  original_file_url text,
  document_type text not null default 'candidate',
  relevance_class text not null default 'unknown' check (relevance_class in ('unknown','enforcement','guidance','policy','consultation','unrelated')),
  extraction_status text not null default 'queued' check (extraction_status in ('queued','fetched','extracted','failed','ignored')),
  verification_status text not null default 'unverified' check (verification_status in ('unverified','needs_review','verified','rejected')),
  pipeline_version text not null default '1.0',
  source_trace jsonb not null default '{}'::jsonb,
  anysearch_evidence jsonb not null default '[]'::jsonb,
  ai_analysis jsonb not null default '{}'::jsonb,
  error_detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists regintel_announcements_source_hash_uidx
  on public.regintel_announcements(source_id, content_hash)
  where content_hash is not null;
create index if not exists regintel_announcements_queue_idx
  on public.regintel_announcements(extraction_status, verification_status, discovered_at desc);
create index if not exists regintel_announcements_source_date_idx
  on public.regintel_announcements(source_id, publication_date desc nulls last);

create table if not exists public.regintel_documents (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.regintel_announcements(id) on delete cascade,
  attachment_url text not null,
  mime_type text,
  file_hash text not null,
  immutable_storage_path text,
  extracted_text text,
  extraction_method text,
  extraction_version text,
  page_count integer check (page_count is null or page_count >= 0),
  ocr_used boolean not null default false,
  quality_status text not null default 'pending' check (quality_status in ('pending','usable','low_quality','failed')),
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (announcement_id, file_hash)
);

create table if not exists public.regintel_entities (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null,
  original_name text not null,
  aliases text[] not null default '{}'::text[],
  country text,
  sector text,
  entity_type text not null default 'organization' check (entity_type in ('organization','person')),
  regulator_license_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists regintel_entities_name_idx on public.regintel_entities(lower(canonical_name));

create table if not exists public.regintel_cases (
  id uuid primary key default gen_random_uuid(),
  announcement_id uuid not null references public.regintel_announcements(id) on delete restrict,
  case_sequence integer not null default 1 check (case_sequence > 0),
  regulator text not null,
  jurisdiction text not null check (jurisdiction in ('CN','HK')),
  decision_number text,
  decision_date date,
  publication_date date,
  case_type text not null default 'other' check (case_type in ('fine','warning','improvement_order','suspension','revocation','prohibition','prosecution','other')),
  case_summary text,
  case_summary_en text,
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  review_status text not null default 'needs_review' check (review_status in ('needs_review','in_review','verified','rejected','published')),
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (announcement_id, case_sequence)
);
create index if not exists regintel_cases_public_idx on public.regintel_cases(review_status, decision_date desc nulls last);
create index if not exists regintel_cases_filter_idx on public.regintel_cases(jurisdiction, regulator, case_type);

create table if not exists public.regintel_case_subjects (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.regintel_cases(id) on delete cascade,
  entity_id uuid not null references public.regintel_entities(id) on delete restrict,
  subject_role text not null default 'respondent',
  subject_type text not null check (subject_type in ('institution','person')),
  related_institution_id uuid references public.regintel_entities(id) on delete set null,
  evidence_span text,
  created_at timestamptz not null default now(),
  unique (case_id, entity_id, subject_role)
);

create table if not exists public.regintel_violations (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.regintel_cases(id) on delete cascade,
  verbatim_wording text,
  normalized_category text not null check (normalized_category in ('AML_CFT','KYC_CDD','EDD','BENEFICIAL_OWNERSHIP','SANCTIONS_SCREENING','TRANSACTION_MONITORING','STR_SAR','RECORDKEEPING','GOVERNANCE','MARKET_CONDUCT','FX','PAYMENTS','OTHER')),
  legal_citation text,
  source_span text,
  source_page integer,
  classification_basis text not null default 'confirmed_by_regulator' check (classification_basis in ('confirmed_by_regulator','analyst_inference')),
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  created_at timestamptz not null default now()
);
create index if not exists regintel_violations_category_idx on public.regintel_violations(normalized_category, classification_basis);

create table if not exists public.regintel_penalties (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.regintel_cases(id) on delete cascade,
  subject_id uuid references public.regintel_case_subjects(id) on delete set null,
  penalty_type text not null,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  amount numeric(30,6) check (amount is null or amount >= 0),
  original_amount_text text,
  joint_and_several boolean not null default false,
  applies_to text not null default 'institution' check (applies_to in ('institution','person','mixed','unknown')),
  combined_amount boolean not null default false,
  amount_allocation_status text not null default 'not_applicable' check (amount_allocation_status in ('not_applicable','explicit','unallocated_composite','needs_review')),
  effective_date date,
  evidence_span text,
  created_at timestamptz not null default now()
);
create index if not exists regintel_penalties_currency_idx on public.regintel_penalties(currency, amount);

create table if not exists public.regintel_control_findings (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.regintel_cases(id) on delete cascade,
  violation_id uuid references public.regintel_violations(id) on delete cascade,
  control_domain text not null,
  observed_failure text not null,
  possible_root_cause text,
  classification text not null check (classification in ('confirmed_by_regulator','analyst_inference')),
  evidence_span text,
  confidence numeric(5,4) not null default 0 check (confidence between 0 and 1),
  reviewer_notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.regintel_reviews (
  id uuid primary key default gen_random_uuid(),
  object_type text not null check (object_type in ('announcement','case','entity','violation','penalty','control_finding')),
  object_id uuid not null,
  reviewer_id uuid references auth.users(id) on delete set null,
  decision text not null check (decision in ('approve','reject','request_changes','publish','unpublish')),
  changes jsonb not null default '{}'::jsonb,
  rationale text,
  created_at timestamptz not null default now()
);
create index if not exists regintel_reviews_object_idx on public.regintel_reviews(object_type, object_id, created_at desc);

create table if not exists public.regintel_alerts (
  id uuid primary key default gen_random_uuid(),
  alert_rule text not null,
  case_id uuid references public.regintel_cases(id) on delete cascade,
  sent_at timestamptz,
  channel text,
  dedupe_key text not null unique,
  status text not null default 'queued' check (status in ('queued','sent','failed','suppressed')),
  error_detail text,
  created_at timestamptz not null default now()
);

create index if not exists regintel_collection_runs_source_idx on public.regintel_collection_runs(source_id);
create index if not exists regintel_announcements_collection_run_idx on public.regintel_announcements(collection_run_id);
create index if not exists regintel_case_subjects_entity_idx on public.regintel_case_subjects(entity_id);
create index if not exists regintel_case_subjects_related_institution_idx on public.regintel_case_subjects(related_institution_id);
create index if not exists regintel_violations_case_idx on public.regintel_violations(case_id);
create index if not exists regintel_penalties_case_idx on public.regintel_penalties(case_id);
create index if not exists regintel_penalties_subject_idx on public.regintel_penalties(subject_id);
create index if not exists regintel_control_findings_case_idx on public.regintel_control_findings(case_id);
create index if not exists regintel_control_findings_violation_idx on public.regintel_control_findings(violation_id);
create index if not exists regintel_reviews_reviewer_idx on public.regintel_reviews(reviewer_id);
create index if not exists regintel_alerts_case_idx on public.regintel_alerts(case_id);

do $$
declare
  t text;
begin
  foreach t in array array[
    'regintel_sources','regintel_collection_runs','regintel_announcements','regintel_documents',
    'regintel_entities','regintel_cases','regintel_case_subjects','regintel_violations',
    'regintel_penalties','regintel_control_findings','regintel_reviews','regintel_alerts'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end $$;

drop trigger if exists regintel_sources_updated_at on public.regintel_sources;
create trigger regintel_sources_updated_at before update on public.regintel_sources
for each row execute function public.regintel_set_updated_at();
drop trigger if exists regintel_announcements_updated_at on public.regintel_announcements;
create trigger regintel_announcements_updated_at before update on public.regintel_announcements
for each row execute function public.regintel_set_updated_at();
drop trigger if exists regintel_entities_updated_at on public.regintel_entities;
create trigger regintel_entities_updated_at before update on public.regintel_entities
for each row execute function public.regintel_set_updated_at();
drop trigger if exists regintel_cases_updated_at on public.regintel_cases;
create trigger regintel_cases_updated_at before update on public.regintel_cases
for each row execute function public.regintel_set_updated_at();

revoke execute on function public.regintel_set_updated_at() from public, anon, authenticated;

insert into public.regintel_sources (
  source_code, regulator, regulator_name_local, jurisdiction, language, listing_url,
  allowed_domains, access_method, adapter_type, adapter_config, enabled, production_ready, coverage_notes
) values
('pbc','PBOC','中国人民银行北京市分行','CN',array['zh-CN'],
 'https://beijing.pbc.gov.cn/beijing/132030/132052/132059/index.html',array['beijing.pbc.gov.cn','pbc.gov.cn'],
 'html','pbc_branch_listing',jsonb_build_object('linkPattern','/beijing/132030/132052/132059/','pilotCoverage','Beijing branch'),true,true,
 'MVP adapter covers the Beijing branch official administrative-penalty listing. Nationwide PBOC branch coverage remains a measured expansion item.'),
('nfra','NFRA','国家金融监督管理总局','CN',array['zh-CN'],
 'https://www.nfra.gov.cn/cn/view/pages/ItemList.html?itemPId=914&itemId=4113&itemUrl=ItemListRightList.html&itemName=%E8%A1%8C%E6%94%BF%E5%A4%84%E7%BD%9A',array['nfra.gov.cn','www.nfra.gov.cn'],
 'html','nfra_penalty_list',jsonb_build_object('detailPattern','/cn/view/pages/ItemDetail.html','itemId','4113'),false,false,
 'Official NFRA administrative-penalty channel registered. The listing is dynamically populated and requires a dedicated API/pagination adapter before enablement.'),
('csrc','CSRC','中国证券监督管理委员会','CN',array['zh-CN'],
 'https://www.csrc.gov.cn/csrc/c101971/zfxxgk_zdgk.shtml?channelid=17d5ff2fe43e488dba825807ae40d63f',array['csrc.gov.cn','www.csrc.gov.cn'],
 'html','csrc_decision_list',jsonb_build_object('detailPattern','/content.shtml','documentLabel','行政处罚决定书'),false,false,
 'Official CSRC administrative-enforcement channel registered. The current listing response does not expose decision links reliably and remains disabled pending a dedicated adapter.'),
('safe','SAFE','国家外汇管理局','CN',array['zh-CN'],
 'https://www.safe.gov.cn/www/punish',array['safe.gov.cn','www.safe.gov.cn'],
 'html','safe_penalty_search',jsonb_build_object('detailPattern','/www/illegal/listQuery','branchParameter','siteid'),false,false,
 'Official SAFE penalty search registered. It uses a search endpoint and branch routing, so a dedicated query adapter is required before enablement.'),
('hkma','HKMA','香港金融管理局','HK',array['en','zh-HK'],
 'https://api.hkma.gov.hk/public/press-releases?lang=en',array['api.hkma.gov.hk','hkma.gov.hk','www.hkma.gov.hk'],
 'json','hkma_press_release_api',jsonb_build_object('dataPath','result.records','titlePattern','disciplin|penalt|contravention|enforcement'),true,true,
 'Official HKMA Press Releases API. Adapter applies enforcement-specific title screening and retains linked statements of disciplinary action.'),
('sfc','SFC','香港證券及期貨事務監察委員會','HK',array['en','zh-HK'],
 'https://apps.sfc.hk/edistributionWeb/gateway/EN/news-and-announcements/news/enforcement-news/?searchByName=1',array['apps.sfc.hk','sfc.hk','www.sfc.hk'],
 'html','sfc_enforcement_news',jsonb_build_object('apiPattern','/edistributionWeb/api/news/list-content','listingType','enforcement-news'),false,false,
 'Official SFC Enforcement News listing registered. The public page is client-rendered and requires its dedicated listing API before enablement.'),
('ia','IA','香港保險業監管局','HK',array['en','zh-HK'],
 'https://www.ia.org.hk/en/enforcement/enforcement_news/news.html',array['ia.org.hk','www.ia.org.hk'],
 'html','ia_enforcement_news',jsonb_build_object('detailPattern','/en/infocenter/press_releases/'),false,false,
 'Official Insurance Authority Enforcement News listing registered. Live validation returned HTTP 403; do not bypass access controls.'),
('hkcustoms','C&ED','香港海關','HK',array['en','zh-HK'],
 'https://eservices.customs.gov.hk/MSOS/common/enforcenew',array['eservices.customs.gov.hk','customs.gov.hk','www.customs.gov.hk'],
 'html','customs_mso_enforcement',jsonb_build_object('detailPattern','/MSOS/downloadFile','secondaryPattern','/customs-announcement/press-release/'),true,true,
 'Official Money Service Operators enforcement-news listing; Customs press releases are retained as a secondary official route.')
on conflict (source_code) do update set
  regulator = excluded.regulator,
  regulator_name_local = excluded.regulator_name_local,
  jurisdiction = excluded.jurisdiction,
  language = excluded.language,
  listing_url = excluded.listing_url,
  allowed_domains = excluded.allowed_domains,
  access_method = excluded.access_method,
  adapter_type = excluded.adapter_type,
  adapter_config = excluded.adapter_config,
  enabled = excluded.enabled,
  production_ready = excluded.production_ready,
  coverage_notes = excluded.coverage_notes,
  updated_at = now();

comment on table public.regintel_announcements is 'Unverified candidate and source-document queue. AnySearch and AI analysis never imply regulatory verification.';
comment on table public.regintel_cases is 'Normalized enforcement decisions. Only review_status=published may be exposed by the public API.';
comment on column public.regintel_penalties.amount is 'Exact original-currency amount. Null means not stated; never substitute zero.';
comment on column public.regintel_penalties.combined_amount is 'True when the source presents a composite amount that must not be allocated to AML without explicit apportionment.';

