(function (root) {
  'use strict';

  var SUPABASE_URL = 'https://hbfdelixtwkegxpmfyea.supabase.co';
  var SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhiZmRlbGl4dHdrZWd4cG1meWVhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc0NjYxOTEsImV4cCI6MjA5MzA0MjE5MX0.FGjhNl_YuBHRmgzxF5L-XPHxL1TaPu0cmEULJ2ymHB4';
  var LIVE_DAYS = 45;

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
    var fields = 'id,entity_name,entity_name_cn,entity_type,action_type,enforcing_agency,enforcing_agency_cn,action_date,penalty_amount_usd,penalty_description,penalty_description_cn,violation_type,summary,summary_cn,source_url,source_name,status,severity,tags,created_at,aml_jurisdictions(code,name,name_cn)';
    var path = 'enforcement_actions?select=' + encodeURIComponent(fields)
      + '&action_date=gte.' + cutoffDate(LIVE_DAYS)
      + '&status=in.(ongoing,resolved,settled,appealed)'
      + '&order=action_date.desc.nullslast&limit=' + limit;
    return Promise.all([select(path), loadSignals('enforcement', limit)]).then(function (results) {
      var structured = results[0].map(function (row) {
        var j = jurisdiction(row);
        row.jurisdiction_code = j.code || '';
        row.jurisdiction_name = j.name || '';
        row.jurisdiction_name_cn = j.name_cn || '';
        row.data_source = 'enforcement_actions';
        delete row.aml_jurisdictions;
        return row;
      });
      var signals = results[1].map(enforcementFromSignal);
      return dedupeRows(structured.concat(signals), 'entity_name').sort(function (a, b) {
        return new Date(b.action_date || 0) - new Date(a.action_date || 0);
      }).slice(0, limit);
    });
  }

  function loadRegulatoryUpdates(options) {
    options = options || {};
    var limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
    var fields = 'id,title,title_cn,update_type,summary,summary_cn,source_url,source_name,published_date,severity,status,ai_confidence,tags,created_at,aml_jurisdictions(code,name,name_cn)';
    var path = 'aml_regulation_updates?select=' + encodeURIComponent(fields)
      + '&published_date=gte.' + cutoffDate(LIVE_DAYS)
      + '&status=in.(reviewed,published)'
      + '&order=published_date.desc.nullslast&limit=' + limit;
    return Promise.all([select(path), loadSignals('regulatory', limit)]).then(function (results) {
      var structured = results[0].map(function (row) {
        var j = jurisdiction(row);
        row.jurisdiction_code = j.code || '';
        row.jurisdiction_name = j.name || '';
        row.jurisdiction_name_cn = j.name_cn || '';
        row.data_source = 'aml_regulation_updates';
        delete row.aml_jurisdictions;
        return row;
      });
      var signals = results[1].map(regulatoryFromSignal);
      return dedupeRows(structured.concat(signals), 'title').sort(function (a, b) {
        return new Date(b.published_date || 0) - new Date(a.published_date || 0);
      }).slice(0, limit);
    });
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
    loadDeadlines: loadDeadlines,
    nextPublicDeadline: nextPublicDeadline,
    nextVerifiedDeadline: nextPublicDeadline,
    deadlineStatus: deadlineStatus,
    daysUntil: daysUntil
  };
})(window);
