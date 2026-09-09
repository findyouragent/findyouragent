import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonHtml } from '../src/lib/comparison-export.js';

const base = { exportedAt: '2026-09-08T12:34:56.000Z', locale: 'en', columns: [
  { key: '56:1', name: 'Alpha <x>', checkedAt: null, evidenceSource: 'saved', loadingParts: [], unavailableParts: [] },
  { key: '56:2', name: 'Beta "quoted"', checkedAt: '2026-09-01T01:02:03.000Z', evidenceSource: 'error', loadingParts: ['verdict'], unavailableParts: ['meta'] },
  { key: '56:3', name: 'Gamma', checkedAt: '2026-09-02T01:02:03.000Z', evidenceSource: 'loading', loadingParts: ['agent'], unavailableParts: [] },
], rows: [{ label: 'answered', values: [{ text: 'yes', title: 'a < b' }, { text: 'not checked' }] }] };

test('comparison HTML is readable, escaped, and preserves snapshot metadata', () => {
  const html = comparisonHtml(base);
  assert.match(html, /Find Your Agent comparison/);
  assert.match(html, /Alpha &lt;x&gt;/); assert.match(html, /Beta &quot;quoted&quot;/);
  assert.match(html, /title="a &lt; b"/); assert.match(html, /checked: not checked/);
  assert.match(html, /loading: verdict/); assert.match(html, /unavailable: meta/);
  assert.match(html, /source: error/); assert.match(html, /id="fya-comparison-data"/);
  assert.doesNotMatch(html, /<script[^>]*>[^]*<x>/);
});

test('embedded JSON is machine-readable and closes no script tag', () => {
  const html = comparisonHtml({ ...base, columns: base.columns.map((column, index) => index === 0 ? { ...column, name: '</script><img src=x onerror=1>' } : column), rows: [] });
  const json = html.match(/<script type="application\/json" id="fya-comparison-data">([\s\S]*)<\/script>/)[1];
  const data = JSON.parse(json);
  assert.equal(data.schemaVersion, 1); assert.equal(data.recordType, 'fya-agent-comparison');
  assert.equal(data.exportedAt, base.exportedAt); assert.equal(data.columns[0].checkedAt, null);
  assert.deepEqual(data.columns[1].loadingParts, ['verdict']); assert.deepEqual(data.columns[1].unavailableParts, ['meta']);
  assert.ok(json.includes('\\u003c/script\\u003e'));
});

test('locale is escaped and Chinese chrome is present', () => {
  const html = comparisonHtml({ ...base, locale: 'zh"><script>' });
  assert.match(html, /lang="zh&quot;&gt;&lt;script&gt;"/);
  const zh = comparisonHtml({ ...base, locale: 'zh-CN' });
  assert.match(zh, /Find Your Agent 对比/); assert.match(zh, /已保存的记录证据对比/);
});

test('one through three columns render without inventing values', () => {
  for (const count of [1, 2, 3]) {
    const columns = base.columns.slice(0, count); const html = comparisonHtml({ ...base, columns, rows: [{ label: 'status', values: columns.map(() => ({ text: 'unknown' })) }] });
    assert.equal((html.match(/scope="col"/g) || []).length, count + 1);
    assert.match(html, /unknown/);
  }
});
