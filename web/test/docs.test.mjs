import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDocs, NAV, PAGES, LOCAL_API } from '../docs.js';

/**
 * The documentation site.
 *
 * Two failures matter more than the rest, and neither is visible by looking at
 * a page. A link to a section that does not exist reads as a promise — worse in
 * a reference than a missing page, because the reader believes the answer is a
 * click away. And a build made without `VITE_VERIFY_API` must not print
 * `undefined/api/summary` at a reader, for the same reason llms.txt must not:
 * it looks like a service outage rather than a missing variable.
 *
 * The rest is bookkeeping that keeps NAV, the files on disk, and the headings
 * inside them from drifting apart.
 *
 *   node test/docs.test.mjs
 */

let pass = 0;
let fail = 0;
const ok = (condition, message) => {
  if (condition) { pass += 1; return; }
  fail += 1;
  console.error(`  FAIL  ${message}`);
};

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(here, '..', 'docs');

function markdownFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...markdownFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith('.md')) out.push(`${prefix}${entry.name.replace(/\.md$/, '')}`);
  }
  return out;
}

console.log('nav and the files on disk');
{
  const onDisk = new Set(markdownFiles(DOCS_DIR));
  const inNav = new Set(PAGES.map((p) => p.slug));

  for (const page of PAGES) {
    ok(onDisk.has(page.slug), `${page.slug} is in NAV and has a markdown file`);
  }
  for (const slug of onDisk) {
    if (slug === 'index') continue;
    ok(inNav.has(slug), `docs/${slug}.md is reachable from the sidebar`);
  }
  ok(onDisk.has('index'), 'the documentation home exists');

  // The H1 a reader sees and the title the sidebar prints are two copies of one
  // fact. They drift the first time a page is renamed in only one of them.
  for (const page of PAGES) {
    const first = fs.readFileSync(path.join(DOCS_DIR, `${page.slug}.md`), 'utf8').split('\n')[0];
    ok(first === `# ${page.title}`, `${page.slug} opens with the title the sidebar gives it (got "${first}")`);
  }

  const slugs = PAGES.map((p) => p.slug);
  ok(new Set(slugs).size === slugs.length, 'no slug is claimed twice');
}

console.log('a configured build');
const files = buildDocs('https://verify.example.com');
{
  for (const page of [...PAGES, { slug: '' }]) {
    const name = page.slug || 'index';
    ok(typeof files[`docs/${name}.html`] === 'string', `${name} renders to html`);
    ok(typeof files[`docs/${name}.md`] === 'string', `${name} is also served as markdown`);
  }
  ok(typeof files['docs/search-index.json'] === 'string', 'the search index is emitted');
  ok(typeof files['llms-full.txt'] === 'string', 'the whole corpus is emitted as one file');

  const all = Object.values(files).join('\n');
  ok(!/\{\{(?:API|SITE|EVIDENCE_[A-Z]+)\}\}/.test(all), 'no template placeholder survives into the output');
  ok(!/undefined|\[object Object\]/.test(all), 'nothing leaks an undefined into a page');
  ok(files['docs/quickstart.html'].includes('https://verify.example.com/api/summary'), 'examples address the service this build was made against');
  ok(!files['docs/api.html'].includes(LOCAL_API), 'a configured build never prints the local fallback');
  ok(!files['docs/api.html'].includes('was built without'), 'and shows no missing-service banner');

  // The sidebar is on every page, so a page missing from it is unreachable
  // even though its file exists.
  for (const page of PAGES) {
    ok(files['docs/index.html'].includes(`href="/docs/${page.slug}"`), `${page.slug} is linked from the documentation home's sidebar`);
  }

  const index = JSON.parse(files['docs/search-index.json']);
  ok(index.length === PAGES.length + 1, 'every page including the home is searchable');
  ok(index.every((row) => row.text.length > 0), 'no page indexes as empty text');

  for (const page of PAGES) {
    ok(files['llms-full.txt'].includes(`# ${page.title}`), `${page.slug} appears in llms-full.txt`);
  }
}

console.log('internal links resolve');
{
  const idsOf = (html) => new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const pageIds = new Map();
  for (const page of [...PAGES, { slug: '' }]) {
    pageIds.set(`/docs/${page.slug}`.replace(/\/$/, ''), idsOf(files[`docs/${page.slug || 'index'}.html`]));
  }

  let checked = 0;
  for (const page of [...PAGES, { slug: '' }]) {
    const source = files[`docs/${page.slug || 'index'}.md`];
    const from = page.slug || 'index';
    // Both markdown links and the raw <a href> used by the cards on the home page.
    const targets = [
      ...[...source.matchAll(/\]\((\/docs[^)\s]*)\)/g)].map((m) => m[1]),
      ...[...source.matchAll(/href="(\/docs[^"]*)"/g)].map((m) => m[1]),
    ];
    for (const target of targets) {
      checked += 1;
      const [route, anchor] = target.split('#');
      const key = route.replace(/\/$/, '');
      // A .md link addresses the markdown twin of a page rather than the page.
      const routeKey = key.endsWith('.md') ? key.replace(/\.md$/, '') : key;
      ok(pageIds.has(routeKey), `${from} links to ${route}, which exists`);
      if (anchor) {
        ok(pageIds.get(routeKey)?.has(anchor), `${from} links to ${route}#${anchor}, and that section exists`);
      }
    }
  }
  ok(checked > 20, `every internal link was checked (${checked} of them)`);
}

console.log('a build with no verification service');
{
  const bare = buildDocs('');
  const all = Object.values(bare).join('\n');
  ok(!/undefined/.test(all), 'never prints undefined where a service URL belongs');
  ok(bare['docs/api.html'].includes('was built without'), 'says on an API page that no service was configured');
  ok(bare['docs/api.html'].includes(LOCAL_API), 'and addresses the local default instead of nothing');
  ok(bare['llms-full.txt'].includes('no verification service configured'), 'llms-full.txt says the same');
}

console.log('every page is legible without javascript');
{
  for (const page of PAGES) {
    const html = files[`docs/${page.slug}.html`];
    const body = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    ok(body.length > 800, `${page.slug} ships its prose in the markup, not from a fetch`);
    ok(html.includes(`<link rel="alternate" type="text/markdown" href="/docs/${page.slug}.md" />`), `${page.slug} points at its own markdown source`);
  }
  // The search box is created by script. Written into the markup it would show
  // as a dead input to a reader with no javascript.
  ok(!files['docs/index.html'].includes('<input type="search"'), 'the search input is not in the static markup');
}

console.log('evaluator pages preserve evidence and discovery without javascript');
{
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '../public/evidence/index.json'), 'utf8'));
  const markdown = files['docs/evidence.md'];
  for (const record of manifest.records) {
    ok(markdown.includes(record.observation.checkedAt), `${record.id} includes its exact observation time`);
    ok(markdown.includes(record.rawCapture.href), `${record.id} links its original download`);
    ok(markdown.includes(record.rawCapture.sha256), `${record.id} exposes its integrity digest`);
    ok(files['docs/evidence.html'].includes(`id="${record.id}"`), `${record.id} has a stable citation target`);
  }
  for (const target of [...markdown.matchAll(/\]\((\/evidence\/[^)]+)\)/g)].map((match) => match[1])) {
    ok(fs.existsSync(path.join(here, '../public', target)), `${target} is a published asset`);
  }
  ok(markdown.includes(`${manifest.reliability.counts.failed} failed`), 'the recorded failed release check remains visible');
  const home = fs.readFileSync(path.join(here, '../index.html'), 'utf8');
  const initialBody = home.slice(home.indexOf('<body>')).replace(/<script[\s\S]*?<\/script>/g, '');
  ok(initialBody.includes('Find Your Agent') && initialBody.includes('href="/docs/about"'), 'an ordinary homepage fetch has a purpose and evaluator link');
  ok(initialBody.includes('href="/docs/evidence"'), 'the homepage exposes evidence before scripts execute');
  ok(markdown.includes('beneficial control') || markdown.includes('beneficial ownership'), 'public operator attribution keeps its independence limit');
  ok(!markdown.includes('{{EVIDENCE_'), 'all evidence sections are expanded into static Markdown');
  ok(files['docs/about.md'].includes('/docs/evidence#paid-venus-account-assessment'), 'the paid assessment keeps a stable public evidence link');
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
