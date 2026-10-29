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

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown, max = 50): unknown[] {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function confidenceValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : 0;
}

function enumValue(value: unknown, allowed: string[], fallback: string): string {
  const text = cleanText(value, 80);
  return text && allowed.includes(text) ? text : fallback;
}

function amountValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integerValue(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function validSha256(value: unknown): string | null {
  const text = cleanText(value, 64)?.toLowerCase() || "";
  return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function ingestAuthorized(req: Request): boolean {
  return Boolean(INGEST_KEY) && req.headers.get("x-ingest-key") === INGEST_KEY;
}

async function requestBody(req: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(req.headers.get("content-length") || 0);
  if (contentLength > MAX_BODY_BYTES) return null;
  try {
    const body = await req.json();
    return objectValue(body);
  } catch {
    return null;
  }
}

const CASE_TYPES = ["fine", "warning", "improvement_order", "suspension", "revocation", "prohibition", "prosecution", "other"];
const SEVERITIES = ["low", "medium", "high", "critical"];
const VIOLATION_CATEGORIES = ["AML_CFT", "KYC_CDD", "EDD", "BENEFICIAL_OWNERSHIP", "SANCTIONS_SCREENING", "TRANSACTION_MONITORING", "STR_SAR", "RECORDKEEPING", "GOVERNANCE", "MARKET_CONDUCT", "FX", "PAYMENTS", "OTHER"];
const EVIDENCE_BASES = ["confirmed_by_regulator", "analyst_inference"];
const ALLOCATION_STATUSES = ["not_applicable", "explicit", "unallocated_composite", "needs_review"];

async function findOrCreateEntity(subject: Record<string, unknown>, jurisdiction: string): Promise<Record<string, unknown> | null> {
  const originalName = cleanText(subject.original_name || subject.name || subject.canonical_name, 500);
  if (!originalName) return null;
  const canonicalName = cleanText(subject.canonical_name || subject.name_en || originalName, 500) || originalName;
  const existing = await adminDb.from("regintel_entities").select("id,canonical_name,original_name").eq("original_name", originalName).limit(1);
  if (existing.data?.[0]) return existing.data[0];
  const entityType = enumValue(subject.entity_type || subject.type, ["organization", "person"], "organization");
  const inserted = await adminDb.from("regintel_entities").insert({
    canonical_name: canonicalName,
    original_name: originalName,
    aliases: arrayValue(subject.aliases, 20).map((item) => String(item).slice(0, 500)),
    country: cleanText(subject.country, 80) || jurisdiction,
    sector: cleanText(subject.sector, 120),
    entity_type: entityType,
    regulator_license_id: cleanText(subject.regulator_license_id, 160),
  }).select("id,canonical_name,original_name").single();
  return inserted.error ? null : inserted.data;
}

function analysisDecisions(analysis: Record<string, unknown>): Record<string, unknown>[] {
  const decisions = arrayValue(analysis.decisions, 20).map(objectValue).filter((item) => Object.keys(item).length);
  return decisions.length ? decisions : [analysis];
}

async function normalizeAnalysis(
  announcement: Record<string, unknown>,
  candidate: Record<string, unknown>,
  source: Record<string, unknown>,
): Promise<{ caseIds: string[]; status: string }> {
  const analysis = objectValue(candidate.ai_analysis);
  const relevance = enumValue(analysis.relevance || analysis.announcement_type, ["enforcement", "not_enforcement", "uncertain"], "uncertain");
  if (relevance !== "enforcement") {
    await adminDb.from("regintel_announcements").update({
      relevance_class: relevance === "not_enforcement" ? "unrelated" : "unknown",
      extraction_status: relevance === "not_enforcement" ? "ignored" : "extracted",
      verification_status: relevance === "uncertain" ? "needs_review" : "unverified",
    }).eq("id", announcement.id);
    return { caseIds: [], status: relevance };
  }

  await adminDb.from("regintel_announcements").update({
    relevance_class: "enforcement",
    extraction_status: "extracted",
    verification_status: "needs_review",
  }).eq("id", announcement.id);

  const caseIds: string[] = [];
  const decisions = analysisDecisions(analysis);
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    const sequence = index + 1;
    const existing = await adminDb.from("regintel_cases").select("id,review_status").eq("announcement_id", announcement.id).eq("case_sequence", sequence).maybeSingle();
    if (existing.data && ["verified", "published"].includes(existing.data.review_status)) {
      caseIds.push(existing.data.id);
      continue;
    }

    const caseRow = {
      announcement_id: announcement.id,
      case_sequence: sequence,
      regulator: cleanText(decision.regulator || source.regulator, 80) || String(source.regulator),
      jurisdiction: enumValue(decision.jurisdiction || source.jurisdiction, ["CN", "HK"], String(source.jurisdiction)),
      decision_number: cleanText(decision.decision_number, 200),
      decision_date: cleanDate(decision.decision_date),
      publication_date: cleanDate(decision.publication_date || candidate.publication_date),
      case_type: enumValue(decision.case_type, CASE_TYPES, "other"),
      case_summary: cleanText(decision.summary_cn || decision.case_summary, 12000),
      case_summary_en: cleanText(decision.summary_en || decision.case_summary_en, 12000),
      confidence: confidenceValue(decision.confidence || analysis.confidence),
      review_status: "needs_review",
      severity: enumValue(decision.severity, SEVERITIES, "medium"),
    };
    const caseResult = existing.data
      ? await adminDb.from("regintel_cases").update(caseRow).eq("id", existing.data.id).select("id").single()
      : await adminDb.from("regintel_cases").insert(caseRow).select("id").single();
    if (caseResult.error || !caseResult.data) throw new Error(`case_normalization_failed:${caseResult.error?.message || "unknown"}`);
    const caseId = caseResult.data.id;
    caseIds.push(caseId);

    await adminDb.from("regintel_control_findings").delete().eq("case_id", caseId);
    await adminDb.from("regintel_penalties").delete().eq("case_id", caseId);
    await adminDb.from("regintel_violations").delete().eq("case_id", caseId);
    await adminDb.from("regintel_case_subjects").delete().eq("case_id", caseId);

    let subjects = arrayValue(decision.subjects, 20);
    if (!subjects.length) subjects = arrayValue(decision.entity_names || analysis.entity_names, 20);
    const subjectIds = new Map<string, string>();
    for (const subjectValue of subjects) {
      const subject = typeof subjectValue === "string" ? { name: subjectValue } : objectValue(subjectValue);
      const entity = await findOrCreateEntity(subject, String(caseRow.jurisdiction));
      if (!entity) continue;
      const entityType = enumValue(subject.entity_type || subject.type, ["organization", "person"], "organization");
      const insertedSubject = await adminDb.from("regintel_case_subjects").insert({
        case_id: caseId,
        entity_id: entity.id,
        subject_role: cleanText(subject.subject_role || subject.role, 80) || "respondent",
        subject_type: entityType === "person" ? "person" : "institution",
        evidence_span: cleanText(subject.evidence_span, 8000),
      }).select("id").single();
      if (!insertedSubject.error && insertedSubject.data) {
        subjectIds.set(String(entity.original_name).toLowerCase(), insertedSubject.data.id);
        subjectIds.set(String(entity.canonical_name).toLowerCase(), insertedSubject.data.id);
      }
    }

    const violationIds: string[] = [];
    for (const value of arrayValue(decision.violations || analysis.violations, 30)) {
      const violation = objectValue(value);
      const inserted = await adminDb.from("regintel_violations").insert({
        case_id: caseId,
        verbatim_wording: cleanText(violation.verbatim_wording || violation.verbatim, 12000),
        normalized_category: enumValue(violation.normalized_category || violation.category, VIOLATION_CATEGORIES, "OTHER"),
        legal_citation: cleanText(violation.legal_citation || violation.legal_basis, 2000),
        source_span: cleanText(violation.source_span || violation.evidence_span, 12000),
        source_page: Number.isInteger(Number(violation.source_page)) ? Math.max(1, Number(violation.source_page)) : null,
        classification_basis: enumValue(violation.classification_basis || violation.basis, EVIDENCE_BASES, "analyst_inference"),
        confidence: confidenceValue(violation.confidence),
      }).select("id").single();
      if (!inserted.error && inserted.data) violationIds.push(inserted.data.id);
    }

    for (const value of arrayValue(decision.penalties || analysis.penalties, 20)) {
      const penalty = objectValue(value);
      const subjectName = cleanText(penalty.subject_name, 500)?.toLowerCase() || "";
      const currency = cleanText(penalty.currency, 3)?.toUpperCase() || null;
      await adminDb.from("regintel_penalties").insert({
        case_id: caseId,
        subject_id: subjectIds.get(subjectName) || null,
        penalty_type: cleanText(penalty.penalty_type || penalty.type, 120) || "other",
        currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
        amount: amountValue(penalty.amount),
        original_amount_text: cleanText(penalty.original_amount_text, 1000),
        joint_and_several: penalty.joint_and_several === true,
        applies_to: enumValue(penalty.applies_to, ["institution", "person", "mixed", "unknown"], "unknown"),
        combined_amount: penalty.combined_amount === true,
        amount_allocation_status: enumValue(penalty.amount_allocation_status, ALLOCATION_STATUSES, penalty.combined_amount === true ? "needs_review" : "not_applicable"),
        effective_date: cleanDate(penalty.effective_date),
        evidence_span: cleanText(penalty.evidence_span, 12000),
      });
    }

    for (const value of arrayValue(decision.control_findings || decision.key_issues || analysis.control_findings, 30)) {
      const finding = objectValue(value);
      const observedFailure = cleanText(finding.observed_failure || finding.issue, 12000);
      if (!observedFailure) continue;
      const violationIndex = Number(finding.violation_index);
      await adminDb.from("regintel_control_findings").insert({
        case_id: caseId,
        violation_id: Number.isInteger(violationIndex) ? violationIds[violationIndex] || null : (violationIds.length === 1 ? violationIds[0] : null),
        control_domain: cleanText(finding.control_domain || finding.domain, 160) || "OTHER",
        observed_failure: observedFailure,
        possible_root_cause: cleanText(finding.possible_root_cause, 12000),
        classification: enumValue(finding.classification || finding.basis, EVIDENCE_BASES, "analyst_inference"),
        evidence_span: cleanText(finding.evidence_span, 12000),
        confidence: confidenceValue(finding.confidence),
      });
    }
  }
  return { caseIds, status: "needs_review" };
}

async function recordDiagnostics(req: Request): Promise<Response> {
  if (!INGEST_KEY) return json(req, { error: "ingestion_not_configured" }, 503);
  if (!ingestAuthorized(req)) return json(req, { error: "unauthorized" }, 401);
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json(req, { error: "payload_too_large" }, 413);
  const body = await requestBody(req);
  if (!body) return json(req, { error: "invalid_json_or_payload_too_large" }, 400);
  const items = Array.isArray(body.items) ? body.items : [body];
  if (!items.length || items.length > 100) return json(req, { error: "items_must_contain_1_to_100_diagnostics" }, 400);

  const sourceCodes = [...new Set(items.map((value) => cleanText(objectValue(value).source_code, 40)).filter(Boolean))];
  if (!sourceCodes.length) return json(req, { error: "source_code_required" }, 400);
  const sourceResult = await adminDb
    .from("regintel_sources")
    .select("id,source_code,consecutive_failures")
    .in("source_code", sourceCodes);
  if (sourceResult.error) return json(req, { error: "source_lookup_failed" }, 500);
  const sourceMap = new Map((sourceResult.data || []).map((source) => [source.source_code, source]));
  const rows: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];
  const sourceUpdates: Array<{ id: string; update: Record<string, unknown> }> = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = objectValue(items[index]);
    const sourceCode = cleanText(item.source_code, 40);
    const source = sourceCode ? sourceMap.get(sourceCode) : null;
    const runId = cleanText(item.run_id, 128);
    const requestId = cleanText(item.request_id, 160);
    const jurisdiction = enumValue(item.jurisdiction, ["CN", "HK"], "");
    const method = enumValue(item.discovery_method, ["official", "anysearch"], "");
    const fetchStatus = enumValue(item.fetch_status, ["succeeded", "empty", "failed", "partial"], "");
    if (!source || !runId || !requestId || !jurisdiction || !method || !fetchStatus) {
      rejected.push({ index, reason: "invalid_diagnostic_contract" });
      continue;
    }
    const acceptedCount = integerValue(item.accepted_count);
    const now = new Date().toISOString();
    rows.push({
      run_id: runId,
      request_id: requestId,
      source_id: source.id,
      source_code: sourceCode,
      jurisdiction,
      discovery_method: method,
      fetch_status: fetchStatus,
      http_status: integerValue(item.http_status) || null,
      raw_result_count: integerValue(item.raw_result_count),
      parsed_count: integerValue(item.parsed_count),
      accepted_count: acceptedCount,
      rejected_count: integerValue(item.rejected_count),
      rejection_reason_counts: objectValue(item.rejection_reason_counts),
      last_successful_fetch: ["succeeded", "empty", "partial"].includes(fetchStatus) ? now : null,
      last_valid_discovery: acceptedCount > 0 ? now : null,
      error_message: cleanText(item.error_message, 4000),
      workflow_execution_id: cleanText(item.workflow_execution_id, 128),
      started_at: cleanText(item.started_at, 64),
      finished_at: cleanText(item.finished_at, 64) || now,
      metadata: objectValue(item.metadata),
    });
    const failed = fetchStatus === "failed";
    sourceUpdates.push({
      id: String(source.id),
      update: {
        last_checked_at: now,
        ...(failed ? {} : { last_success_at: now }),
        ...(acceptedCount > 0 ? { last_item_at: now } : {}),
        error_status: failed ? (cleanText(item.error_message, 1000) || "collector_failed") : null,
        consecutive_failures: failed ? integerValue(source.consecutive_failures) + 1 : 0,
      },
    });
  }

  if (rows.length) {
    const result = await adminDb
      .from("regintel_discovery_diagnostics")
      .upsert(rows, { onConflict: "run_id,request_id,discovery_method" });
    if (result.error) return json(req, { error: "diagnostic_write_failed", detail: result.error.message }, 500);
    await Promise.all(sourceUpdates.map(({ id, update }) => adminDb.from("regintel_sources").update(update).eq("id", id)));
  }
  return json(req, { accepted: rows.length, rejected }, rejected.length ? 207 : 202);
}

async function preflightCandidates(req: Request): Promise<Response> {
  if (!INGEST_KEY) return json(req, { error: "ingestion_not_configured" }, 503);
  if (!ingestAuthorized(req)) return json(req, { error: "unauthorized" }, 401);
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json(req, { error: "payload_too_large" }, 413);
  const body = await requestBody(req);
  if (!body) return json(req, { error: "invalid_json_or_payload_too_large" }, 400);
  const items = Array.isArray(body.items) ? body.items : [body];
  if (!items.length || items.length > 100) return json(req, { error: "items_must_contain_1_to_100_candidates" }, 400);
  const dryRun = body.dry_run === true;

  const sourceCodes = [...new Set(items.map((value) => {
    const item = objectValue(value);
    return cleanText(item.source_code || item.source_id, 40);
  }).filter(Boolean))];
  if (!sourceCodes.length) return json(req, { error: "source_code_required" }, 400);
  const sourceResult = await adminDb
    .from("regintel_sources")
    .select("id,source_code,regulator,jurisdiction,allowed_domains,enabled,production_ready")
    .in("source_code", sourceCodes);
  if (sourceResult.error) return json(req, { error: "source_lookup_failed" }, 500);
  const sourceMap = new Map((sourceResult.data || []).map((source) => [source.source_code, source]));
  const accepted: Array<Record<string, unknown>> = [];
  const rejected: Array<Record<string, unknown>> = [];
  const decisions: Array<Record<string, unknown>> = [];

  for (let index = 0; index < items.length; index += 1) {
    const candidate = objectValue(items[index]);
    const sourceCode = cleanText(candidate.source_code || candidate.source_id, 40);
    const source = sourceCode ? sourceMap.get(sourceCode) : null;
    const url = canonicalUrl(candidate.official_url || candidate.url || candidate.canonical_url);
    const title = cleanText(candidate.title, 1000);
    if (!source || !source.enabled || !source.production_ready) {
      rejected.push({ index, reason: "unknown_or_disabled_source" });
      continue;
    }
    if (!url) { rejected.push({ index, reason: "invalid_url" }); continue; }
    if (!hostAllowed(url.hostname, source.allowed_domains || [])) { rejected.push({ index, reason: "domain_mismatch" }); continue; }
    if (!title) { rejected.push({ index, reason: "missing_title" }); continue; }
    const candidateId = validSha256(candidate.candidate_id) || await sha256(`${sourceCode}|${url.href}`);
    const suppliedHash = validSha256(candidate.content_hash);
    const evidenceText = cleanText(candidate.official_text || candidate.raw_text, 100000) || "";
    const contentHash = suppliedHash || await sha256(`${url.href}|${title}|${cleanDate(candidate.publication_date) || ""}|${evidenceText}`);
    const existingResult = await adminDb
      .from("regintel_discovery_candidates")
      .select("candidate_id,content_hash,last_processed_hash,processing_status,next_retry_at,attempt_count")
      .eq("candidate_id", candidateId)
      .maybeSingle();
    if (existingResult.error) return json(req, { error: "candidate_preflight_lookup_failed", detail: existingResult.error.message }, 500);
    const existing = existingResult.data;
    const retryDue = existing && ["failed", "retryable"].includes(existing.processing_status)
      && (!existing.next_retry_at || new Date(existing.next_retry_at).getTime() <= Date.now());
    const changed = Boolean(existing && contentHash !== existing.content_hash && contentHash !== existing.last_processed_hash);
    const shouldProcess = !existing || changed || retryDue;
    const reason = !existing ? "new" : changed ? "changed" : retryDue ? "retry" : "duplicate";
    const normalized = {
      ...candidate,
      candidate_id: candidateId,
      source_code: sourceCode,
      jurisdiction: source.jurisdiction,
      regulator: source.regulator,
      official_url: url.href,
      url: url.href,
      content_hash: contentHash,
      verification_status: "unverified",
    };
    decisions.push({ candidate_id: candidateId, official_url: url.href, process: shouldProcess, reason });
    if (!shouldProcess) {
      rejected.push({ index, candidate_id: candidateId, reason: "duplicate" });
      if (!dryRun) await adminDb.from("regintel_discovery_candidates").update({ last_seen_at: new Date().toISOString() }).eq("candidate_id", candidateId);
      continue;
    }
    accepted.push(normalized);
    if (!dryRun) {
      const now = new Date().toISOString();
      const row = {
        candidate_id: candidateId,
        source_id: source.id,
        source_code: sourceCode,
        jurisdiction: source.jurisdiction,
        regulator: source.regulator,
        official_url: url.href,
        source_listing_url: cleanText(candidate.source_listing_url || candidate.source_page, 2048),
        discovery_method: enumValue(candidate.discovery_method, ["official", "anysearch"], "official"),
        title,
        publication_date: cleanDate(candidate.publication_date),
        verification_status: "unverified",
        processing_status: "queued",
        content_hash: contentHash,
        first_seen_at: existing ? undefined : now,
        last_seen_at: now,
        attempt_count: integerValue(existing?.attempt_count) + 1,
        next_retry_at: null,
        error_detail: null,
        metadata: { request_id: cleanText(candidate.request_id, 160), run_id: cleanText(candidate.run_id, 128), reason },
      };
      const result = await adminDb.from("regintel_discovery_candidates").upsert(row, { onConflict: "candidate_id" });
      if (result.error) return json(req, { error: "candidate_preflight_write_failed", detail: result.error.message }, 500);
    }
  }
  return json(req, { dry_run: dryRun, accepted, rejected, decisions, paid_call_candidates: accepted.length }, 200);
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
    .select("source_code,regulator,regulator_name_local,jurisdiction,listing_url,access_method,adapter_type,enabled,production_ready,last_checked_at,last_success_at,last_item_at,error_status,consecutive_failures,coverage_notes")
    .order("jurisdiction")
    .order("regulator");
  if (error) return json(req, { error: "sources_query_failed" }, 500);
  const diagnosticsResult = await adminDb
    .from("regintel_latest_source_diagnostics")
    .select("source_code,fetch_status,raw_result_count,parsed_count,accepted_count,rejected_count,rejection_reason_counts,last_successful_fetch,last_valid_discovery,created_at")
    .order("source_code");
  const candidateResult = await adminDb
    .from("regintel_source_candidate_counts")
    .select("source_code,queued,unverified,errors");
  const latest = new Map<string, Record<string, unknown>>();
  for (const item of diagnosticsResult.data || []) {
    latest.set(item.source_code, item);
  }
  const queueCounts = new Map<string, Record<string, number>>();
  for (const item of candidateResult.data || []) {
    queueCounts.set(item.source_code, {
      queued: integerValue(item.queued),
      unverified: integerValue(item.unverified),
      errors: integerValue(item.errors),
    });
  }
  return json(req, {
    items: (data || []).map((source) => ({
      ...source,
      latest_diagnostic: latest.get(source.source_code) || null,
      queue_counts: queueCounts.get(source.source_code) || { unverified: 0, errors: 0, queued: 0 },
    })),
  });
}

async function getReviewQueue(req: Request, url: URL): Promise<Response> {
  const admin = await requireAdmin(req);
  if (!admin) return json(req, { error: "admin_authorization_required" }, 403);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);
  const status = cleanText(url.searchParams.get("status"), 24);
  const allowedStatuses = ["needs_review", "in_review", "verified"];
  let query = adminDb.from("regintel_cases").select(CASE_SELECT, { count: "exact" });
  query = status && allowedStatuses.includes(status) ? query.eq("review_status", status) : query.in("review_status", allowedStatuses);
  const { data, error, count } = await query
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return json(req, { error: "review_queue_query_failed", detail: error.message }, 500);
  return json(req, { items: data || [], total: count || 0, role: admin.role });
}

async function ingestCandidates(req: Request): Promise<Response> {
  if (!INGEST_KEY) return json(req, { error: "ingestion_not_configured" }, 503);
  if (!ingestAuthorized(req)) return json(req, { error: "unauthorized" }, 401);
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY_BYTES) return json(req, { error: "payload_too_large" }, 413);
  const body = await requestBody(req);
  if (!body) return json(req, { error: "invalid_json_or_payload_too_large" }, 400);
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
    const sourceResult = await adminDb.from("regintel_sources").select("id,source_code,regulator,jurisdiction,allowed_domains,enabled,production_ready").in("source_code", sourceCodes);
    if (sourceResult.error) return json(req, { error: "source_lookup_failed" }, 500);
    sourceRows = sourceResult.data || [];
  }
  const sourceMap = new Map(sourceRows.map((source) => [source.source_code, source]));
  const rows: Array<Record<string, unknown>> = [];
  const inputByUrl = new Map<string, Record<string, unknown>>();
  const rejected: Array<Record<string, unknown>> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as Record<string, unknown>;
    const sourceCode = cleanText(candidate.source_code || candidate.source_id, 40);
    const source = sourceCode ? sourceMap.get(sourceCode) : null;
    const url = canonicalUrl(candidate.url || candidate.canonical_url);
    if (!source || !source.enabled || !source.production_ready) { rejected.push({ index, reason: "unknown_or_disabled_source" }); continue; }
    if (!url || !hostAllowed(url.hostname, source.allowed_domains || [])) { rejected.push({ index, reason: "url_not_allowed" }); continue; }
    const title = cleanText(candidate.title, 1000);
    const suppliedHash = validSha256(candidate.content_hash);
    const evidenceText = cleanText(candidate.official_text || candidate.raw_text, 100000) || "";
    const contentHash = suppliedHash || await sha256(`${sourceCode}|${url.href}|${title || ""}|${cleanDate(candidate.publication_date) || ""}|${evidenceText}`);
    const candidateId = validSha256(candidate.candidate_id) || await sha256(`${sourceCode}|${url.href}`);
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
        candidate_id: candidateId,
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
    inputByUrl.set(url.href, candidate);
  }

  let inserted: Array<Record<string, unknown>> = [];
  let acceptedRows: Array<Record<string, unknown>> = [];
  if (rows.length) {
    const result = await adminDb.from("regintel_announcements").upsert(rows, { onConflict: "canonical_url", ignoreDuplicates: true }).select("id,canonical_url,verification_status,extraction_status");
    if (result.error) return json(req, { error: "candidate_insert_failed", detail: result.error.message }, 500);
    inserted = result.data || [];
    const acceptedResult = await adminDb.from("regintel_announcements").select("id,source_id,canonical_url,verification_status,extraction_status").in("canonical_url", rows.map((row) => row.canonical_url));
    if (!acceptedResult.error) acceptedRows = acceptedResult.data || [];
    const sourceIds = [...new Set(rows.map((row) => row.source_id))];
    await adminDb.from("regintel_sources").update({ last_checked_at: new Date().toISOString(), last_success_at: new Date().toISOString(), consecutive_failures: 0, error_status: null }).in("id", sourceIds);
  }
  const insertedUrls = new Set(inserted.map((row) => row.canonical_url));
  const records = acceptedRows.map((row) => ({ ...row, status: insertedUrls.has(row.canonical_url) ? "queued" : "duplicate" }));
  const normalized: Array<Record<string, unknown>> = [];
  const normalizationErrors: Array<Record<string, unknown>> = [];
  for (const announcement of acceptedRows) {
    const candidate = inputByUrl.get(String(announcement.canonical_url));
    const source = sourceRows.find((item) => item.id === announcement.source_id);
    if (!candidate || !source) continue;
    try {
      const result = await normalizeAnalysis(announcement, candidate, source);
      normalized.push({ announcement_id: announcement.id, ...result });
      const candidateId = validSha256(candidate.candidate_id);
      if (candidateId) {
        const usage = objectValue(candidate.usage);
        await adminDb.from("regintel_discovery_candidates").update({
          processing_status: "processed",
          verification_status: result.status === "needs_review" ? "needs_review" : "unverified",
          last_processed_hash: validSha256(candidate.content_hash),
          processed_at: new Date().toISOString(),
          next_retry_at: null,
          error_detail: null,
          search_call_count: integerValue(usage.search_calls),
          model_call_count: integerValue(usage.model_calls),
          prompt_tokens: integerValue(usage.prompt_tokens),
          completion_tokens: integerValue(usage.completion_tokens),
          total_tokens: integerValue(usage.total_tokens),
        }).eq("candidate_id", candidateId);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      normalizationErrors.push({ announcement_id: announcement.id, error: detail.slice(0, 500) });
      await adminDb.from("regintel_announcements").update({ error_detail: detail.slice(0, 4000), verification_status: "needs_review" }).eq("id", announcement.id);
      const candidateId = validSha256(candidate.candidate_id);
      if (candidateId) {
        await adminDb.from("regintel_discovery_candidates").update({
          processing_status: "retryable",
          verification_status: "needs_review",
          next_retry_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          error_detail: detail.slice(0, 4000),
        }).eq("candidate_id", candidateId);
      }
    }
  }
  const single = candidates.length === 1 && records.length === 1 ? { candidate_id: records[0].id, status: records[0].status } : {};
  return json(req, { ...single, accepted: rows.length, inserted: inserted.length, duplicates: rows.length - inserted.length, rejected, records, normalized, normalization_errors: normalizationErrors }, normalizationErrors.length ? 207 : 202);
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
  if (["publish", "unpublish"].includes(decision) && !["admin", "super_admin"].includes(admin.role)) {
    return json(req, { error: "publisher_role_required" }, 403);
  }
  const current = await adminDb.from("regintel_cases").select("id,review_status").eq("id", caseId).maybeSingle();
  if (current.error || !current.data) return json(req, { error: "case_not_found" }, 404);
  if (decision === "publish" && current.data.review_status !== "verified") {
    return json(req, { error: "case_must_be_verified_before_publish" }, 409);
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
    if (req.method === "GET" && action === "review_queue") return await getReviewQueue(req, url);
    if (req.method === "GET" && action === "case") return await getCaseDetail(req, url);
    if (req.method === "GET" && action === "cases") return await getCases(req, url);
    if (req.method === "POST" && action === "diagnostics") return await recordDiagnostics(req);
    if (req.method === "POST" && action === "preflight") return await preflightCandidates(req);
    if (req.method === "POST" && action === "candidates") return await ingestCandidates(req);
    if (req.method === "POST" && action === "review") return await reviewCase(req);
    return json(req, { error: "not_found" }, 404);
  } catch (error) {
    console.error("regintel-api", error);
    return json(req, { error: "internal_error" }, 500);
  }
});
