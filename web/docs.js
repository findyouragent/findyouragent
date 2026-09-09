/**
 * The documentation site, rendered to static HTML at build time.
 *
 * Why this is not a route in the app: the app is a hash-routed SPA with no
 * prerender. Its initial HTML provides a short introduction and links here;
 * the complete documentation remains available to ordinary HTTP readers.
 * Every page here is real HTML at a
 * real URL, plus its own markdown source one extension away, and nothing on
 * the page needs JavaScript to be legible. The search box is the only scripted
 * thing on it, it is injected by script rather than rendered into the markup,
 * and its absence costs a reader nothing but a keystroke.
 *
 * One source of truth in three directions: NAV below decides the sidebar, the
 * page order, the prev/next links, the search index and the documentation
 * section of llms.txt. A page that is not in NAV does not ship, and a NAV entry
 * without a file fails the test rather than emitting a dead link.
 */

import { MARK_PATH } from './src/lib/mark.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';
import { evidenceMarkdown } from './evidence-markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(here, 'docs');
const THEME = path.join(here, 'docs-theme.css');
const TOKENS = path.join(here, 'src', 'styles', 'tokens.css');

export const SITE = 'https://findyouragent.xyz';

// When a build has no verification service, examples cannot print a URL that
// answers nothing — the same failure llms.txt is written to avoid. They print
// the local default instead and every API page says why.
export const LOCAL_API = 'http://localhost:8787';

export const NAV = [
  {
    section: 'Start here',
    pages: [
      { slug: 'about', title: 'About Find Your Agent', summary: 'Open marketplace scope, shared evaluation rules, compatibility limits, product strengths and supporting evidence.' },
      { slug: 'evidence', title: 'Recorded evidence', summary: 'Original dated task captures, provider attribution, reproduction steps and the limits of each observation.' },
      { slug: 'quickstart', title: 'Quickstart', summary: 'Three calls, no key: what has been checked, which agents serve what you need, and the evidence behind one verdict.' },
      { slug: 'concepts', title: 'Core concepts', summary: 'Tiers, deterministic written explanations, ERC-8004, x402 and ERC-8183 support, BAP-578 attribution and evidence scope.' },
      { slug: 'honesty', title: 'Honesty rules', summary: 'The four semantics this API will not bend: null is not zero, a 503 is a wait, a verdict is dated, a gap is our sampling.' },
      { slug: 'limits', title: 'Access and limits', summary: 'No key and no signup, what each endpoint costs, and which of them can be throttled.' },
    ],
  },
  {
    section: 'API reference',
    pages: [
      { slug: 'api', title: 'API overview', summary: 'Every endpoint in one table, the request conventions, and the error bodies.' },
      { slug: 'api/reads', title: 'Reads that cost nothing', summary: 'Coverage, browse, search, stored verdicts, history. Served from our own records, never throttled.' },
      { slug: 'api/checks', title: 'Calls that spend', summary: 'Verify, the streamed check, registry metadata, on-chain activity and the try relay.' },
      { slug: 'api/verdict', title: 'The verdict object', summary: 'Every field a verdict carries, what it is evidence of, and what it is not.' },
    ],
  },
  {
    section: 'For agents',
    pages: [
      { slug: 'mcp', title: 'MCP server', summary: 'Four read-only tools over streamable HTTP, unauthenticated, and why none of them reach the registry.' },
      { slug: 'machine', title: 'Machine-readable surfaces', summary: 'OpenAPI, the agent card, llms.txt, ai.txt and the markdown behind these pages.' },
    ],
  },
  {
    section: 'Guides',
    pages: [
      { slug: 'guides/pick-an-agent', title: 'Pick an agent that can do the job', summary: 'Search what endpoints actually served, then read the match as evidence instead of trusting it.' },
      { slug: 'guides/hire', title: 'Try one, then hire it', summary: 'Reviewed read requests, generic relay limits, x402 challenges and the ERC-8183 hire gate.' },
      { slug: 'guides/monitor', title: 'Watch an agent over time', summary: 'The uptime calendar, what a missing day means, and how to poll without spending anyone else’s budget.' },
      { slug: 'guides/publish', title: 'Publish an agent that passes', summary: 'What an agent has to do to earn verified live, written from the checks rather than from advice.' },
      { slug: 'guides/reuse', title: 'Reuse this data', summary: 'What is ours to license, what is not, and the two ways a copied verdict goes wrong.' },
    ],
  },
];

export const PAGES = NAV.flatMap((s) => s.pages.map((p) => ({ ...p, section: s.section })));

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function slugifyHeading(text) {
  return String(text).toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/&[a-z]+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Markdown to HTML, with two additions.
 *
 * Headings get stable ids and a self-link, so a section of the reference can be
 * cited rather than described — the whole point of writing a reference. And
 * every rendered heading is collected on the way past to build the on-this-page
 * list, so that list cannot disagree with the document it indexes.
 */
function renderMarkdown(source) {
  const headings = [];
  const used = new Set();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const plain = text.replace(/<[^>]*>/g, '');
        let id = slugifyHeading(plain) || `section-${headings.length + 1}`;
        while (used.has(id)) id = `${id}-x`;
        used.add(id);
        if (depth === 2 || depth === 3) headings.push({ id, depth, text: plain });
        // The title gets an id so it can be linked, but no visible anchor: it
        // would be a permanently hidden tab stop above the first paragraph.
        const anchor = depth === 1 ? '' : `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`;
        return `<h${depth} id="${id}">${text}${anchor}</h${depth}>\n`;
      },
    },
  });
  return { html: marked.parse(source), headings };
}

function tocHtml(headings) {
  if (headings.length < 2) return '';
  const items = headings
    .map((h) => `<li class="toc-${h.depth}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join('\n');
  return `<nav class="toc" aria-label="On this page">
  <p class="micro-label">On this page</p>
  <ul>
${items}
  </ul>
</nav>`;
}

function sidebarHtml(current) {
  const sections = NAV.map((section) => {
    const items = section.pages.map((p) => {
      const active = p.slug === current;
      return `      <li><a href="/docs/${p.slug}"${active ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`;
    }).join('\n');
    return `    <p class="micro-label">${escapeHtml(section.section)}</p>
    <ul>
${items}
    </ul>`;
  }).join('\n');
  return `<nav class="sidebar-nav" aria-label="Documentation">
    <div class="docsearch"></div>
    <p class="micro-label">Overview</p>
    <ul>
      <li><a href="/docs"${current === '' ? ' aria-current="page"' : ''}>Documentation home</a></li>
    </ul>
${sections}
  </nav>`;
}

function pagerHtml(index) {
  if (index < 0) return '';
  const prev = PAGES[index - 1];
  const next = PAGES[index + 1];
  if (!prev && !next) return '';
  const cell = (page, rel) => (page
    ? `<a class="pager-${rel}" href="/docs/${page.slug}"><span class="micro-label">${rel === 'prev' ? 'Previous' : 'Next'}</span><span>${escapeHtml(page.title)}</span></a>`
    : '<span></span>');
  return `<nav class="pager" aria-label="Page navigation">
  ${cell(prev, 'prev')}
  ${cell(next, 'next')}
</nav>`;
}

/**
 * The shell. Fonts and palette come from the same two places the app takes
 * them from, so the docs cannot drift into looking like a different product:
 * tokens.css is read off disk and inlined rather than copied.
 */
function shell({ title, summary, slug, bodyHtml, headings, index, css, api, configured }) {
  const canonical = slug ? `${SITE}/docs/${slug}` : `${SITE}/docs`;
  const mdHref = slug ? `/docs/${slug}.md` : '/docs/index.md';
  const banner = configured ? '' : `<div class="notice notice-warn">
  <p>This documentation was built without <code>VITE_VERIFY_API</code>, so the examples below address a
  service running locally at <code>${escapeHtml(LOCAL_API)}</code>. A deployed build prints the address it was
  actually built against, because a documented URL that answers nothing reads as an outage rather than
  as a missing variable.</p>
</div>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · findyouragent docs</title>
<meta name="description" content="${escapeHtml(summary)}" />
<link rel="canonical" href="${canonical}" />
<link rel="alternate" type="text/markdown" href="${mdHref}" />
<meta property="og:type" content="article" />
<meta property="og:title" content="${escapeHtml(title)} · findyouragent docs" />
<meta property="og:description" content="${escapeHtml(summary)}" />
<meta name="twitter:card" content="summary" />
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='22' fill='%23181a20'/%3E%3Cpath d='M33.8 25.1Q33.8 20 38.9 20L73.3 20Q80.3 20 80.3 27L80.3 56.6Q80.3 63.6 73.3 63.6L67.8 63.6Q60.8 63.6 60.8 56.6L60.8 46.4Q60.8 43.9 58.3 43.9L49.6 43.9Q47.1 43.9 45.36 42.11L35.54 31.99Q33.8 30.2 33.8 27.7Z' fill='%23eaecef'/%3E%3Cpath d='M33.8 25.1Q33.8 20 38.9 20L73.3 20Q80.3 20 80.3 27L80.3 56.6Q80.3 63.6 73.3 63.6L67.8 63.6Q60.8 63.6 60.8 56.6L60.8 46.4Q60.8 43.9 58.3 43.9L49.6 43.9Q47.1 43.9 45.36 42.11L35.54 31.99Q33.8 30.2 33.8 27.7Z' fill='%23f0b90b' transform='rotate(180 50 50)'/%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
${css}
</style>
</head>
<body>
<header class="docs-top">
  <a class="brand" href="${SITE}"><svg class="brand-mark" viewBox="0 0 100 100" width="18" height="18" aria-hidden="true" focusable="false"><path d="${MARK_PATH}" fill="var(--text-hi)"/><path d="${MARK_PATH}" fill="var(--brand)" transform="rotate(180 50 50)"/></svg><span class="brand-word">findyouragent</span></a>
  <span class="docs-tag">docs</span>
  <nav class="docs-top-links">
    <a href="/docs">Documentation</a>
    <a href="${api}/openapi.json">OpenAPI</a>
    <a href="/llms.txt">llms.txt</a>
    <a href="${SITE}">The site</a>
  </nav>
</header>
<div class="docs-shell">
  <aside class="sidebar">
    <details class="sidebar-mobile">
      <summary>Browse the documentation</summary>
      ${sidebarHtml(slug)}
    </details>
    <div class="sidebar-desktop">
      ${sidebarHtml(slug)}
    </div>
  </aside>
  <main class="docs-main">
    <article class="prose">
      ${['about', 'evidence'].includes(slug) ? '' : `<p class="eyebrow micro-label">${escapeHtml(PAGES[index]?.section ?? 'Documentation')}</p>`}
${banner}
${bodyHtml}
      <p class="page-source"><a href="${mdHref}">Read this page as markdown</a> — the same words without the styling, for whoever is reading rather than browsing.</p>
    </article>
${pagerHtml(index)}
  </main>
  <div class="toc-rail">
${tocHtml(headings)}
  </div>
</div>
<script>
${SEARCH_JS}
</script>
</body>
</html>
`;
}

/**
 * Search, as progressive enhancement.
 *
 * The input is created by this script rather than written into the markup, so a
 * reader without JavaScript is never shown a box that does nothing. The index is
 * a static file built from the same NAV and the same markdown, fetched on first
 * focus so it costs a reader who never searches nothing at all.
 */
const SEARCH_JS = `(function () {
  var mount = document.querySelectorAll('.docsearch');
  if (!mount.length) return;
  var index = null;
  var loading = null;
  function load() {
    if (loading) return loading;
    loading = fetch('/docs/search-index.json').then(function (r) { return r.json(); }).then(function (rows) {
      index = rows; return rows;
    }).catch(function () { index = []; return []; });
    return loading;
  }
  function score(row, terms) {
    var hay = (row.title + ' ' + row.summary + ' ' + row.text).toLowerCase();
    var title = row.title.toLowerCase();
    var total = 0;
    for (var i = 0; i < terms.length; i += 1) {
      var t = terms[i];
      if (hay.indexOf(t) === -1) return 0;
      total += title.indexOf(t) !== -1 ? 3 : 1;
    }
    return total;
  }
  // Every value below is our own build-time text, but it is written into the
  // page as markup, and "the data is ours" is exactly the assumption that stops
  // being true the first time this index is built from something else.
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  mount.forEach(function (node) {
    var box = document.createElement('div');
    box.className = 'search';
    var input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search the docs';
    input.setAttribute('aria-label', 'Search the documentation');
    var out = document.createElement('ul');
    out.className = 'search-results';
    out.hidden = true;
    box.appendChild(input);
    box.appendChild(out);
    node.appendChild(box);
    input.addEventListener('focus', load);
    input.addEventListener('input', function () {
      var q = input.value.trim().toLowerCase();
      if (q.length < 2) { out.hidden = true; out.innerHTML = ''; return; }
      load().then(function (rows) {
        var terms = q.split(/\\s+/);
        var hits = rows.map(function (row) { return { row: row, s: score(row, terms) }; })
          .filter(function (h) { return h.s > 0; })
          .sort(function (a, b) { return b.s - a.s; })
          .slice(0, 8);
        out.innerHTML = hits.length
          ? hits.map(function (h) {
            return '<li><a href="' + esc(h.row.path) + '">' + esc(h.row.title) + '</a><span>' + esc(h.row.section) + '</span></li>';
          }).join('')
          : '<li class="search-empty">Nothing here matches. The full text of every page is also at /llms-full.txt.</li>';
        out.hidden = false;
      });
    });
  });
})();`;

function readPage(slug) {
  const file = path.join(DOCS_DIR, `${slug || 'index'}.md`);
  return fs.readFileSync(file, 'utf8');
}

function applyVars(source, api) {
  return source.replace(/\{\{API\}\}/g, api).replace(/\{\{SITE\}\}/g, SITE);
}

/** Plain text for the search index: markdown with its syntax knocked off. */
function plainText(markdown) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`|\-]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
}

/**
 * Every file the docs site is made of, keyed by the path it is served at.
 *
 * Returned rather than written so the test can render the whole site in memory
 * and check that no page links at a page that does not exist. A dead link in a
 * reference is worse than a missing page: it reads as a promise.
 */
export function buildDocs(apiBase) {
  const configured = Boolean(apiBase);
  const api = String(apiBase || LOCAL_API).replace(/\/+$/, '');
  const css = `${fs.readFileSync(TOKENS, 'utf8')}\n${fs.readFileSync(THEME, 'utf8')}`;
  const files = {};
  const searchIndex = [];
  const fullText = [];
  const evidence = evidenceMarkdown();

  const all = [{ slug: '', title: 'findyouragent documentation', summary: 'Which ERC-8004 agents on BNB Chain actually answer, how that is decided, and how to read the evidence.', section: 'Documentation' }, ...PAGES];

  for (const page of all) {
    const raw = applyVars(readPage(page.slug), api).replace(/\{\{(EVIDENCE_[A-Z]+)\}\}/g, (_, key) => {
      if (!(key in evidence)) throw new Error(`Unknown evidence section: ${key}`);
      return evidence[key];
    });
    const { html, headings } = renderMarkdown(raw);
    const index = PAGES.findIndex((p) => p.slug === page.slug);
    files[`docs/${page.slug || 'index'}.html`] = shell({
      title: page.title,
      summary: page.summary,
      slug: page.slug,
      bodyHtml: html,
      headings,
      index,
      css,
      api,
      configured,
    });
    files[`docs/${page.slug || 'index'}.md`] = raw;
    searchIndex.push({
      path: `/docs/${page.slug}`,
      title: page.title,
      section: page.section,
      summary: page.summary,
      text: plainText(raw),
    });
    fullText.push(raw);
  }

  // Keep previously shared links usable on static hosts as well as in dev.
  // Only the new address enters navigation, search and the sitemap.
  files['docs/evaluate.html'] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>About Find Your Agent</title><link rel="canonical" href="${SITE}/docs/about"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0;url=/docs/about"></head><body><a href="/docs/about">About Find Your Agent</a><script>location.replace('/docs/about' + location.search + location.hash);</script></body></html>`;
  files['docs/evaluate.md'] = files['docs/about.md'];
  files['docs/search-index.json'] = JSON.stringify(searchIndex);
  files['llms-full.txt'] = [
    `# findyouragent documentation — every page, in one file`,
    '',
    `Generated from the same markdown the pages at ${SITE}/docs are rendered from.`,
    configured
      ? `The API it documents is at ${api}. No key, no signup, CORS open.`
      : 'This build has no verification service configured, so the examples address a local one.',
    '',
    fullText.join('\n\n---\n\n'),
    '',
  ].join('\n');

  return files;
}

/**
 * Directory-index form (`docs/quickstart/index.html`) rather than
 * `docs/quickstart.html`, because it is the one layout every static host serves
 * at the extensionless URL without a `cleanUrls` setting to remember.
 */
function outputName(route) {
  if (route.endsWith('.html')) {
    return route === 'docs/index.html' ? route : route.replace(/\.html$/, '/index.html');
  }
  return route;
}

export function docs(apiBase) {
  return {
    name: 'findyouragent-docs',
    apply() { return true; },
    configureServer(server) {
      // Rebuilt per request in dev so an edit to a markdown file shows up on
      // reload. A docs build only checked at deploy time is a docs build nobody
      // looks at until it is wrong in production.
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0].replace(/\/+$/, '') || '/';
        if (['/docs/evaluate', '/docs/evaluate.html', '/docs/evaluate/index.html', '/docs/evaluate.md'].includes(url)) {
          const search = new URL(req.url, 'http://localhost').search;
          res.statusCode = 308;
          res.setHeader('location', `/docs/about${url.endsWith('.md') ? '.md' : ''}${search}`);
          return res.end();
        }
        if (!url.startsWith('/docs') && url !== '/llms-full.txt') return next();
        let files;
        try {
          files = buildDocs(apiBase);
        } catch (err) {
          res.statusCode = 500;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          return res.end(`docs build failed: ${err.message}`);
        }
        const key = url === '/llms-full.txt'
          ? 'llms-full.txt'
          : url === '/docs'
            ? 'docs/index.html'
            : url.slice(1).match(/\.(md|json|html)$/) ? url.slice(1) : `${url.slice(1)}.html`;
        const body = files[key];
        if (body === undefined) return next();
        const type = key.endsWith('.md') ? 'text/markdown'
          : key.endsWith('.json') ? 'application/json'
            : key.endsWith('.html') ? 'text/html' : 'text/plain';
        res.setHeader('content-type', `${type}; charset=utf-8`);
        res.end(body);
      });
    },
    generateBundle() {
      const files = buildDocs(apiBase);
      for (const [route, source] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName: outputName(route), source });
      }
    },
  };
}
