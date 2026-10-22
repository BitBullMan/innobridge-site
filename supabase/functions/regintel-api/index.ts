import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const INGEST_KEY = Deno.env.get("REGINTEL_INGEST_KEY") || "";
const MAX_BODY_BYTES = 128 * 1024;
const PUBLIC_LIMIT_MAX = 100;

function serviceKey(): string {
  const direct = Deno.env.get("SUPABASE_SECRET_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  try {
    const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return keys.default || Object.values(keys)[0] || "";
  } catch {
    return "";
  }
}

const SERVICE_KEY = serviceKey();
const adminDb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ALLOWED_ORIGINS = new Set([
  "https://innobridge.io",
  "https://www.innobridge.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://www.innobridge.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-ingest-key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function cleanText(value: unknown, max = 5000): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\u0000/g, "").trim();
  return text ? text.slice(0, max) : null;
}

function cleanDate(value: unknown): string | null {
  const text = cleanText(value, 32);
  if (!text) return null;
  const match = text.match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function canonicalUrl(value: unknown): URL | null {
  const text = cleanText(value, 2048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "gclid", "fbclid"].forEach((key) => url.searchParams.delete(key));
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function hostAllowed(hostname: string, allowedDomains: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return false;
  return allowedDomains.some((domain) => {
    const safe = domain.toLowerCase().replace(/^www\./, "");
    return host === safe || host === `www.${safe}` || host.endsWith(`.${safe}`);
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getSummary(req: Request): Promise<Response> {
  const { data: cases, error } = await adminDb
    .from("regintel_cases")
    .select("id,jurisdiction,regulator,decision_date,publication_date")
    .eq("review_status", "published");
  if (error) return json(req, { error: "summary_query_failed" }, 500);
  const ids = (cases || []).map((item) => item.id);
  let findings: Array<Record<string, unknown>> = [];
  if (ids.length) {
    const result = await adminDb.from("regintel_control_findings").select("control_domain,classification,case_id").in("case_id", ids);
    if (!result.error) findings = result.data || [];
  }
  const byJurisdiction: Record<string, number> = {};
  const byRegulator: Record<string, number> = {};
  const controlIssues: Record<string, number> = {};
  for (const item of cases || []) {
    byJurisdiction[item.jurisdiction] = (byJurisdiction[item.jurisdiction] || 0) + 1;
    byRegulator[item.regulator] = (byRegulator[item.regulator] || 0) + 1;
  }
  for (const item of findings) {
    const key = String(item.control_domain || "Other");
    controlIssues[key] = (controlIssues[key] || 0) + 1;
  }
  return json(req, {
    total: (cases || []).length,
    by_jurisdiction: byJurisdiction,
    by_regulator: byRegulator,
    key_control_issues: Object.entries(controlIssues).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, count]) => ({ label, count })),
  });
}

const CASE_SELECT = `
  id,regulator,jurisdiction,decision_number,decision_date,publication_date,case_type,
  case_summary,case_summary_en,confidence,severity,published_at,
  announcement:regintel_announcements!inner(title,title_en,canonical_url,publication_date),
  subjects:regintel_case_subjects(id,subject_role,subject_type,evidence_span,entity:regintel_entities!regintel_case_subjects_entity_id_fkey(canonical_name,original_name,country,sector,entity_type)),
  violations:regintel_violations(verbatim_wording,normalized_category,legal_citation,classification_basis,confidence),
  penalties:regintel_penalties(penalty_type,currency,amount,original_amount_text,applies_to,combined_amount,amount_allocation_status),
  control_findings:regintel_control_findings(control_domain,observed_failure,possible_root_cause,classification,confidence)
`;

async function getCases(req: Request, url: URL): Promise<Response> {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), PUBLIC_LIMIT_MAX);
  const offset = Math.max(Number(url.searchParams.get("offset") || 0), 0);
  let query = adminDb.from("regintel_cases").select(CASE_SELECT, { count: "exact" }).eq("review_status", "published");
  const jurisdiction = cleanText(url.searchParams.get("jurisdiction"), 2);
  const regulator = cleanText(url.searchParams.get("regulator"), 40);
  const severity = cleanText(url.searchParams.get("severity"), 12);
  if (jurisdiction && ["CN", "HK"].includes(jurisdiction)) query = query.eq("jurisdiction", jurisdiction);
  if (regulator) query = query.eq("regulator", regulator);
  if (severity && ["low", "medium", "high", "critical"].includes(severity)) query = query.eq("severity", severity);
  const { data, error, count } = await query
    .order("decision_date", { ascending: false, nullsFirst: false })
    .order("publication_date", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);
  if (error) return json(req, { error: "cases_query_failed" }, 500);
  return json(req, { items: data || [], total: count || 0, limit, offset });
}

async function getCaseDetail(req: Request, url: URL): Promise<Response> {
  const id = cleanText(url.searchParams.get("id"), 64);
  if (!id) return json(req, { error: "id_required" }, 400);
  const { data, error } = await adminDb.from("regintel_cases").select(CASE_SELECT).eq("id", id).eq("review_status", "published").maybeSingle();
  if (error) return json(req, { error: "case_query_failed" }, 500);
  if (!data) return json(req, { error: "not_found" }, 404);
  return json(req, { item: data });
}

async function getSources(req: Request): Promise<Response> {
  const { data, error } = await adminDb
    .from("regintel_sources")
    .select("source_code,regulator,regulator_name_local,jurisdiction,listing_url,access_method,enabled,production_ready,last_checked_at,last_success_at,last_item_at,error_status,consecutive_failures,coverage_notes")
    .order("jurisdiction")
    .order("regulator");
  if (error) return json(req, { error: "sources_query_failed" }, 500);
  return json(req, { items: data || [] });
}

async function ingestCandidates(req: Request): Promise<Response> {
  if (!INGEST_KEY) return json(req, { error: "ingestion_not_configured" }, 503);
  if (req.headers.get("x-ingest-key") !== INGEST_KEY) return json(req, { error: "unauthorized" }, 401);
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return json(req, { error: "payload_too_large" }, 413);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, { error: "invalid_json" }, 400); }
  const candidates = Array.isArray(body.items) ? body.items : [body];
  if (!candidates.length || candidates.length > 100) return json(req, { error: "items_must_contain_1_to_100_candidates" }, 400);

  const since = new Date(Date.now() - 60_000).toISOString();
  const recent = await adminDb.from("regintel_announcements").select("id", { count: "exact", head: true }).gte("created_at", since);
  if ((recent.count || 0) >= 120) return json(req, { error: "rate_limit_exceeded" }, 429);

  const sourceCodes = [...new Set(candidates.map((item) => {
    const candidate = item as Record<string, unknown>;
    return cleanText(candidate.source_code || candidate.source_id, 40);
  }).filter(Boolean))];
  let sourceRows: Array<Record<string, any>> = [];
  if (sourceCodes.length) {
    const sourceResult = await adminDb.from("regintel_sources").select("id,source_code,regulator,jurisdiction,allowed_domains,enabled").in("source_code", sourceCodes);
    if (sourceResult.error) return json(req, { error: "source_lookup_failed" }, 500);
    sourceRows = sourceResult.data || [];
  }
  const sourceMap = new Map(sourceRows.map((source) => [source.source_code, source]));
  const rows: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as Record<string, unknown>;
    const sourceCode = cleanText(candidate.source_code || candidate.source_id, 40);
    const source = sourceCode ? sourceMap.get(sourceCode) : null;
    const url = canonicalUrl(candidate.url || candidate.canonical_url);
    if (!source || !source.enabled) { rejected.push({ index, reason: "unknown_or_disabled_source" }); continue; }
    if (!url || !hostAllowed(url.hostname, source.allowed_domains || [])) { rejected.push({ index, reason: "url_not_allowed" }); continue; }
    const title = cleanText(candidate.title, 1000);
    const contentHash = await sha256(`${sourceCode}|${url.href}|${title || ""}`);
    rows.push({
      source_id: source.id,
      canonical_url: url.href,
      source_page: cleanText(candidate.source_page, 2048),
      title,
      title_en: cleanText(candidate.title_en, 1000),
      publication_date: cleanDate(candidate.publication_date),
      raw_text: cleanText(candidate.official_text || candidate.raw_text, 100000),
      language: cleanText(candidate.language, 16),
      content_hash: contentHash,
      document_type: cleanText(candidate.document_type, 64) || "candidate",
      relevance_class: "unknown",
      extraction_status: candidate.official_text || candidate.raw_text ? "extracted" : "queued",
      verification_status: "unverified",
      pipeline_version: cleanText(candidate.pipeline_version, 32) || "regintel-n8n-v1",
      source_trace: {
        source_code: sourceCode,
        regulator: source.regulator,
        jurisdiction: source.jurisdiction,
        official_url: url.href,
        workflow_execution_id: cleanText(candidate.workflow_execution_id, 128),
        discovered_at: cleanText(candidate.discovered_at, 64) || new Date().toISOString(),
      },
      anysearch_evidence: Array.isArray(candidate.anysearch_evidence) ? candidate.anysearch_evidence.slice(0, 10) : [],
      ai_analysis: typeof candidate.ai_analysis === "object" && candidate.ai_analysis !== null ? candidate.ai_analysis : {},
    });
  }

  let inserted: Array<Record<string, unknown>> = [];
  let acceptedRows: Array<Record<string, unknown>> = [];
  if (rows.length) {
    const result = await adminDb.from("regintel_announcements").upsert(rows, { onConflict: "canonical_url", ignoreDuplicates: true }).select("id,canonical_url,verification_status,extraction_status");
    if (result.error) return json(req, { error: "candidate_insert_failed", detail: result.error.message }, 500);
    inserted = result.data || [];
    const acceptedResult = await adminDb.from("regintel_announcements").select("id,canonical_url,verification_status,extraction_status").in("canonical_url", rows.map((row) => row.canonical_url));
    if (!acceptedResult.error) acceptedRows = acceptedResult.data || [];
    const sourceIds = [...new Set(rows.map((row) => row.source_id))];
    await adminDb.from("regintel_sources").update({ last_checked_at: new Date().toISOString(), last_success_at: new Date().toISOString(), consecutive_failures: 0, error_status: null }).in("id", sourceIds);
  }
  const insertedUrls = new Set(inserted.map((row) => row.canonical_url));
  const records = acceptedRows.map((row) => ({ ...row, status: insertedUrls.has(row.canonical_url) ? "queued" : "duplicate" }));
  const single = candidates.length === 1 && records.length === 1 ? { candidate_id: records[0].id, status: records[0].status } : {};
  return json(req, { ...single, accepted: rows.length, inserted: inserted.length, duplicates: rows.length - inserted.length, rejected, records }, 202);
}

async function requireAdmin(req: Request): Promise<{ userId: string; role: string } | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const authResult = await adminDb.auth.getUser(token);
  const user = authResult.data.user;
  if (!user) return null;
  const { data } = await adminDb.from("aml_admin_users").select("id,role,is_active,access_expires_at").eq("id", user.id).maybeSingle();
  if (!data?.is_active || !["editor", "admin", "super_admin"].includes(data.role)) return null;
  if (data.access_expires_at && new Date(data.access_expires_at).getTime() <= Date.now()) return null;
  return { userId: user.id, role: data.role };
}

async function reviewCase(req: Request): Promise<Response> {
  const admin = await requireAdmin(req);
  if (!admin) return json(req, { error: "admin_authorization_required" }, 403);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(req, { error: "invalid_json" }, 400); }
  const caseId = cleanText(body.case_id, 64);
  const decision = cleanText(body.decision, 32);
  if (!caseId || !decision || !["approve", "reject", "request_changes", "publish", "unpublish"].includes(decision)) {
    return json(req, { error: "valid_case_id_and_decision_required" }, 400);
  }
  const statusMap: Record<string, string> = { approve: "verified", reject: "rejected", request_changes: "needs_review", publish: "published", unpublish: "verified" };
  const update: Record<string, unknown> = { review_status: statusMap[decision] };
  if (decision === "publish") update.published_at = new Date().toISOString();
  const result = await adminDb.from("regintel_cases").update(update).eq("id", caseId).select("id,review_status,published_at").maybeSingle();
  if (result.error || !result.data) return json(req, { error: "case_update_failed" }, result.data ? 500 : 404);
  await adminDb.from("regintel_reviews").insert({
    object_type: "case", object_id: caseId, reviewer_id: admin.userId, decision,
    changes: update, rationale: cleanText(body.rationale, 4000),
  });
  return json(req, { item: result.data });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (!SUPABASE_URL || !SERVICE_KEY) return json(req, { error: "service_configuration_missing" }, 503);
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "cases";
  try {
    if (req.method === "GET" && action === "summary") return await getSummary(req);
    if (req.method === "GET" && action === "sources") return await getSources(req);
    if (req.method === "GET" && action === "case") return await getCaseDetail(req, url);
    if (req.method === "GET" && action === "cases") return await getCases(req, url);
    if (req.method === "POST" && action === "candidates") return await ingestCandidates(req);
    if (req.method === "POST" && action === "review") return await reviewCase(req);
    return json(req, { error: "not_found" }, 404);
  } catch (error) {
    console.error("regintel-api", error);
    return json(req, { error: "internal_error" }, 500);
  }
});
