(function (root) {
  'use strict';

  var SUPABASE_URL = 'https://hbfdelixtwkegxpmfyea.supabase.co';
  var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiZmRlbGl4dHdrZWd4cG1meWVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NjYxOTEsImV4cCI6MjA5MzA0MjE5MX0.FGjhNl_YuBHRmgzxF5L-XPHxL1TaPu0cmEULJ2ymHB4';
  var LIVE_DAYS = 90;
  var UNIFIED_FETCH_LIMIT = 150;
  var UNIFIED_FIELDS = 'id,fingerprint,event_type,title_en,title_cn,summary_en,summary_cn,logic_en,logic_cn,jurisdiction,authority,category,severity,regulatory_type,source,source_name,source_url,event_date,published_at,status,first_seen_at,last_seen_at,seen_count,created_at,updated_at';

  function dateOnly(value) {
    var date = value ? new Date(value) : new Date();
    if (isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  }

  function cutoffDate(days) {
    var date = new Date();
    date.setUTCDate(date.getUTCDate() - days);
    return dateOnly(date);
  }

  function select(path) {
    return fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: {
        apikey: SUPABASE_ANON,
        Authorization: 'Bearer ' + SUPABASE_ANON
      }
    }).then(function (response) {
      if (!response.ok) throw new Error('Supabase REST ' + response.status);
      return response.json();
    });
  }

  function unifiedJurisdictionCode(value) {
    var raw = String(value || '').trim();
    var upper = raw.toUpperCase();
    var direct = {
      US: 'US', USA: 'US', EU: 'EU', GB: 'GB', UK: 'GB', HK: 'HK', SG: 'SG',
      KR: 'KR', JP: 'JP', CN: 'CN', AE: 'AE', UAE: 'AE', PK: 'PK', RU: 'RU', TH: 'TH'
    };
    if (direct[upper]) return direct[upper];
    if (/united states|america/i.test(raw)) return 'US';
    if (/european union|europe/i.test(raw)) return 'EU';
    if (/united kingdom|britain/i.test(raw)) return 'GB';
    if (/hong kong/i.test(raw)) return 'HK';
    if (/singapore/i.test(raw)) return 'SG';
    if (/south korea|korea/i.test(raw)) return 'KR';
    if (/japan/i.test(raw)) return 'JP';
    if (/china/i.test(raw)) return 'CN';
    if (/united arab emirates|dubai|abu dhabi/i.test(raw)) return 'AE';
    if (/pakistan/i.test(raw)) return 'PK';
    if (/russia/i.test(raw)) return 'RU';
    if (/thailand/i.test(raw)) return 'TH';
    return '';
  }

  function dedupeByFingerprint(rows) {
    var seen = {};
    return (rows || []).filter(function (row) {
      var key = String(row.fingerprint || row.id || '');
      if (!key || seen[key]) return false;
      seen[key] = true;
      return true;
    });
  }

  function loadUnifiedEvents(eventType, options) {
    options = options || {};
    var limit = Math.max(1, Math.min(Number(options.limit) || 100, UNIFIED_FETCH_LIMIT));
    var path = 'compliance_event_signals?select=' + encodeURIComponent(UNIFIED_FIELDS)
      + '&event_type=eq.' + encodeURIComponent(eventType)
      + '&status=eq.published'
      + '&event_date=gte.' + encodeURIComponent(cutoffDate(LIVE_DAYS))
      + '&order=event_date.desc.nullslast,published_at.desc.nullslast'
      + '&limit=' + UNIFIED_FETCH_LIMIT;
    return select(path).then(function (rows) {
      var deduped = dedupeByFingerprint(rows);
      var keyword = String(options.keyword || '').trim().toLowerCase();
      if (keyword) {
        deduped = deduped.filter(function (row) {
          return [row.title_en, row.title_cn, row.summary_en, row.summary_cn, row.logic_en, row.logic_cn,
            row.jurisdiction, row.authority, row.category, row.source_name]
            .filter(Boolean).join(' ').toLowerCase().indexOf(keyword) !== -1;
        });
      }
      return deduped.slice(0, limit);
    });
  }

  function sourceUrl(row) {
    if (/^https?:/i.test(String(row.source_url || ''))) return row.source_url;
    if (/^https?:/i.test(String(row.source || ''))) return row.source;
    return '';
  }

  function enforcementFromUnified(row) {
    return Object.assign({}, row, {
      entity_name: row.title_en,
      entity_name_cn: row.title_cn,
      entity_type: row.category || 'enforcement',
      action_type: row.category || 'enforcement',
      enforcing_agency: row.authority || row.source_name || '',
      enforcing_agency_cn: row.authority || row.source_name || '',
      action_date: row.event_date || row.published_at,
      summary: row.summary_en || '',
      summary_cn: row.summary_cn || '',
      logic: row.logic_en || '',
      logic_cn: row.logic_cn || '',
      source_url: sourceUrl(row),
      source_name: row.source_name || row.authority || '',
      jurisdiction_code: unifiedJurisdictionCode(row.jurisdiction),
      jurisdiction_name: row.jurisdiction || '',
      jurisdiction_name_cn: row.jurisdiction || '',
      data_source: 'compliance_event_signals'
    });
  }

  function regulatoryFromUnified(row) {
    return Object.assign({}, row, {
      title: row.title_en,
      title_cn: row.title_cn,
      update_type: row.regulatory_type || row.category || 'regulatory',
      summary: row.summary_en || '',
      summary_cn: row.summary_cn || '',
      logic: row.logic_en || '',
      logic_cn: row.logic_cn || '',
      source_url: sourceUrl(row),
      source_name: row.source_name || row.authority || '',
      published_date: row.event_date || row.published_at,
      jurisdiction_code: unifiedJurisdictionCode(row.jurisdiction),
      jurisdiction_name: row.jurisdiction || '',
      jurisdiction_name_cn: row.jurisdiction || '',
      data_source: 'compliance_event_signals'
    });
  }

  function jurisdiction(record) {
    return record.aml_jurisdictions || {};
  }

  function signalText(row) {
    return [row.title_en, row.title_cn, row.summary_en, row.summary_cn].filter(Boolean).join(' ').toLowerCase();
  }

  function signalJurisdiction(row) {
    var text = [row.region, row.title_en, row.title_cn].filter(Boolean).join(' ').toLowerCase();
    if (/(pakistan|巴基斯坦)/.test(text)) return 'PK';
    if (/(united states|u\.s\.|美国)/.test(text)) return 'US';
    if (/(european union|european commission|\beu\b|欧盟)/.test(text)) return 'EU';
    if (/(united kingdom|\buk\b|britain|英国)/.test(text)) return 'GB';
    if (/(hong kong|香港)/.test(text)) return 'HK';
    if (/(singapore|新加坡)/.test(text)) return 'SG';
    if (/(south korea|korea|韩国)/.test(text)) return 'KR';
    if (/(united arab emirates|\buae\b|阿联酋)/.test(text)) return 'AE';
    return '';
  }

  function signalSourceName(row) {
    var name = String(row.source_name || '');
    return name && !/^https?:/i.test(name) ? name : 'Published signal';
  }

  function isRelevantSignal(row, category) {
    var text = signalText(row);
    if (category === 'enforcement') {
      return /(charged?|prosecut|indict|arrest|fined?|penalt|settlement|sanction|seiz|frozen|freeze|banned?|cease|revoke|suspend|enforcement action|raid|crack down|crackdown|cftc resolves)/i.test(text)
        && !/(market cap|price surge|yield curve|stock|won to a|capital inflow|spark controversy|reigniting debate|demands inclusion|seeks direct enforcement authority|proposes? bill|plans? to amend|grant .* authority|gets? .* clearance|receives? .* approval|analyst:|may prompt)/i.test(text);
    }
    return /(regulat|rulemaking|rule\b|law\b|bill\b|act\b|framework|guidance|consultation|license|licence|registration|approval|authori[sz]ation|compliance|mica|genius|clarity|vasp|casp|stablecoin)/i.test(text)
      && !/(market cap|price surge|altseason|moving average|capital inflow|new account purchased|wallet (?:bought|sold)|whale (?:bought|sold))/i.test(text);
  }

  function loadSignals(category, limit) {
    var fields = 'id,title_en,title_cn,summary_en,summary_cn,logic_en,logic_cn,region,category,source,source_name,published_at,last_seen_at,seen_count,status';
    var path = 'compliance_news_signals?select=' + encodeURIComponent(fields)
      + '&category=eq.' + encodeURIComponent(category)
      + '&status=eq.published'
      + '&published_at=gte.' + encodeURIComponent(cutoffDate(LIVE_DAYS) + 'T00:00:00Z')
      + '&order=published_at.desc&limit=100';
    return select(path).then(function (rows) {
      return rows.filter(function (row) { return isRelevantSignal(row, category); }).slice(0, limit);
    });
  }

  function dedupeRows(rows, titleField) {
    var seen = {};
    var seenTopics = {};
    return rows.filter(function (row) {
      var rawValue = String(row[titleField] || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
      var value = rawValue.slice(0, 100);
      if (!value || seen[value]) return false;
      var topic = /\bdefi\b/.test(rawValue) && /\blending\b/.test(rawValue) && /\bmica\b/.test(rawValue) ? 'mica-defi-lending' : '';
      if (topic && seenTopics[topic]) return false;
      var timestamp = new Date(row.action_date || row.published_date || row.published_at || 0).getTime();
      var words = value.split(' ').filter(function (word) {
        return word.length > 3 && !/^(with|from|that|this|will|have|been|under|into|over|about|after|before|plans?)$/.test(word);
      });
      var duplicateAtSameTime = Object.keys(seen).some(function (key) {
        var prior = seen[key];
        var priorWords = prior.words;
        var overlap = words.filter(function (word) { return priorWords.indexOf(word) !== -1; }).length;
        if (!timestamp || !prior.timestamp) return false;
        var distance = Math.abs(timestamp - prior.timestamp);
        return (distance <= 120000 && overlap >= 3) || (distance <= 86400000 && overlap >= 5);
      });
      if (duplicateAtSameTime) return false;
      seen[value] = { timestamp: timestamp, words: words };
      if (topic) seenTopics[topic] = true;
      return true;
    });
  }

  function enforcementFromSignal(row) {
    return {
      id: row.id,
      entity_name: row.title_en,
      entity_name_cn: row.title_cn,
      entity_type: 'news_signal',
      action_type: 'news_signal',
      enforcing_agency: signalSourceName(row),
      enforcing_agency_cn: signalSourceName(row) === 'Published signal' ? '已发布信号' : signalSourceName(row),
      action_date: row.published_at,
      summary: row.summary_en || row.logic_en || '',
      summary_cn: row.summary_cn || row.logic_cn || '',
      source_url: /^https?:/i.test(row.source || '') ? row.source : '',
      source_name: signalSourceName(row),
      status: 'published',
      severity: 'medium',
      jurisdiction_code: signalJurisdiction(row),
      data_source: 'compliance_news_signals'
    };
  }

  function regulatoryFromSignal(row) {
    return {
      id: row.id,
      title: row.title_en,
      title_cn: row.title_cn,
      update_type: 'news_signal',
      summary: row.summary_en || row.logic_en || '',
      summary_cn: row.summary_cn || row.logic_cn || '',
      source_url: /^https?:/i.test(row.source || '') ? row.source : '',
      source_name: signalSourceName(row),
      published_date: row.published_at,
      severity: 'medium',
      status: 'published',
      jurisdiction_code: signalJurisdiction(row),
      data_source: 'compliance_news_signals'
    };
  }

  function loadEnforcement(options) {
    options = options || {};
    var limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
    return loadUnifiedEvents('enforcement', { limit: limit }).then(function (rows) {
      return rows.map(enforcementFromUnified);
    });
  }

  function loadRegulatoryUpdates(options) {
    options = options || {};
    var limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
    return loadUnifiedEvents('regulatory', { limit: limit }).then(function (rows) {
      return rows.map(regulatoryFromUnified);
    });
  }

  function loadComplianceNews(options) {
    return loadUnifiedEvents('compliance_news', options || {});
  }

  function daysUntil(value) {
    if (!value) return null;
    var target = new Date(value + 'T00:00:00Z');
    var today = new Date(dateOnly() + 'T00:00:00Z');
    if (isNaN(target.getTime())) return null;
    return Math.ceil((target.getTime() - today.getTime()) / 86400000);
  }

  function deadlineStatus(record) {
    var days = daysUntil(record.deadline_date);
    if (days === null) return 'monitoring';
    if (days <= 30) return 'critical';
    if (days <= 120) return 'upcoming';
    return 'planned';
  }

  function deadlineSort(a, b) {
    if (!a.deadline_date && !b.deadline_date) return 0;
    if (!a.deadline_date) return 1;
    if (!b.deadline_date) return -1;
    return new Date(a.deadline_date) - new Date(b.deadline_date);
  }

  function extractSignalDeadline(row) {
    var title = String(row.title_en || '');
    if (!/(deadline|must\s+.{0,40}(apply|register|comply)|(?:apply|register|comply)\s+.{0,40}\bby\b|takes effect|effective\s+(?:on|from))/i.test(title)) return null;
    var match = title.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
    if (!match) return null;
    var months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
    var published = new Date(row.published_at || Date.now());
    var year = Number(match[3]) || published.getUTCFullYear();
    var month = months[match[1].slice(0,3).toLowerCase()];
    var target = new Date(Date.UTC(year, month, Number(match[2])));
    if (target < published && !match[3]) target.setUTCFullYear(year + 1);
    var value = target.toISOString().slice(0, 10);
    if (daysUntil(value) < 0) return null;
    return {
      id: 'signal-' + row.id,
      deadline_code: 'signal-' + row.id,
      name_en: row.title_en,
      name_cn: row.title_cn || row.title_en,
      jurisdiction_code: signalJurisdiction(row),
      authority: signalSourceName(row),
      deadline_date: value,
      deadline_type: 'published_signal',
      status: 'published',
      source_url: /^https?:/i.test(row.source || '') ? row.source : '',
      verification_status: 'published_signal',
      published_at: row.published_at,
      data_source: 'compliance_news_signals'
    };
  }

  function loadDeadlineSignals() {
    return loadSignals('regulatory', 100).then(function (rows) {
      return rows.map(extractSignalDeadline).filter(Boolean);
    });
  }

  function loadDeadlines() {
    var fields = 'id,deadline_code,name_en,name_cn,jurisdiction_code,authority,applicable_entities,deadline_date,deadline_type,status,source_url,source_note_en,source_note_cn,verification_status,last_verified_at,created_at,updated_at';
    var path = 'ck_regulatory_deadlines?select=' + encodeURIComponent(fields) + '&order=deadline_date.asc.nullslast';
    return Promise.all([select(path), loadDeadlineSignals()]).then(function (results) {
      var rows = results[0];
      var signals = results[1];
      var current = [];
      var history = [];
      rows.forEach(function (row) {
        row.days_remaining = daysUntil(row.deadline_date);
        row.display_status = deadlineStatus(row);
        if (row.deadline_date && row.days_remaining < 0) history.push(row);
        else current.push(row);
      });
      signals.forEach(function (row) {
        row.days_remaining = daysUntil(row.deadline_date);
        row.display_status = deadlineStatus(row);
        current.push(row);
      });
      current = dedupeRows(current, 'name_en');
      current.sort(deadlineSort);
      history.sort(function (a, b) {
        return new Date(b.deadline_date || 0) - new Date(a.deadline_date || 0);
      });
      return { current: current, history: history };
    });
  }

  function nextPublicDeadline(items) {
    return (items || []).find(function (item) {
      return item.days_remaining !== null
        && item.days_remaining >= 0;
    }) || null;
  }

  root.InnobridgeComplianceData = {
    liveDays: LIVE_DAYS,
    loadEnforcement: loadEnforcement,
    loadRegulatoryUpdates: loadRegulatoryUpdates,
    loadComplianceNews: loadComplianceNews,
    loadDeadlines: loadDeadlines,
    nextPublicDeadline: nextPublicDeadline,
    nextVerifiedDeadline: nextPublicDeadline,
    deadlineStatus: deadlineStatus,
    daysUntil: daysUntil
  };
})(window);
