const crypto = require('node:crypto');

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'fbclid',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonicalizeUrl(value, baseUrl) {
  try {
    const url = new URL(String(value || ''), baseUrl);
    if (url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return null;
  }
}

function hostnameAllowed(value, allowedDomains) {
  try {
    const host = new URL(value).hostname.toLowerCase().replace(/\.$/, '');
    return (allowedDomains || []).some((domain) => {
      const normalized = String(domain).toLowerCase().replace(/^www\./, '');
      return host === normalized || host === `www.${normalized}` || host.endsWith(`.${normalized}`);
    });
  } catch {
    return false;
  }
}

function isHomepage(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    return path === '/' || /^\/(index(?:\.html?)?)?$/i.test(path);
  } catch {
    return true;
  }
}

function enforcementRelevant(title) {
  const value = String(title || '').toLowerCase();
  return /(行政处罚|处罚决定|罚款|纪律处分|enforcement|disciplin|penalt|fine|prosecut|convict|reprimand|revocation|suspension)/i.test(value);
}

function stripTags(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function createCandidate(spec, raw) {
  const officialUrl = canonicalizeUrl(raw.official_url || raw.url, spec.listing_url);
  if (!officialUrl) return null;
  return {
    candidate_id: sha256(`${spec.source_code}|${officialUrl}`),
    source_code: spec.source_code,
    jurisdiction: spec.jurisdiction,
    regulator: spec.regulator,
    official_url: officialUrl,
    url: officialUrl,
    discovery_method: raw.discovery_method || 'official',
    title: stripTags(raw.title),
    publication_date: raw.publication_date || null,
    source_listing_url: spec.listing_url,
    discovered_at: raw.discovered_at || new Date(0).toISOString(),
    verification_status: 'unverified',
    search_evidence: raw.search_evidence || [],
  };
}

function emptyDiagnostic(spec, method, overrides = {}) {
  return {
    source_code: spec.source_code,
    jurisdiction: spec.jurisdiction,
    request_id: spec.request_id,
    discovery_method: method,
    fetch_status: 'empty',
    http_status: null,
    raw_result_count: 0,
    parsed_count: 0,
    accepted_count: 0,
    rejected_count: 0,
    rejection_reason_counts: {},
    error_message: null,
    ...overrides,
  };
}

function reject(diagnostic, reason) {
  diagnostic.rejected_count += 1;
  diagnostic.rejection_reason_counts[reason] = (diagnostic.rejection_reason_counts[reason] || 0) + 1;
}

function parseAnySearch(response, spec) {
  const diagnostic = emptyDiagnostic(spec, 'anysearch');
  const body = response && response.body !== undefined ? response.body : response;
  const httpStatus = Number(response && (response.statusCode || response.status)) || 200;
  diagnostic.http_status = httpStatus;
  if (httpStatus >= 400) {
    diagnostic.fetch_status = 'failed';
    diagnostic.error_message = `http_${httpStatus}`;
    return { candidates: [], diagnostic };
  }
  if (!body || Number(body.code) !== 0 || !body.data || !Array.isArray(body.data.results)) {
    diagnostic.fetch_status = 'failed';
    diagnostic.error_message = body && body.message ? String(body.message) : 'invalid_anysearch_response';
    return { candidates: [], diagnostic };
  }
  const results = body.data.results;
  diagnostic.raw_result_count = results.length;
  const accepted = [];
  const seen = new Set();
  for (const result of results) {
    diagnostic.parsed_count += 1;
    const rawUrl = result && (result.url || result.link);
    const url = canonicalizeUrl(rawUrl);
    if (!url) { reject(diagnostic, 'invalid_url'); continue; }
    if (!hostnameAllowed(url, spec.allowed_domains)) { reject(diagnostic, 'domain_mismatch'); continue; }
    if (isHomepage(url)) { reject(diagnostic, 'homepage_only'); continue; }
    const title = stripTags(result.title);
    if (!title || !enforcementRelevant(title)) { reject(diagnostic, 'irrelevant_title'); continue; }
    if (seen.has(url)) { reject(diagnostic, 'duplicate'); continue; }
    seen.add(url);
    const candidate = createCandidate(spec, {
      url,
      title,
      publication_date: result.published_date || result.date || null,
      discovery_method: 'anysearch',
      search_evidence: [{ title, url, snippet: stripTags(result.snippet || result.description) }],
    });
    if (!candidate) { reject(diagnostic, 'invalid_url'); continue; }
    accepted.push(candidate);
  }
  diagnostic.accepted_count = accepted.length;
  diagnostic.fetch_status = accepted.length ? (diagnostic.rejected_count ? 'partial' : 'succeeded') : 'empty';
  return { candidates: accepted, diagnostic };
}

function parsePbocBeijing(html, spec) {
  const diagnostic = emptyDiagnostic(spec, 'official', { http_status: 200 });
  const candidates = [];
  const seen = new Set();
  const rowPattern = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let row;
  while ((row = rowPattern.exec(String(html || '')))) {
    const content = row[1];
    const link = content.match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    diagnostic.raw_result_count += 1;
    diagnostic.parsed_count += 1;
    const url = canonicalizeUrl(link[1], spec.listing_url);
    const title = stripTags(link[2]);
    const date = stripTags(content).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
    if (!url) { reject(diagnostic, 'invalid_url'); continue; }
    if (!hostnameAllowed(url, spec.allowed_domains)) { reject(diagnostic, 'domain_mismatch'); continue; }
    if (!enforcementRelevant(title)) { reject(diagnostic, 'irrelevant_title'); continue; }
    if (seen.has(url)) { reject(diagnostic, 'duplicate'); continue; }
    seen.add(url);
    candidates.push(createCandidate(spec, {
      url,
      title,
      publication_date: date ? `${date[1]}-${date[2].padStart(2, '0')}-${date[3].padStart(2, '0')}` : null,
      discovery_method: 'official',
    }));
  }
  diagnostic.accepted_count = candidates.length;
  diagnostic.fetch_status = candidates.length ? (diagnostic.rejected_count ? 'partial' : 'succeeded') : 'empty';
  return { candidates: candidates.filter(Boolean), diagnostic };
}

function parseHkmaApi(response, spec) {
  const diagnostic = emptyDiagnostic(spec, 'official', { http_status: 200 });
  const records = response && response.result && Array.isArray(response.result.records) ? response.result.records : [];
  diagnostic.raw_result_count = records.length;
  const candidates = [];
  const seen = new Set();
  for (const record of records) {
    diagnostic.parsed_count += 1;
    const url = canonicalizeUrl(record.link || record.url, 'https://www.hkma.gov.hk/');
    const title = stripTags(record.title);
    if (!url) { reject(diagnostic, 'invalid_url'); continue; }
    if (!hostnameAllowed(url, spec.allowed_domains)) { reject(diagnostic, 'domain_mismatch'); continue; }
    if (isHomepage(url)) { reject(diagnostic, 'homepage_only'); continue; }
    if (!enforcementRelevant(title)) { reject(diagnostic, 'irrelevant_title'); continue; }
    if (seen.has(url)) { reject(diagnostic, 'duplicate'); continue; }
    seen.add(url);
    candidates.push(createCandidate(spec, {
      url,
      title,
      publication_date: record.date || null,
      discovery_method: 'official',
    }));
  }
  diagnostic.accepted_count = candidates.length;
  diagnostic.fetch_status = candidates.length ? (diagnostic.rejected_count ? 'partial' : 'succeeded') : 'empty';
  return { candidates: candidates.filter(Boolean), diagnostic };
}

function mergeCandidates(official, search) {
  const candidates = [];
  const seen = new Set();
  for (const candidate of [...(official || []), ...(search || [])]) {
    if (!candidate || !candidate.candidate_id || !candidate.official_url) continue;
    if (seen.has(candidate.candidate_id)) continue;
    seen.add(candidate.candidate_id);
    candidates.push(candidate);
  }
  return candidates;
}

function matchByRequestId(requests, responses) {
  const byId = new Map((responses || []).map((response) => [response.request_id, response]));
  return (requests || []).map((request) => ({ request, response: byId.get(request.request_id) || null }));
}

function preflightDecision(existing, candidate) {
  if (!existing) return { process: true, reason: 'new' };
  if (candidate.content_hash && candidate.content_hash !== existing.content_hash && candidate.content_hash !== existing.last_processed_hash) {
    return { process: true, reason: 'changed' };
  }
  if (['failed', 'retryable'].includes(existing.processing_status)
      && (!existing.next_retry_at || new Date(existing.next_retry_at).getTime() <= Date.now())) {
    return { process: true, reason: 'retry' };
  }
  return { process: false, reason: 'duplicate' };
}

function validateAiAnalysis(value) {
  let analysis = value;
  if (typeof value === 'string') {
    try { analysis = JSON.parse(value); } catch { return { valid: false, status: 'needs_review', reasons: ['malformed_json'] }; }
  }
  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    return { valid: false, status: 'needs_review', reasons: ['invalid_object'] };
  }
  if (!['enforcement', 'not_enforcement', 'uncertain'].includes(analysis.relevance)) {
    return { valid: false, status: 'needs_review', reasons: ['invalid_relevance'] };
  }
  if (analysis.relevance === 'not_enforcement') {
    return { valid: true, status: 'rejected', reasons: ['unrelated_article'], analysis: { ...analysis, decisions: [] } };
  }
  const decisions = Array.isArray(analysis.decisions) ? analysis.decisions : [];
  if (analysis.relevance === 'enforcement' && decisions.length === 0) {
    return { valid: false, status: 'needs_review', reasons: ['missing_decisions'] };
  }
  const reasons = [];
  for (const decision of decisions) {
    if (!decision || typeof decision !== 'object') { reasons.push('invalid_decision'); continue; }
    if (!Array.isArray(decision.subjects) || decision.subjects.length === 0) reasons.push('missing_subjects');
    for (const penalty of Array.isArray(decision.penalties) ? decision.penalties : []) {
      if (penalty && penalty.combined_amount === true && !['unallocated_composite', 'needs_review'].includes(penalty.amount_allocation_status)) {
        reasons.push('unsafe_composite_penalty_allocation');
      }
      if (penalty && penalty.amount !== null && penalty.amount !== undefined && !Number.isFinite(Number(penalty.amount))) reasons.push('invalid_penalty_amount');
    }
  }
  return { valid: reasons.length === 0, status: 'needs_review', reasons: [...new Set(reasons)], analysis };
}

module.exports = {
  canonicalizeUrl,
  createCandidate,
  enforcementRelevant,
  hostnameAllowed,
  isHomepage,
  matchByRequestId,
  mergeCandidates,
  parseAnySearch,
  parseHkmaApi,
  parsePbocBeijing,
  preflightDecision,
  sha256,
  validateAiAnalysis,
};
