const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const core = require('../../scripts/regintel-pipeline-core.cjs');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const PBOC = {
  source_code: 'PBOC_BEIJING', jurisdiction: 'CN', regulator: 'PBOC', request_id: 'pboc-1',
  listing_url: 'https://beijing.pbc.gov.cn/beijing/132030/132052/132059/index.html',
  allowed_domains: ['pbc.gov.cn'],
};
const HKMA = {
  source_code: 'HKMA', jurisdiction: 'HK', regulator: 'HKMA', request_id: 'hkma-1',
  listing_url: 'https://api.hkma.gov.hk/public/press-releases?lang=en',
  allowed_domains: ['hkma.gov.hk'],
};

test('PBOC Beijing adapter resolves a relevant official notice and date', () => {
  const result = core.parsePbocBeijing(fixture('pboc-beijing-listing.html'), PBOC);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].publication_date, '2026-09-11');
  assert.match(result.candidates[0].official_url, /2026091117015974812/);
  assert.equal(result.diagnostic.accepted_count, 1);
  assert.equal(result.diagnostic.rejection_reason_counts.irrelevant_title, 1);
});

test('HKMA adapter uses result.records and rejects non-enforcement/homepage items', () => {
  const result = core.parseHkmaApi(JSON.parse(fixture('hkma-press-releases.json')), HKMA);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].title, 'HKMA takes disciplinary action against Example Bank');
  assert.equal(result.diagnostic.raw_result_count, 3);
  assert.equal(result.diagnostic.rejected_count, 2);
});

test('AnySearch nested data.results accepts only official specific actions', () => {
  const response = { code: 0, message: 'success', data: { results: [
    { title: 'PBOC administrative penalty decision 2026-41', url: 'https://beijing.pbc.gov.cn/notices/41?utm_source=test' },
    { title: 'PBOC', url: 'https://beijing.pbc.gov.cn/' },
    { title: 'Commentary on a fine', url: 'https://news.example.com/story' },
  ] } };
  const result = core.parseAnySearch(response, PBOC);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].official_url, 'https://beijing.pbc.gov.cn/notices/41');
  assert.deepEqual(result.diagnostic.rejection_reason_counts, { homepage_only: 1, domain_mismatch: 1 });
});

test('80 mixed search hits produce stable counts, rejection reasons and dedup', () => {
  const results = [];
  for (let i = 0; i < 20; i += 1) results.push({ title: `HKMA disciplinary action ${i}`, url: `https://www.hkma.gov.hk/eng/action/${i}` });
  for (let i = 0; i < 20; i += 1) results.push({ title: `HKMA disciplinary action ${i}`, url: `https://www.hkma.gov.hk/eng/action/${i}?utm_source=duplicate` });
  for (let i = 0; i < 10; i += 1) results.push({ title: 'HKMA home', url: 'https://www.hkma.gov.hk/' });
  for (let i = 0; i < 10; i += 1) results.push({ title: 'Regulatory fine report', url: 'https://third-party.example/report/' + i });
  for (let i = 0; i < 10; i += 1) results.push({ title: 'broken', url: 'not a url' });
  for (let i = 0; i < 10; i += 1) results.push({ title: 'Community event', url: `https://www.hkma.gov.hk/eng/events/${i}` });
  const result = core.parseAnySearch({ code: 0, data: { results } }, HKMA);
  assert.equal(result.diagnostic.raw_result_count, 80);
  assert.equal(result.candidates.length, 20);
  assert.equal(result.diagnostic.rejected_count, 60);
  assert.deepEqual(result.diagnostic.rejection_reason_counts, {
    duplicate: 20, homepage_only: 10, domain_mismatch: 10, invalid_url: 10, irrelevant_title: 10,
  });
});

test('branch merge works with official-only, search-only and both empty', () => {
  const candidate = core.createCandidate(PBOC, { url: 'https://beijing.pbc.gov.cn/action/1', title: '行政处罚决定', discovery_method: 'official' });
  assert.equal(core.mergeCandidates([candidate], []).length, 1);
  assert.equal(core.mergeCandidates([], [{ ...candidate, discovery_method: 'anysearch' }]).length, 1);
  assert.equal(core.mergeCandidates([], []).length, 0);
});

test('request_id matching prevents middle HTTP failure from cross-pairing', () => {
  const requests = [{ request_id: 'a' }, { request_id: 'b' }, { request_id: 'c' }];
  const responses = [{ request_id: 'a', status: 200 }, { request_id: 'c', status: 200 }];
  const paired = core.matchByRequestId(requests, responses);
  assert.equal(paired[0].response.request_id, 'a');
  assert.equal(paired[1].response, null);
  assert.equal(paired[2].response.request_id, 'c');
});

test('preflight skips repeats, permits changed documents and due retries', () => {
  const unchanged = core.preflightDecision({ content_hash: 'same', last_processed_hash: 'same', processing_status: 'processed' }, { content_hash: 'same' });
  const changed = core.preflightDecision({ content_hash: 'old', last_processed_hash: 'old', processing_status: 'processed' }, { content_hash: 'new' });
  const retry = core.preflightDecision({ content_hash: 'same', processing_status: 'retryable', next_retry_at: '2000-01-01T00:00:00Z' }, { content_hash: 'same' });
  assert.deepEqual(unchanged, { process: false, reason: 'duplicate' });
  assert.deepEqual(changed, { process: true, reason: 'changed' });
  assert.deepEqual(retry, { process: true, reason: 'retry' });
});

test('AI validation handles malformed JSON, unrelated items and composite penalties', () => {
  assert.deepEqual(core.validateAiAnalysis('{bad').reasons, ['malformed_json']);
  const unrelated = core.validateAiAnalysis({ relevance: 'not_enforcement', decisions: [{ subjects: [{}] }] });
  assert.equal(unrelated.status, 'rejected');
  assert.equal(unrelated.analysis.decisions.length, 0);
  const composite = core.validateAiAnalysis({ relevance: 'enforcement', decisions: [{
    subjects: [{ name: 'Example' }], penalties: [{ combined_amount: true, amount: 100, amount_allocation_status: 'explicit' }],
  }] });
  assert.equal(composite.valid, false);
  assert.ok(composite.reasons.includes('unsafe_composite_penalty_allocation'));
});

test('candidate contract has stable SHA-256 id and required provenance', () => {
  const first = core.createCandidate(HKMA, { url: 'https://www.hkma.gov.hk/action/1?utm_campaign=x', title: 'HKMA fine action' });
  const second = core.createCandidate(HKMA, { url: 'https://www.hkma.gov.hk/action/1', title: 'HKMA fine action' });
  assert.equal(first.candidate_id, second.candidate_id);
  assert.equal(first.candidate_id.length, 64);
  for (const key of ['source_code', 'jurisdiction', 'regulator', 'official_url', 'source_listing_url', 'verification_status']) assert.ok(first[key]);
});

test('generated n8n workflow is importable, inactive and avoids positional pairing', () => {
  const workflowPath = path.join(__dirname, '..', '..', 'n8n', 'Innobridge_RegIntel_CN_HK_v3_P0_Observable.json');
  const workflow = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
  assert.equal(workflow.active, false);
  assert.equal(workflow.nodes.length, 34);
  const codeText = workflow.nodes.filter((node) => node.type === 'n8n-nodes-base.code').map((node) => node.parameters.jsCode).join('\n');
  assert.doesNotMatch(codeText, /\.all\(\)\s*\[\s*(?:index|i)\s*\]/);
  assert.doesNotMatch(codeText, /_process\s*:\s*false/);
  assert.doesNotMatch(codeText, /\bnew URL\s*\(/);
  assert.match(codeText, /body\?\.data\?\.results/);
  assert.equal(workflow.nodes.some((node) => node.name === 'Expand Search Candidates'), false);
  assert.equal(workflow.nodes.some((node) => node.name === 'Expand Official Candidates'), false);
  assert.ok(workflow.connections['Parse Official Response'].main[0].some((link) => link.node === 'Merge Discovery Candidates' && link.index === 0));
  assert.ok(workflow.connections['Parse Search Response'].main[0].some((link) => link.node === 'Merge Discovery Candidates' && link.index === 1));
  const preflight = workflow.nodes.find((node) => node.name === 'Preflight Candidate');
  assert.match(preflight.parameters.url, /action=preflight/);
  const paid = workflow.nodes.filter((node) => ['AnySearch Corroboration', 'DeepSeek Structured Analysis'].includes(node.name));
  assert.ok(paid.every((node) => node.retryOnFail === true && node.maxTries === 3));
  assert.ok(workflow.nodes.some((node) => node.name === 'Collect Ingest Metrics'));
  assert.match(codeText, /prompt_tokens/);
  for (const node of workflow.nodes.filter((item) => item.type === 'n8n-nodes-base.code')) {
    if (/\.map\([^\n]+=>\(\{json:/.test(node.parameters.jsCode) || /return\s+out\s*;/.test(node.parameters.jsCode)) {
      assert.equal(node.parameters.mode, 'runOnceForAllItems', `${node.name} returns multiple items and must run once for all items`);
    }
    if (node.parameters.mode === 'runOnceForAllItems') {
      assert.doesNotMatch(node.parameters.jsCode, /\$json\b/, `${node.name} must read all-item input via $input`);
    }
  }
});

test('generated n8n parser accepts real AnySearch URLs without the URL global', () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'n8n', 'Innobridge_RegIntel_CN_HK_v3_P0_Observable.json'), 'utf8'));
  const node = workflow.nodes.find((item) => item.name === 'Parse Search Response');
  const execute = new Function('$', '$json', '$execution', node.parameters.jsCode);
  const lookup = () => ({ item: { json: {
    source_code: 'hkma', jurisdiction: 'HK', regulator: 'HKMA',
    listing_url: 'https://api.hkma.gov.hk/public/press-releases?lang=en',
    allowed_domains: ['hkma.gov.hk'], language: 'en', zone: 'intl',
    run_id: 'test-run', request_id: 'search:hkma:test', started_at: '2026-10-27T00:00:00Z',
  } } });
  const result = execute(lookup, { code: 0, data: { results: [{
    title: 'HKMA disciplinary action against Example Bank',
    url: 'https://www.hkma.gov.hk/eng/news-and-media/press-releases/2026/10/example/?utm_source=test',
    snippet: 'The HKMA imposed a monetary penalty.',
  }] } }, { id: 'test-execution' });
  assert.equal(result.json.candidates.length, 1);
  assert.equal(result.json.candidates[0].official_url, 'https://www.hkma.gov.hk/eng/news-and-media/press-releases/2026/10/example/');
  assert.equal(result.json.diagnostic.rejection_reason_counts.invalid_url, undefined);
});

test('generated n8n empty discovery and preflight stages return explicit summaries', () => {
  const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'n8n', 'Innobridge_RegIntel_CN_HK_v3_P0_Observable.json'), 'utf8'));
  const dedup = workflow.nodes.find((item) => item.name === 'Deduplicate Candidates');
  const executeDedup = new Function('$input', '$execution', dedup.parameters.jsCode);
  const discovery = executeDedup({ all: () => [{ json: { candidates: [] } }, { json: { candidates: [] } }] }, { id: 'test-execution' });
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].json.candidate_count, 0);

  const collect = workflow.nodes.find((item) => item.name === 'Collect Preflight Results');
  const executeCollect = new Function('$input', collect.parameters.jsCode);
  const preflight = executeCollect({ all: () => [{ json: { accepted: [], rejected: [{ reason: 'duplicate' }], decisions: [] } }] });
  assert.equal(preflight.length, 1);
  assert.equal(preflight[0].json.accepted_count, 0);
  assert.equal(preflight[0].json.rejected_count, 1);

  const expandDiscovery = workflow.nodes.find((item) => item.name === 'Expand Deduplicated Candidates');
  assert.equal(expandDiscovery.parameters.mode, 'runOnceForAllItems');
  const executeExpandDiscovery = new Function('$input', expandDiscovery.parameters.jsCode);
  const expandedDiscovery = executeExpandDiscovery({ first: () => ({ json: { candidates: [{ candidate_id: 'one' }] } }) });
  assert.deepEqual(expandedDiscovery, [{ json: { candidate_id: 'one' } }]);

  const expandPreflight = workflow.nodes.find((item) => item.name === 'Expand Preflight Accepted');
  assert.equal(expandPreflight.parameters.mode, 'runOnceForAllItems');
  const executeExpandPreflight = new Function('$input', expandPreflight.parameters.jsCode);
  const expandedPreflight = executeExpandPreflight({ first: () => ({ json: { accepted: [{ candidate_id: 'two' }], dry_run: true } }) });
  assert.deepEqual(expandedPreflight, [{ json: { candidate_id: 'two', _dry_run: true } }]);
  assert.ok(workflow.nodes.some((item) => item.name === 'No Candidates Summary'));
  assert.ok(workflow.nodes.some((item) => item.name === 'No Paid Candidates Summary'));
});

test('P0 migration is additive, private and keeps existing RegIntel tables intact', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', '202610270001_regintel_pipeline_observability.sql'), 'utf8');
  assert.match(migration, /create table if not exists public\.regintel_discovery_diagnostics/);
  assert.match(migration, /create table if not exists public\.regintel_discovery_candidates/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.regintel_discovery_candidates from anon, authenticated/);
  assert.match(migration, /prompt_tokens integer not null default 0/);
  assert.match(migration, /create or replace view public\.regintel_latest_source_diagnostics/);
  assert.match(migration, /create or replace view public\.regintel_source_candidate_counts/);
  assert.doesNotMatch(migration, /drop\s+table/i);
});

test('Edge Function preserves public API routes and adds protected diagnostics/preflight routes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'regintel-api', 'index.ts'), 'utf8');
  for (const route of ['summary', 'sources', 'case', 'cases', 'candidates', 'review']) assert.match(source, new RegExp(`action === "${route}"`));
  assert.match(source, /action === "diagnostics"/);
  assert.match(source, /action === "preflight"/);
  assert.match(source, /if \(!ingestAuthorized\(req\)\) return json\(req, \{ error: "unauthorized" \}, 401\)/);
});
