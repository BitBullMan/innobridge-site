const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'compliance.html'), 'utf8');
const ui = fs.readFileSync(path.join(root, 'assets/compliance-case-library.js'), 'utf8');
const match = html.match(/<script type="application\/json" id="cl-data">([\s\S]*?)<\/script>/);

test('case library contains the validated 100-case collection', () => {
  assert.ok(match, 'embedded case data is missing');
  const rows = JSON.parse(match[1]);
  assert.equal(rows.length, 100);
  assert.equal(new Set(rows.map((row) => row.case_id)).size, 100);
  assert.deepEqual(
    rows.reduce((counts, row) => {
      counts[row.jurisdiction] = (counts[row.jurisdiction] || 0) + 1;
      return counts;
    }, {}),
    { US: 44, UK: 25, HK: 18, SG: 13 },
  );
  assert.equal(
    rows.reduce((count, row) => count + JSON.parse(row.lesson_cards_json).length, 0),
    400,
  );
  for (const row of rows) {
    assert.ok(row.case_id && row.title && row.authority && row.date);
    assert.ok(row.source_urls.split('|').every((url) => /^https?:\/\//.test(url)));
  }
});

test('case library totals and missing monetary outcomes are data-driven', () => {
  assert.match(ui, /const totalCases=rows\.length/);
  assert.match(ui, /全库 \$\{totalCases\}/);
  assert.match(ui, /金额未披露 \/ 非金钱结果/);
  assert.doesNotMatch(ui, /全库 50/);
  assert.match(html, /Explore 100 cases across four jurisdictions/);
  assert.match(html, /100 个独立案例 · 4 个辖区 · 400 张学习卡/);
  assert.match(html, /compliance-case-library\.js\?v=20261105/);
});
