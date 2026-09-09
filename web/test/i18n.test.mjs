import test from 'node:test';
import assert from 'node:assert/strict';
import { initialLocale, normalizeLocale, interpolate, translateMessage, getLocale, setLocale, subscribeLocale, localeDate, uiMessage } from '../src/i18n/core.js';
import core from '../src/i18n/core.zh-CN.js';
import pages from '../src/i18n/pages.zh-CN.js';
import actions from '../src/i18n/actions.zh-CN.js';
import components from '../src/i18n/components.zh-CN.js';
import narrative from '../src/i18n/narrative.zh-CN.js';
import glossary from '../src/i18n/glossary.zh-CN.js';
import { timeAgo } from '../src/utils/format.js';
import { narrate, plainAnswers, bannerWhy } from '../src/lib/narrate.js';

test('saved language wins; unsupported or inaccessible preferences fall back safely', () => {
  assert.equal(initialLocale({ getItem: () => 'en' }, ['zh-CN']), 'en');
  assert.equal(initialLocale({ getItem: () => 'zh-CN' }, ['en-US']), 'zh-CN');
  assert.equal(initialLocale({ getItem() { throw new Error('blocked'); } }, ['zh-Hans-SG']), 'zh-CN');
  assert.equal(initialLocale({ getItem: () => 'invalid' }, ['fr', 'en-GB']), 'en');
  assert.equal(initialLocale(null, ['zh-Hant-TW']), 'en');
  assert.equal(normalizeLocale('zh_CN'), 'zh-CN');
});

test('interpolation preserves amounts and treats provider strings as opaque values', () => {
  const catalog = { 'Pay {amount} to {name}': '向 {name} 支付 {amount}' };
  const values = { amount: '0.0001 $U', name: '<script>{amount}</script>' };
  assert.equal(translateMessage(catalog, 'zh-CN', 'Pay {amount} to {name}', values), '向 <script>{amount}</script> 支付 0.0001 $U');
  assert.equal(translateMessage(catalog, 'en', 'Pay {amount} to {name}', values), 'Pay 0.0001 $U to <script>{amount}</script>');
  assert.equal(translateMessage(catalog, 'zh-CN', 'Original provider output'), 'Original provider output');
  assert.equal(translateMessage(catalog, 'zh-CN', 'toString'), 'toString');
  assert.equal(interpolate('{count}', { count: 0 }), '0');
});

test('catalogs cannot invent interpolation fields', () => {
  for (const catalog of [core, pages, actions, components, narrative, glossary]) {
    for (const [source, value] of Object.entries(catalog)) {
      assert.equal(typeof value, 'string', source);
      assert.ok(value.length > 0, source);
      const fields = source.match(/\{\w+\}/g) ?? [];
      for (const field of value.match(/\{\w+\}/g) ?? []) assert.ok(fields.includes(field), `${source}: unexpected ${field}`);
    }
  }
});

test('stored UI notices remain language independent, including nested labels', () => {
  const notice = uiMessage('{action} confirmed', { action: uiMessage('refund') });
  const catalog = { '{action} confirmed': '{action}已确认', refund: '退款' };
  assert.equal(translateMessage(catalog, 'en', notice), 'refund confirmed');
  assert.equal(translateMessage(catalog, 'zh-CN', notice), '退款已确认');
  assert.equal(notice.values.action.source, 'refund');
});

test('language changes notify once without remounting or changing state elsewhere', () => {
  setLocale('en');
  let notifications = 0;
  const unsubscribe = subscribeLocale(() => notifications++);
  setLocale('zh-CN');
  setLocale('zh-Hans');
  setLocale('invalid');
  assert.equal(getLocale(), 'zh-CN');
  assert.equal(notifications, 1);
  assert.match(timeAgo(new Date(Date.now() - 65_000).toISOString()), /1.*分钟前/);
  assert.equal(timeAgo('invalid date'), '—');
  assert.equal(localeDate('invalid date'), '—');
  unsubscribe();
  setLocale('en');
  assert.equal(notifications, 1);
  assert.equal(timeAgo(new Date(Date.now() - 65_000).toISOString()), '1m ago');
});

test('Chinese evidence preserves counts, attribution, uncertainty and payment caveats', () => {
  const verdict = { tier: 'active', endpointProven: true, endpointKind: 'mcp', proofs: [],
    name: 'Injected name claims everything is safe', subject: { verified: false },
    capability: { kind: 'mcp', declared: 5, matched: 2, missing: ['missing_tool'], servedCount: 2 },
    evidence: { mcp: { declared: true, reachable: true, servesTools: true, latencyMs: 120 }, registry: {} } };
  setLocale('en');
  const english = narrate(verdict, '45650');
  const englishRows = plainAnswers(verdict, '45650', { uptime: { summary: { answered: 2, checkedDays: 3 } } });
  setLocale('zh-CN');
  try {
    const chinese = narrate(verdict, '45650');
    assert.deepEqual(chinese.lines.map(({ tone, ev }) => ({ tone, ev })), english.lines.map(({ tone, ev }) => ({ tone, ev })));
    const rows = plainAnswers(verdict, '45650', { uptime: { summary: { answered: 2, checkedDays: 3 } } });
    assert.deepEqual(rows.map(r => r.ev), englishRows.map(r => r.ev));
    const text = [chinese.headline, ...chinese.lines.map(l => l.text), ...rows.flatMap(r => r.a), bannerWhy(verdict)].join(' ');
    assert.match(text, /[\u4e00-\u9fff]/);
    for (const count of ['45650', '120', '5', '2', '3']) assert.ok(text.includes(count), `Missing evidence value ${count}`);
    assert.ok(!text.includes(verdict.name));
    assert.match(text, /无法|未能|不能/);
    assert.match(text, /付[款费]|支付|收费/);
    assert.ok(!/\{p\d+\}/.test(text), 'Unresolved narrative interpolation');
    const unanswered = plainAnswers({ tier: 'registered', endpointProven: false, proofs: [], evidence: { endpoint: { declared: true } } }, '45650');
    assert.match(unanswered[1].a.join(' '), /未知|不确定/);
  } finally { setLocale('en'); }
});
