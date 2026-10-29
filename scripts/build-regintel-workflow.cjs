const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const output = path.join(__dirname, '..', 'n8n', 'Innobridge_RegIntel_CN_HK_v3_P0_Observable.json');
const id = (name) => crypto.createHash('sha1').update(name).digest('hex').slice(0, 8) + '-0000-4000-8000-' + crypto.createHash('md5').update(name).digest('hex').slice(0, 12);
const nodes = [];
const connections = {};
const n8nUrlHelpers = String.raw`
const parseWebUrl=(value,base)=>{
  let raw=String(value||'').trim().replace(/&amp;/gi,'&');
  if(!raw||/[\u0000-\u001f\u007f\s]/.test(raw))return null;
  const baseMatch=String(base||'').match(/^https?:\/\/([^\/?#]+)/i);
  if(raw.startsWith('//'))raw='https:'+raw;
  else if(!/^https?:\/\//i.test(raw)){
    if(!baseMatch)return null;
    const origin='https://'+baseMatch[1];
    if(raw.startsWith('/'))raw=origin+raw;
    else {
      const cleanBase=String(base||'').split(/[?#]/)[0];
      raw=cleanBase.replace(/\/[^/]*$/,'/')+raw;
    }
  }
  const match=raw.match(/^https?:\/\/([^\/?#]+)([^#]*)?(?:#.*)?$/i);
  if(!match||!match[1]||match[1].includes('@'))return null;
  const host=match[1].toLowerCase().replace(/\.$/,'');
  let tail=match[2]||'/';
  const queryIndex=tail.indexOf('?');
  let pathname=queryIndex>=0?tail.slice(0,queryIndex):tail;
  const query=queryIndex>=0?tail.slice(queryIndex+1):'';
  if(!pathname.startsWith('/'))pathname='/'+pathname;
  const trailingSlash=pathname.endsWith('/');const parts=[];
  for(const segment of pathname.split('/')){if(!segment||segment==='.')continue;if(segment==='..')parts.pop();else parts.push(segment);}
  pathname='/'+parts.join('/')+(trailingSlash&&parts.length?'/':'');
  const tracking=new Set(['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','fbclid']);
  const kept=query.split('&').filter(Boolean).filter(pair=>{
    const key=pair.split('=',1)[0];
    try{return !tracking.has(decodeURIComponent(key).toLowerCase());}catch{return !tracking.has(key.toLowerCase());}
  });
  return {href:'https://'+host+pathname+(kept.length?'?'+kept.join('&'):''),host,pathname};
};
const hostAllowed=(host,domains)=>(domains||[]).some(domain=>{
  const safe=String(domain||'').toLowerCase().replace(/^www\./,'').replace(/\.$/,'');
  return host===safe||host==='www.'+safe||host.endsWith('.'+safe);
});`;
const add = (node) => { nodes.push({ id: id(node.name), typeVersion: node.typeVersion || 2, ...node }); };
const connect = (from, to, outputIndex = 0, inputIndex = 0) => {
  if (!connections[from]) connections[from] = { main: [] };
  while (connections[from].main.length <= outputIndex) connections[from].main.push([]);
  connections[from].main[outputIndex].push({ node: to, type: 'main', index: inputIndex });
};
const code = (name, position, jsCode, mode = 'runOnceForAllItems') => add({
  name, type: 'n8n-nodes-base.code', position, parameters: { mode, jsCode }, typeVersion: 2,
});
const http = (name, position, parameters, extra = {}) => add({
  name, type: 'n8n-nodes-base.httpRequest', position, parameters, typeVersion: 4.2,
  retryOnFail: true, maxTries: 3, waitBetweenTries: 3000, ...extra,
});
const diagnosticHttp = (name, position) => http(name, position, {
  method: 'POST',
  url: "={{ ($env.REGINTEL_API_BASE_URL || 'https://hbfdelixtwkegxpmfyea.supabase.co/functions/v1/regintel-api') + '?action=diagnostics' }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'X-Ingest-Key', value: '={{ $env.REGINTEL_INGEST_KEY }}' },
  ] },
  sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify({items:[$json.diagnostic]}) }}',
  options: { timeout: 30000 },
}, { onError: 'continueRegularOutput' });

add({
  name: 'Every 3 Hours', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-1500, 360],
  parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 3 }] } },
});

code('Official Source Registry', [-1280, 180], String.raw`
const runId = 'regintel-' + $execution.id;
const sources = [
  {source_code:'pbc',jurisdiction:'CN',regulator:'PBOC',listing_url:'https://beijing.pbc.gov.cn/beijing/132030/132052/132059/index.html',adapter_type:'pbc_beijing_html',language:'zh-CN',zone:'cn',allowed_domains:['beijing.pbc.gov.cn','pbc.gov.cn'],enabled:true},
  {source_code:'hkma',jurisdiction:'HK',regulator:'HKMA',listing_url:'https://api.hkma.gov.hk/public/press-releases?lang=en',adapter_type:'hkma_press_release_api',language:'en',zone:'intl',allowed_domains:['api.hkma.gov.hk','hkma.gov.hk'],enabled:true},
  {source_code:'nfra',jurisdiction:'CN',regulator:'NFRA',enabled:false},
  {source_code:'csrc',jurisdiction:'CN',regulator:'CSRC',enabled:false},
  {source_code:'safe',jurisdiction:'CN',regulator:'SAFE',enabled:false},
  {source_code:'sfc',jurisdiction:'HK',regulator:'SFC',enabled:false},
  {source_code:'ia',jurisdiction:'HK',regulator:'IA',enabled:false},
  {source_code:'hkcustoms',jurisdiction:'HK',regulator:'C&ED',enabled:false},
];
return sources.filter(s=>s.enabled).map(s=>({json:{...s,url:s.listing_url,run_id:runId,request_id:'official:'+s.source_code+':'+$execution.id,started_at:new Date().toISOString(),workflow_execution_id:$execution.id}}));`);

http('Fetch Official Listing', [-1060, 180], {
  url: '={{ $json.listing_url }}',
  options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } } },
}, { onError: 'continueRegularOutput' });

code('Parse Official Response', [-840, 180], String.raw`
const source = $('Official Source Registry').item.json;
const response = $json || {};
const status = Number(response.statusCode || response.status || (response.error ? 599 : 200));
const raw = typeof response.body === 'string' ? response.body : (typeof response === 'string' ? response : JSON.stringify(response.body ?? response));
${n8nUrlHelpers}
const reasons = {}; const candidates = []; const seen = new Set(); let rawCount=0, parsed=0;
const reject = r => { reasons[r]=(reasons[r]||0)+1; };
const clean = v => String(v||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();
const relevant = v => /(行政处罚|处罚决定|罚款|纪律处分|enforcement|disciplin|penalt|fine|prosecut|convict|reprimand|revocation|suspension)/i.test(String(v||''));
const push=(urlValue,titleValue,dateValue)=>{ parsed++; const parsedUrl=parseWebUrl(urlValue,source.listing_url); const title=clean(titleValue); if(!parsedUrl){reject('invalid_url');return;} if(!hostAllowed(parsedUrl.host,source.allowed_domains)){reject('domain_mismatch');return;} if(!title||!relevant(title)){reject('irrelevant_title');return;} if(seen.has(parsedUrl.href)){reject('duplicate');return;} seen.add(parsedUrl.href); candidates.push({candidate_id:source.source_code+'|'+parsedUrl.href,source_code:source.source_code,jurisdiction:source.jurisdiction,regulator:source.regulator,official_url:parsedUrl.href,url:parsedUrl.href,discovery_method:'official',title,publication_date:dateValue||null,source_listing_url:source.listing_url,source_page:source.listing_url,discovered_at:new Date().toISOString(),verification_status:'unverified',language:source.language,zone:source.zone,allowed_domains:source.allowed_domains,run_id:source.run_id,request_id:source.request_id,workflow_execution_id:$execution.id,pipeline_version:'regintel-n8n-v3-p0'}); };
if(status < 400 && source.adapter_type==='hkma_press_release_api'){
  try { const body=typeof response.body==='string'?JSON.parse(response.body):response.body; const records=body?.result?.records||[]; rawCount=records.length; for(const r of records) push(r.link||r.url,r.title,r.date||null); } catch(e){reject('parse_failed');}
} else if(status < 400 && source.adapter_type==='pbc_beijing_html'){
  for(const row of raw.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){ const link=row[1].match(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i); if(!link)continue; rawCount++; const d=clean(row[1]).match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/); push(link[1],link[2],d?d[1]+'-'+d[2].padStart(2,'0')+'-'+d[3].padStart(2,'0'):null); }
}
const rejected=Object.values(reasons).reduce((a,b)=>a+b,0);
const fetchStatus=status>=400?'failed':(candidates.length?(rejected?'partial':'succeeded'):'empty');
return {json:{candidates,diagnostic:{source_code:source.source_code,jurisdiction:source.jurisdiction,request_id:source.request_id,run_id:source.run_id,discovery_method:'official',fetch_status:fetchStatus,http_status:status,raw_result_count:rawCount,parsed_count:parsed,accepted_count:candidates.length,rejected_count:rejected,rejection_reason_counts:reasons,error_message:status>=400?('http_'+status):null,started_at:source.started_at,finished_at:new Date().toISOString(),workflow_execution_id:$execution.id,metadata:{adapter_type:source.adapter_type}}}};`, 'runOnceForEachItem');

diagnosticHttp('Save Official Diagnostics', [-620, 40]);

code('Search Discovery Queries', [-1280, 600], String.raw`
const runId='regintel-'+$execution.id;
const specs=[
 {source_code:'pbc',regulator:'PBOC',jurisdiction:'CN',listing_url:'https://beijing.pbc.gov.cn/beijing/132030/132052/132059/index.html',zone:'cn',language:'zh-CN',allowed_domains:['pbc.gov.cn'],enabled:true,query:'site:pbc.gov.cn (行政处罚 OR 处罚决定) 反洗钱 最近7天'},
 {source_code:'hkma',regulator:'HKMA',jurisdiction:'HK',listing_url:'https://api.hkma.gov.hk/public/press-releases?lang=en',zone:'intl',language:'en',allowed_domains:['hkma.gov.hk'],enabled:true,query:'site:hkma.gov.hk (disciplinary action OR enforcement OR penalty) last 7 days'},
];
return specs.filter(s=>s.enabled).map(s=>({json:{...s,run_id:runId,request_id:'search:'+s.source_code+':'+$execution.id,started_at:new Date().toISOString(),workflow_execution_id:$execution.id}}));`);

http('AnySearch Independent Discovery', [-1060, 600], {
  method: 'POST', url: 'https://api.anysearch.com/v1/search', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({query:$json.query,max_results:10,zone:$json.zone,language:$json.language,format:'json'}) }}",
  options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
}, { onError: 'continueRegularOutput', credentials: { httpHeaderAuth: { id: 'ANYSEARCH_CREDENTIAL_ID', name: 'Anysearch' } } });

code('Parse Search Response', [-840, 600], String.raw`
const spec=$('Search Discovery Queries').item.json; const response=$json||{}; const status=Number(response.statusCode||response.status||(response.error?599:200));
const body=response.body??response; const records=body?.code===0&&Array.isArray(body?.data?.results)?body.data.results:[];
${n8nUrlHelpers}
const reasons={};const candidates=[];const seen=new Set();let parsed=0;const reject=r=>{reasons[r]=(reasons[r]||0)+1;};
const clean=v=>String(v||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); const relevant=v=>/(行政处罚|处罚决定|罚款|纪律处分|enforcement|disciplin|penalt|fine|prosecut|convict|reprimand|revocation|suspension)/i.test(String(v||''));
for(const r of records){parsed++;const parsedUrl=parseWebUrl(r.url||r.link||r.href||'',spec.listing_url);if(!parsedUrl){reject('invalid_url');continue;}if(!hostAllowed(parsedUrl.host,spec.allowed_domains)){reject('domain_mismatch');continue;}if(/^\/(?:en|eng|cn|zh|zh-cn|english)?\/?$/i.test(parsedUrl.pathname)){reject('homepage_only');continue;}const title=clean(r.title||r.name);if(!title||!relevant(title+' '+clean(r.snippet||r.content))){reject('irrelevant_title');continue;}if(seen.has(parsedUrl.href)){reject('duplicate');continue;}seen.add(parsedUrl.href);candidates.push({candidate_id:spec.source_code+'|'+parsedUrl.href,source_code:spec.source_code,jurisdiction:spec.jurisdiction,regulator:spec.regulator,official_url:parsedUrl.href,url:parsedUrl.href,discovery_method:'anysearch',title,publication_date:r.published_date||r.published_at||r.date||null,source_listing_url:spec.listing_url,source_page:spec.listing_url,discovered_at:new Date().toISOString(),verification_status:'unverified',language:spec.language,zone:spec.zone,allowed_domains:spec.allowed_domains,search_evidence:[{title,url:parsedUrl.href,snippet:clean(r.snippet||r.description||r.content).slice(0,900)}],run_id:spec.run_id,request_id:spec.request_id,workflow_execution_id:$execution.id,pipeline_version:'regintel-n8n-v3-p0'});}
const rejected=Object.values(reasons).reduce((a,b)=>a+b,0);const responseValid=status<400&&body?.code===0&&Array.isArray(body?.data?.results);const fetchStatus=!responseValid?'failed':(candidates.length?(rejected?'partial':'succeeded'):'empty');
return {json:{candidates,diagnostic:{source_code:spec.source_code,jurisdiction:spec.jurisdiction,request_id:spec.request_id,run_id:spec.run_id,discovery_method:'anysearch',fetch_status:fetchStatus,http_status:status,raw_result_count:records.length,parsed_count:parsed,accepted_count:candidates.length,rejected_count:rejected,rejection_reason_counts:reasons,error_message:responseValid?null:(body?.message||('http_'+status)),started_at:spec.started_at,finished_at:new Date().toISOString(),workflow_execution_id:$execution.id,metadata:{query:spec.query}}}};`, 'runOnceForEachItem');

diagnosticHttp('Save Search Diagnostics', [-620, 500]);

add({ name: 'Merge Discovery Candidates', type: 'n8n-nodes-base.merge', typeVersion: 3.2, position: [-380, 420], parameters: { mode: 'append' } });
code('Deduplicate Candidates', [-160, 420], String.raw`
${n8nUrlHelpers}
const seen=new Set();const candidates=[];let inputCount=0,invalidCount=0,duplicateCount=0;
for(const item of $input.all())for(const c of (Array.isArray(item.json?.candidates)?item.json.candidates:[])){
  inputCount++;if(!c.official_url||!c.title){invalidCount++;continue;}
  const parsedUrl=parseWebUrl(c.official_url,c.source_listing_url);if(!parsedUrl||!hostAllowed(parsedUrl.host,c.allowed_domains)){invalidCount++;continue;}
  const key=c.source_code+'|'+parsedUrl.href;if(seen.has(key)){duplicateCount++;continue;}seen.add(key);
  candidates.push({...c,candidate_id:key,official_url:parsedUrl.href,url:parsedUrl.href});
}
return [{json:{candidates,candidate_count:candidates.length,input_candidate_count:inputCount,duplicate_count:duplicateCount,invalid_count:invalidCount,workflow_execution_id:$execution.id}}];`);
add({ name: 'Has Discovery Candidates?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [60, 420], parameters: { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: id('discovery-has-candidates'), leftValue: '={{ $json.candidate_count > 0 }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] } } });
code('Expand Deduplicated Candidates', [280, 320], "const bundle=$input.first().json;return (bundle.candidates||[]).map(candidate=>({json:candidate}));", 'runOnceForAllItems');
code('No Candidates Summary', [280, 600], "const bundle=$input.first().json;return [{json:{stage:'discovery',status:'no_candidates',candidate_count:0,input_candidate_count:Number(bundle.input_candidate_count||0),duplicate_count:Number(bundle.duplicate_count||0),invalid_count:Number(bundle.invalid_count||0),paid_calls:0,workflow_execution_id:$execution.id,completed_at:new Date().toISOString()}}];");

http('Fetch Official Evidence', [500, 320], {
  url: '={{ $json.official_url }}', options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } } },
}, { onError: 'continueRegularOutput' });

code('Build Evidence Package', [720, 320], String.raw`
const candidate=$('Expand Deduplicated Candidates').item.json;const response=$json||{};const status=Number(response.statusCode||response.status||(response.error?599:200));const headers=response.headers||{};const contentType=String(headers['content-type']||headers['Content-Type']||'').toLowerCase();const raw=typeof response.body==='string'?response.body:'';const isPdf=contentType.includes('application/pdf')||/\.pdf(?:$|\?)/i.test(candidate.official_url);const text=isPdf?'':raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' ').replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim();const truncated=text.length>50000;const officialText=text.slice(0,50000);const ready=status<400&&!isPdf&&officialText.length>=100;return {json:{...candidate,official_text:officialText,official_fetch_status:status,official_content_type:contentType||null,document_type:isPdf?'pdf':'official_announcement',pdf_requires_extraction:isPdf,text_truncated:truncated,analysis_ready:ready,fetch_warning:ready?null:(isPdf?'pdf_requires_extraction':status>=400?'fetch_failed':'missing_document')}};`, 'runOnceForEachItem');

add({ name: 'Evidence Usable?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [940, 320], parameters: { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: id('evidence-ready-condition'), leftValue: '={{ $json.analysis_ready }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] } } });

code('Build Evidence Diagnostic', [1160, 620], String.raw`
return {json:{diagnostic:{source_code:$json.source_code,jurisdiction:$json.jurisdiction,request_id:'evidence:'+$json.candidate_id,run_id:$json.run_id,discovery_method:$json.discovery_method||'official',fetch_status:'failed',http_status:$json.official_fetch_status||null,raw_result_count:1,parsed_count:0,accepted_count:0,rejected_count:1,rejection_reason_counts:{[$json.fetch_warning||'missing_document']:1},error_message:$json.fetch_warning||'missing_document',started_at:$json.discovered_at,finished_at:new Date().toISOString(),workflow_execution_id:$execution.id,metadata:{official_url:$json.official_url,content_type:$json.official_content_type,pdf_requires_extraction:$json.pdf_requires_extraction===true}}}};`, 'runOnceForEachItem');
diagnosticHttp('Save Evidence Diagnostic', [1380, 620]);

http('Preflight Candidate', [1160, 320], {
  method: 'POST', url: "={{ ($env.REGINTEL_API_BASE_URL || 'https://hbfdelixtwkegxpmfyea.supabase.co/functions/v1/regintel-api') + '?action=preflight' }}",
  sendHeaders: true, headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-Ingest-Key', value: '={{ $env.REGINTEL_INGEST_KEY }}' }] },
  sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({items:[$json],dry_run:String($env.REGINTEL_DRY_RUN || 'true').toLowerCase()==='true'}) }}",
  options: { timeout: 30000, response: { response: { neverError: true, responseFormat: 'json' } } },
}, { onError: 'continueRegularOutput' });

code('Collect Preflight Results', [1380, 320], "const accepted=[],rejected=[],decisions=[];let dryRun=false;for(const item of $input.all()){const body=item.json.body||item.json;dryRun=dryRun||body.dry_run===true;accepted.push(...(body.accepted||[]));rejected.push(...(body.rejected||[]));decisions.push(...(body.decisions||[]));}return [{json:{accepted,rejected,decisions,dry_run:dryRun,accepted_count:accepted.length,rejected_count:rejected.length}}];");
add({ name: 'Preflight Has Accepted?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [1600, 320], parameters: { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: id('preflight-has-accepted'), leftValue: '={{ $json.accepted_count > 0 }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] } } });
code('Expand Preflight Accepted', [1820, 320], "const bundle=$input.first().json;return (bundle.accepted||[]).map(candidate=>({json:{...candidate,_dry_run:bundle.dry_run===true}}));", 'runOnceForAllItems');
code('No Paid Candidates Summary', [1820, 600], "const bundle=$input.first().json;return [{json:{stage:'preflight',status:'no_new_or_changed_candidates',candidate_count:0,rejected_count:Number(bundle.rejected_count||0),paid_calls:0,workflow_execution_id:$execution.id,completed_at:new Date().toISOString()}}];");
add({ name: 'Dry Run?', type: 'n8n-nodes-base.if', typeVersion: 2, position: [2040, 320], parameters: { conditions: { options: { caseSensitive: true, typeValidation: 'strict', version: 2 }, combinator: 'and', conditions: [{ id: id('dry-run-condition'), leftValue: '={{ $json._dry_run }}', rightValue: true, operator: { type: 'boolean', operation: 'true', singleValue: true } }] } } });
code('Dry Run Summary', [2260, 160], "return [{json:{stage:'preflight',status:'dry_run_complete',candidate_count:$input.all().length,paid_calls:0,workflow_execution_id:$execution.id,completed_at:new Date().toISOString()}}];");
code('Limit Paid Calls', [2260, 400], "return $input.all().slice(0,Math.max(1,Math.min(Number($env.REGINTEL_PAID_CALL_CAP||20),20)));");

http('AnySearch Corroboration', [2480, 400], {
  method: 'POST', url: 'https://api.anysearch.com/v1/search', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
  sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({query:($json.regulator+' '+$json.title+' enforcement penalty').slice(0,500),max_results:5,zone:$json.zone,language:$json.language,format:'json'}) }}",
  options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
}, { onError: 'continueRegularOutput', credentials: { httpHeaderAuth: { id: 'ANYSEARCH_CREDENTIAL_ID', name: 'Anysearch' } } });

code('Build AI Request', [2700, 400], String.raw`
const candidate=$('Limit Paid Calls').item.json;const response=$json||{};const body=response.body??response;const records=body?.code===0&&Array.isArray(body?.data?.results)?body.data.results:[];const evidence=records.slice(0,5).map(r=>({title:r.title||'',url:r.url||r.link||'',snippet:r.snippet||r.description||''}));
const shape={relevance:'enforcement|not_enforcement|uncertain',announcement_type:'enforcement|guidance|policy|consultation|unrelated',decisions:[{decision_number:null,decision_date:null,publication_date:null,case_type:'fine|warning|improvement_order|suspension|revocation|prohibition|prosecution|other',severity:'low|medium|high|critical',subjects:[{original_name:'',canonical_name:'',entity_type:'organization|person',sector:'',subject_role:'respondent',evidence_span:''}],violations:[{verbatim_wording:'',normalized_category:'AML_CFT|KYC_CDD|EDD|BENEFICIAL_OWNERSHIP|SANCTIONS_SCREENING|TRANSACTION_MONITORING|STR_SAR|RECORDKEEPING|GOVERNANCE|MARKET_CONDUCT|FX|PAYMENTS|OTHER',legal_citation:'',source_span:'',classification_basis:'confirmed_by_regulator|analyst_inference',confidence:0}],penalties:[{subject_name:'',penalty_type:'',currency:null,amount:null,original_amount_text:'',applies_to:'institution|person|mixed|unknown',combined_amount:false,amount_allocation_status:'not_applicable|explicit|unallocated_composite|needs_review',evidence_span:''}],control_findings:[{control_domain:'',observed_failure:'',possible_root_cause:'',classification:'confirmed_by_regulator|analyst_inference',evidence_span:'',confidence:0}],summary_en:'',summary_cn:'',confidence:0}],confidence:0,missing_fields:[],review_notes:''};
const instructions='Return JSON only. Official regulator text is primary evidence; search is corroboration only. Never invent facts, dates, entities, legal citations, amounts or currencies. If official text is missing, return relevance uncertain and decisions empty. Composite penalties must use unallocated_composite or needs_review unless the source explicitly apportions them. Inference must be labelled analyst_inference. Never return verified or published state. Non-enforcement material must return not_enforcement with decisions empty. Required shape: '+JSON.stringify(shape);
return {json:{...candidate,anysearch_evidence:evidence,usage:{search_calls:1,model_calls:1},ai_request:{model:'deepseek-chat',temperature:0,response_format:{type:'json_object'},messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify({source_code:candidate.source_code,jurisdiction:candidate.jurisdiction,regulator:candidate.regulator,official_url:candidate.official_url,title:candidate.title,publication_date:candidate.publication_date,official_text:candidate.official_text,text_truncated:candidate.text_truncated,corroboration:evidence})}]}}};`, 'runOnceForEachItem');

http('DeepSeek Structured Analysis', [2920, 400], {
  method: 'POST', url: 'https://api.deepseek.com/chat/completions', authentication: 'predefinedCredentialType', nodeCredentialType: 'deepSeekApi',
  sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.ai_request) }}',
  options: { timeout: 60000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
}, { onError: 'continueRegularOutput', credentials: { deepSeekApi: { id: 'DEEPSEEK_CREDENTIAL_ID', name: 'DeepSeek account' } } });

code('Validate Unverified Package', [3140, 400], String.raw`
const base=$('Build AI Request').item.json;const response=$json||{};const body=response.body??response;let analysis;const reasons=[];try{let text=body?.choices?.[0]?.message?.content??body?.output_text??'';if(typeof text==='string')text=text.replace(/^\x60\x60\x60json\s*|\x60\x60\x60$/g,'').trim();analysis=typeof text==='object'?text:JSON.parse(text);}catch(e){analysis={relevance:'uncertain',decisions:[],confidence:0,missing_fields:['ai_analysis'],review_notes:'Malformed or unavailable model JSON'};reasons.push('malformed_json');}
if(!['enforcement','not_enforcement','uncertain'].includes(analysis.relevance)){analysis.relevance='uncertain';reasons.push('invalid_relevance');}if(analysis.relevance==='not_enforcement')analysis.decisions=[];if(analysis.relevance==='enforcement'&&!Array.isArray(analysis.decisions)){analysis.decisions=[];reasons.push('missing_decisions');}
for(const d of (analysis.decisions||[])){if(!Array.isArray(d.subjects)||!d.subjects.length)reasons.push('missing_subjects');for(const p of (Array.isArray(d.penalties)?d.penalties:[])){if(p.combined_amount===true&&!['unallocated_composite','needs_review'].includes(p.amount_allocation_status)){p.amount_allocation_status='needs_review';reasons.push('unsafe_composite_penalty_allocation');}if(p.amount!==null&&p.amount!==undefined&&!Number.isFinite(Number(p.amount))){p.amount=null;reasons.push('invalid_penalty_amount');}}}
delete analysis.verification_status;delete analysis.review_status;delete analysis.published;analysis.confidence=Math.max(0,Math.min(1,Number(analysis.confidence||0)));if(reasons.length){analysis.missing_fields=[...new Set([...(analysis.missing_fields||[]),...reasons])];analysis.review_notes=[analysis.review_notes,'Schema validation: '+[...new Set(reasons)].join(', ')].filter(Boolean).join(' | ');}
const modelUsage=body?.usage||{};const usage={...base.usage,prompt_tokens:Number(modelUsage.prompt_tokens||0),completion_tokens:Number(modelUsage.completion_tokens||0),total_tokens:Number(modelUsage.total_tokens||0)};
return {json:{candidate_id:base.candidate_id,source_code:base.source_code,jurisdiction:base.jurisdiction,regulator:base.regulator,source_page:base.source_listing_url,official_url:base.official_url,url:base.official_url,title:base.title,publication_date:base.publication_date,discovered_at:base.discovered_at,language:base.language,official_text:base.official_text,content_hash:base.content_hash,document_type:base.document_type,verification_status:'unverified',pipeline_version:'regintel-n8n-v3-p0',workflow_execution_id:$execution.id,anysearch_evidence:base.anysearch_evidence,usage,validation_reasons:[...new Set(reasons)],ai_analysis:analysis}};`, 'runOnceForEachItem');

http('Queue Unverified Candidate', [3360, 400], {
  method: 'POST', url: "={{ ($env.REGINTEL_API_BASE_URL || 'https://hbfdelixtwkegxpmfyea.supabase.co/functions/v1/regintel-api') + '?action=candidates' }}",
  sendHeaders: true, headerParameters: { parameters: [{ name: 'Content-Type', value: 'application/json' }, { name: 'X-Ingest-Key', value: '={{ $env.REGINTEL_INGEST_KEY }}' }] },
  sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json) }}',
  options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
}, { onError: 'continueRegularOutput' });

code('Collect Ingest Metrics', [3580, 400], String.raw`
const base=$('Validate Unverified Package').item.json;const response=$json||{};const body=response.body??response;return {json:{ok:!body.error&&Number(response.statusCode||0)<400,response:body,usage:base.usage||{},candidate_id:base.candidate_id}};`, 'runOnceForEachItem');
code('Execution Summary', [3800, 400], String.raw`
const items=$input.all();let accepted=0,inserted=0,duplicates=0,rejected=0,errors=0,searchCalls=0,modelCalls=0,promptTokens=0,completionTokens=0,totalTokens=0;for(const item of items){const row=item.json||{};const r=row.response||{};if(!row.ok){errors++;}accepted+=Number(r.accepted||0);inserted+=Number(r.inserted||0);duplicates+=Number(r.duplicates||0);rejected+=(r.rejected||[]).length;searchCalls+=Number(row.usage?.search_calls||0);modelCalls+=Number(row.usage?.model_calls||0);promptTokens+=Number(row.usage?.prompt_tokens||0);completionTokens+=Number(row.usage?.completion_tokens||0);totalTokens+=Number(row.usage?.total_tokens||0);}return [{json:{stage:'completed',responses:items.length,accepted,inserted,duplicates,rejected,errors,usage:{search_calls:searchCalls,model_calls:modelCalls,prompt_tokens:promptTokens,completion_tokens:completionTokens,total_tokens:totalTokens},workflow_execution_id:$execution.id,completed_at:new Date().toISOString(),note:'Green nodes are not publication proof; cases remain unverified until review.'}}];`);

connect('Every 3 Hours', 'Official Source Registry');
connect('Every 3 Hours', 'Search Discovery Queries');
connect('Official Source Registry', 'Fetch Official Listing');
connect('Fetch Official Listing', 'Parse Official Response');
connect('Parse Official Response', 'Save Official Diagnostics');
connect('Parse Official Response', 'Merge Discovery Candidates', 0, 0);
connect('Search Discovery Queries', 'AnySearch Independent Discovery');
connect('AnySearch Independent Discovery', 'Parse Search Response');
connect('Parse Search Response', 'Save Search Diagnostics');
connect('Parse Search Response', 'Merge Discovery Candidates', 0, 1);
connect('Merge Discovery Candidates', 'Deduplicate Candidates');
connect('Deduplicate Candidates', 'Has Discovery Candidates?');
connect('Has Discovery Candidates?', 'Expand Deduplicated Candidates', 0);
connect('Has Discovery Candidates?', 'No Candidates Summary', 1);
connect('Expand Deduplicated Candidates', 'Fetch Official Evidence');
connect('Fetch Official Evidence', 'Build Evidence Package');
connect('Build Evidence Package', 'Evidence Usable?');
connect('Evidence Usable?', 'Preflight Candidate', 0);
connect('Evidence Usable?', 'Build Evidence Diagnostic', 1);
connect('Build Evidence Diagnostic', 'Save Evidence Diagnostic');
connect('Preflight Candidate', 'Collect Preflight Results');
connect('Collect Preflight Results', 'Preflight Has Accepted?');
connect('Preflight Has Accepted?', 'Expand Preflight Accepted', 0);
connect('Preflight Has Accepted?', 'No Paid Candidates Summary', 1);
connect('Expand Preflight Accepted', 'Dry Run?');
connect('Dry Run?', 'Dry Run Summary', 0);
connect('Dry Run?', 'Limit Paid Calls', 1);
connect('Limit Paid Calls', 'AnySearch Corroboration');
connect('AnySearch Corroboration', 'Build AI Request');
connect('Build AI Request', 'DeepSeek Structured Analysis');
connect('DeepSeek Structured Analysis', 'Validate Unverified Package');
connect('Validate Unverified Package', 'Queue Unverified Candidate');
connect('Queue Unverified Candidate', 'Collect Ingest Metrics');
connect('Collect Ingest Metrics', 'Execution Summary');

const workflow = {
  name: 'Innobridge - Regulatory Enforcement Intelligence CN HK v3 P0 Observable',
  nodes, connections, active: false, pinData: {}, tags: [],
  settings: { executionOrder: 'v1', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', saveManualExecutions: true },
  meta: { templateCredsSetupCompleted: false, reviewNotes: 'P0 dry-run defaults on. Bind Anysearch and DeepSeek account credentials, apply the additive migration and deploy regintel-api before testing. Only PBOC Beijing and HKMA are enabled.' },
};
fs.writeFileSync(output, JSON.stringify(workflow, null, 2) + '\n');
console.log(`Wrote ${output} (${nodes.length} nodes)`);
