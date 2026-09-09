import { machineReadable } from '../machine-readable.js';
import { PAGES } from '../docs.js';

/**
 * The files this site serves to machines.
 *
 * The case that matters is a build made without `VITE_VERIFY_API`. That build
 * has no backend for registry browsing, saved checks or task calls, and
 * it is a mistake this project has made before. An llms.txt that prints
 * `undefined/api/summary` in that build hands a reader an address that answers
 * nothing and looks like a service outage rather than a missing variable — so
 * the missing case has to say what is missing.
 *
 *   node test/machine-readable.test.mjs
 */

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error(`  FAIL  ${message}`);
};

function emit(apiBase) {
  const files = {};
  const plugin = machineReadable(apiBase);
  plugin.generateBundle.call({
    emitFile: ({ fileName, source }) => { files[fileName] = source; },
  });
  return files;
}

console.log('a configured build');
{
  const files = emit('https://verify.example.com');
  ok(Object.keys(files).sort().join() === 'ai.txt,llms.txt,robots.txt,sitemap.xml', 'emits every machine file');
  ok(files['llms.txt'].includes('https://verify.example.com/api/summary'), 'llms.txt points at the service it was built against');
  ok(files['llms.txt'].includes('https://verify.example.com/mcp'), 'and names the MCP endpoint');
  ok(!/undefined|\[object/.test(files['llms.txt'] + files['ai.txt'] + files['robots.txt']), 'no file leaks an undefined into its text');
}

console.log('a trailing slash on the service URL');
{
  const files = emit('https://verify.example.com/');
  ok(!files['llms.txt'].includes('.com//'), 'is normalized rather than doubled into a broken path');
}

console.log('a build with no service configured');
{
  const files = emit('');
  ok(!/https?:\/\/\/|undefined/.test(files['llms.txt']), 'llms.txt prints no malformed or undefined URL');
  ok(/Registry browsing, saved\nchecks and task calls are unavailable/.test(files['llms.txt']), 'states the unavailable backend features when no service is configured');
  ok(!files['llms.txt'].includes('/api/summary'), 'no endpoint is advertised that this build cannot serve');
  ok(Object.keys(files).length === 4, 'the files are still emitted: a missing robots.txt reads as an oversight');
}

console.log('what the files say');
{
  const files = emit('https://verify.example.com');
  ok(/hash-routed/.test(files['llms.txt']) && /hash-routed/.test(files['robots.txt']),
    'both distinguish interactive hash routes from static reader surfaces');
  ok(files['llms.txt'].includes('https://findyouragent.xyz/docs/about')
    && files['llms.txt'].includes('https://findyouragent.xyz/evidence/index.json'),
    'a reader can reach the evaluator guide and dated evidence directly');
  ok(/may\n> find no callable endpoint or receive no reply/.test(files['llms.txt']),
    'verdicts include missing endpoints and failed observations');
  ok(/does not\nserve A2A message\/send/.test(files['llms.txt']),
    'does not claim an A2A interface the service does not implement');
  ok(!/shared anonymous/.test(files['llms.txt']) && /service-tier allowance/.test(files['llms.txt']),
    'registry quota comes from the deployment configuration, not a fixed anonymous tier');
  ok(/taskPresets/.test(files['llms.txt']) && /presetId/.test(files['llms.txt'])
    && /observation.task/.test(files['llms.txt']), 'machine readers can discover reviewed tasks and their observations');
  ok(/A2A messages are not restricted to reads/.test(files['llms.txt'])
    && /consistency check/.test(files['llms.txt']), 'states the provider-behavior and evidence limits');
  ok(files['robots.txt'].includes('Allow: /'), 'robots.txt permits crawling rather than pretending to hide');
  ok(/null/.test(files['llms.txt']), 'the null-is-not-zero rule reaches the machines reading this');
  ok(/attribution/.test(files['ai.txt']) && /not ours/i.test(files['ai.txt']),
    'ai.txt states both what may be reused and what was never ours to license');
}

console.log('robots.txt');
{
  const txt = emit('https://verify.example.com')['robots.txt'];
  ok(!/^Disallow:/m.test(txt),
    'no Disallow line: robots.txt is public, so a forbidden-path list is a map of what a site has, and this one has no admin, no dashboard and no login');
  ok(/User-agent: ClaudeBot/.test(txt) && /User-agent: GPTBot/.test(txt) && /User-agent: OAI-SearchBot/.test(txt),
    'the crawlers that actually run today are named');
  ok(/User-agent: Claude-Web/.test(txt) && /User-agent: anthropic-ai/.test(txt),
    'and the retired names are kept beside them: a crawler matching a specific group never falls through to *');
  ok(/Content-Signal: search=yes, ai-input=yes, ai-train=yes/.test(txt), 'the content signal is stated');
  ok(txt.includes('Sitemap: https://findyouragent.xyz/sitemap.xml'), 'the sitemap is announced');
  for (const line of txt.split('\n').filter((l) => l.trim() && !l.startsWith('#'))) {
    ok(/^(User-agent|Allow|Disallow|Sitemap|Content-Signal|Crawl-delay): \S/.test(line),
      `every directive is one robots.txt understands: ${line}`);
  }
}

console.log('robots.txt and ai.txt do not contradict each other');
{
  const files = emit('https://verify.example.com');
  const trains = /ai-train=(\w+)/.exec(files['robots.txt'])[1];
  const invites = /being copied is the point/.test(files['ai.txt']);
  ok(trains === 'yes' && invites,
    'the crawl signal says the same thing as the prose. On a site whose claim is that its statements check out, two files disagreeing is worse than either answer');
}

console.log('sitemap.xml');
{
  const xml = emit('https://verify.example.com')['sitemap.xml'];
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  ok(xml.startsWith('<?xml'), 'is an xml document');
  ok(locs.length === PAGES.length + 2,
    `lists the root, the docs index and every docs page (${locs.length} urls for ${PAGES.length} pages)`);
  const missing = PAGES.filter((p) => !locs.includes(`https://findyouragent.xyz/docs/${p.slug}`));
  ok(missing.length === 0,
    `every docs page is in the sitemap, because both are built from NAV and cannot drift (missing: ${missing.map((p) => p.slug).join(', ') || 'none'})`);
  ok(!locs.some((l) => l.includes('#')),
    'no hash route is listed: they all collapse to one document, and listing them would claim pages a fetcher cannot retrieve separately');
  ok(!/lastmod/.test(xml),
    'no lastmod: there is no per-page modification date to give, and stamping the build time on every entry publishes a freshness nobody measured');
  ok(new Set(locs).size === locs.length, 'no duplicate urls');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
