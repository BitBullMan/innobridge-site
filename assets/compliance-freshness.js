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

  function loadEnforcement(options) {
    options = options || {};
    var limit = Math.max(1, Math.min(Number(options.limit) || 50, 100));
    var fields = 'id,entity_name,entity_name_cn,entity_type,action_type,enforcing_agency,enforcing_agency_cn,action_date,penalty_amount_usd,penalty_description,penalty_description_cn,violation_type,summary,summary_cn,source_url,source_name,status,severity,tags,created_at,aml_jurisdictions(code,name,name_cn)';
    var path = 'enforcement_actions?select=' + encodeURIComponent(fields)
      + '&action_date=gte.' + cutoffDate(LIVE_DAYS)
      + '&status=in.(ongoing,resolved,settled,appealed)'
      + '&order=action_date.desc.nullslast&limit=' + limit;
    return select(path).then(function (rows) {
      return rows.map(function (row) {
        var j = jurisdiction(row);
        row.jurisdiction_code = j.code || '';
        row.jurisdiction_name = j.name || '';
        row.jurisdiction_name_cn = j.name_cn || '';
        delete row.aml_jurisdictions;
        return row;
      });
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
    return select(path).then(function (rows) {
      return rows.map(function (row) {
        var j = jurisdiction(row);
        row.jurisdiction_code = j.code || '';
        row.jurisdiction_name = j.name || '';
        row.jurisdiction_name_cn = j.name_cn || '';
        delete row.aml_jurisdictions;
        return row;
      });
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
    if (record.verification_status === 'needs_review') return 'needs_review';
    var days = daysUntil(record.deadline_date);
    if (days === null) return 'needs_review';
    if (days <= 30) return 'critical';
    if (days <= 120) return 'upcoming';
    return 'planned';
  }

  function deadlineSort(a, b) {
    var aVerified = a.verification_status === 'verified' && daysUntil(a.deadline_date) >= 0;
    var bVerified = b.verification_status === 'verified' && daysUntil(b.deadline_date) >= 0;
    if (aVerified !== bVerified) return aVerified ? -1 : 1;
    if (!a.deadline_date && !b.deadline_date) return 0;
    if (!a.deadline_date) return 1;
    if (!b.deadline_date) return -1;
    return new Date(a.deadline_date) - new Date(b.deadline_date);
  }

  function loadDeadlines() {
    var fields = 'id,deadline_code,name_en,name_cn,jurisdiction_code,authority,applicable_entities,deadline_date,deadline_type,status,source_url,source_note_en,source_note_cn,verification_status,last_verified_at,created_at,updated_at';
    var path = 'ck_regulatory_deadlines?select=' + encodeURIComponent(fields) + '&order=deadline_date.asc.nullslast';
    return select(path).then(function (rows) {
      var current = [];
      var history = [];
      rows.forEach(function (row) {
        row.days_remaining = daysUntil(row.deadline_date);
        row.display_status = deadlineStatus(row);
        var verifiedFuture = row.verification_status === 'verified' && row.days_remaining !== null && row.days_remaining >= 0;
        if (verifiedFuture || row.verification_status === 'needs_review') current.push(row);
        else history.push(row);
      });
      current.sort(deadlineSort);
      history.sort(function (a, b) {
        return new Date(b.deadline_date || 0) - new Date(a.deadline_date || 0);
      });
      return { current: current, history: history };
    });
  }

  function nextVerifiedDeadline(items) {
    return (items || []).find(function (item) {
      return item.verification_status === 'verified'
        && item.days_remaining !== null
        && item.days_remaining >= 0;
    }) || null;
  }

  root.InnobridgeComplianceData = {
    liveDays: LIVE_DAYS,
    loadEnforcement: loadEnforcement,
    loadRegulatoryUpdates: loadRegulatoryUpdates,
    loadDeadlines: loadDeadlines,
    nextVerifiedDeadline: nextVerifiedDeadline,
    deadlineStatus: deadlineStatus,
    daysUntil: daysUntil
  };
})(window);
