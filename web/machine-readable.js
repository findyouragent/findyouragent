/**
 * The files this site serves to machines rather than to people.
 *
 * They are generated at build time for the same reason `VITE_VERIFY_API` is
 * compiled in: the API lives on a different host from the pages, and a static
 * `llms.txt` carrying a hardcoded URL is a file that goes quietly wrong on the
 * first deploy that moves the service. A build without the variable produces a
 * site with no browsing or verification backend, so the file says that instead of printing an
 * address that answers nothing.
 *
 * The interactive app uses hash routes, whose fragments never reach a server.
 * Static documentation and evidence offer a separate path for fetch-only readers.
 */

import { NAV, PAGES } from './docs.js';

const SITE = 'https://findyouragent.xyz';

/**
 * The documentation index, built from the same NAV that renders the sidebar.
 *
 * Written out page by page rather than as one link to /docs because the reader
 * of this file is not browsing: handing it a hub page it would have to fetch
 * and parse is the same mistake as pointing a crawler at the app. Every entry
 * addresses the MARKDOWN source, which is the form that costs nothing to read.
 */
function docsSection() {
  const lines = [
    '## Documentation',
    '',
    `Written for people at ${SITE}/docs, and served as markdown at the urls below.`,
    `The whole corpus in one fetch: [${SITE}/llms-full.txt](${SITE}/llms-full.txt).`,
    '',
  ];
  for (const section of NAV) {
    lines.push(`### ${section.section}`, '');
    for (const page of section.pages) {
      lines.push(`- [${page.title}](${SITE}/docs/${page.slug}.md): ${page.summary}`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function apiSection(api) {
  if (!api) {
    return [
      '## API',
      '',
      'This build has no verification service configured. Registry browsing, saved',
      'checks and task calls are unavailable; static documentation remains readable. A build',
      'with `VITE_VERIFY_API` set lists its endpoints in this section.',
    ].join('\n');
  }
  return [
    '## API — no key, no signup, CORS open',
    '',
    `- [OpenAPI description](${api}/openapi.json): every endpoint below, machine-readable, including the throttle semantics callers get wrong.`,
    `- [GET /api/summary](${api}/api/summary): headline counts and per-category coverage from current-formula stored verdicts. Agents with proven endpoints contain the verified-live subset; served and declared separately describe the basis of category placement.`,
    `- [GET /api/checked?limit=50](${api}/api/checked?limit=50): the agents we hold a current verdict for, best first. Served from our own records, so reading it costs the shared registry budget nothing.`,
    `- [GET /api/search?q=](${api}/api/search?q=lending): searches what endpoints ACTUALLY served when we asked them, not what registrations claim. Every hit names the matched tool, so you can check the match instead of trusting it.`,
    `- [GET /api/live](${api}/api/live): agents holding verified_live under the current formula at their latest stored check. Read its timestamp before relying on availability.`,
    `- POST /api/verdicts \`{"keys":["56:153649"]}\`: stored verdicts for up to 200 agents at once. Never triggers a check.`,
    `- GET /api/history/:chainId/:tokenId: the last checks plus the day calendar. A day with no square is a day we did not check — never the agent's downtime.`,
    `- GET /api/activity/:chainId/:tokenId: on-chain activity, but only for agents whose wallet is provably their own. Every response carries an \`attribution.gate\` so a missing wallet or an outage can never read as "no activity".`,
    '',
    '### Endpoints that spend someone else\'s resources (rate limited per IP)',
    '',
    `- [GET /api/registry/agents](${api}/api/registry/agents): paginated BSC registry inventory via the server-held registry key; /api/registry/search and /api/registry/stats support semantic search and inventory counts. Unavailability is not an empty result.`,
    `- GET /api/verify/:chainId/:tokenId: runs a full check, or serves the cached verdict. Add \`?stream=1\` for the probe narrated as Server-Sent Events as each call resolves.`,
    `- GET /api/try/:chainId/:tokenId/interface: discovers live MCP tools and \`taskPresets\` for supported reviewed tasks. A2A agents expose a message interface.`,
    `- POST /api/try/:chainId/:tokenId: invokes a reviewed \`presetId\`, an MCP tool passing the server's name-based read guard, or an A2A message. The guard cannot guarantee provider behavior; A2A messages are not restricted to reads. Read the envelope status and dated \`observation\`, not HTTP 200 alone.`,
    `- Reviewed task responses include the server-owned \`taskPreset\` input and \`observation.task\` checks. A captured reply or passed shape/scope checks do not establish independent correctness, profitability or paid delivery. See [result semantics](${SITE}/docs/api/checks#observations-and-downloadable-results).`,
  ].join('\n');
}

function interfaceSection(api) {
  if (!api) return null;
  return [
    '## Talking to this service as an agent',
    '',
    `- [Agent card](${api}/.well-known/agent-card.json): what this service is, what it serves, and the version of the formula behind every verdict.`,
    `- MCP endpoint: \`${api}/mcp\`. Streamable HTTP. Tools: \`search_agents\`, \`get_verdict\`, \`get_history\`, \`coverage\`. Read-only, no key.`,
    '',
    'FYA serves MCP and HTTP JSON. It probes MCP and A2A providers, but does not',
    'serve A2A message/send itself. The card declares only the interfaces served.',
  ].join('\n');
}

function llms(api) {
  return `# findyouragent

> Discover ERC-8004 agents indexed on BNB Chain, inspect dated endpoint checks,
> compare evidence and try a supported task. A verdict records a check, which may
> find no callable endpoint or receive no reply. Coverage is partial and reported.

The interactive pages at ${SITE} are a hash-routed JavaScript app. Static
documentation and evidence links can be read without running that app.

## Open marketplace scope

FYA is built to serve compatible agents across the BNB Chain ecosystem, including
independent providers and teams across the BNB Chain ecosystem. The same published,
versioned verdict formula applies across providers. Generic discovery, interface
checks and hiring use registered identity and supported metadata and interfaces,
rather than provider branding. Marketplace discovery covers BSC; A2A/MCP task
support, x402 payments and ERC-8183 hiring have specific compatibility limits.
Some reviewed task presets and token-attribution mappings are provider-specific.
See [marketplace scope](${SITE}/docs/about.md#an-open-marketplace-for-bnb-chain-agents)
and [supported flows](${SITE}/docs/concepts.md#bnb-agent-compatibility).

Background sweeps refresh dated endpoint and capability observations across all
four categories. As the BNB Chain agent ecosystem develops, newly compatible
providers and validated FYA integrations can expand coverage under the same
published evaluation rules. Endpoint observations and task results retain their
own timestamps and evidence.
See [category coverage over time](${SITE}/docs/about.md#category-coverage-as-the-ecosystem-develops).

## Evaluate the project

- [About Find Your Agent](${SITE}/docs/about): product scope, demonstration steps, source links and remaining evidence gaps.
- [Product strengths](${SITE}/docs/about.md#product-strengths): deterministic written explanations, BNB Agent SDK stack support (ERC-8004, x402 and ERC-8183), BAP-578 and rich profiles, familiar comparison, and reusable evidence. Implementation references and supported flows are in [Core concepts](${SITE}/docs/concepts.md#bnb-agent-compatibility).
- [Evidence guide](${SITE}/docs/evidence): what each published record establishes and how to reproduce it.
- [Evidence index](${SITE}/evidence/index.json): dated captures with provenance, scope and limitations. These are records of observations, not a live availability guarantee.

The original examples are developer-selected public reads from one HeyAnon-associated provider group. Additional records include a range assessment, preserved failures and a [paid Venus account assessment](${SITE}/docs/evidence#paid-venus-account-assessment) through BORT agent #11168: a 0.1 U quote, a returned answer and a matching on-chain settlement. BORT operates the agent and builds FYA. A separate historical RPC reconstruction reproduces all three displayed health figures at the payment block; the provider's exact observation block remains unknown. Each archive records its own checks and limits. These observations do not establish a verified deployment.

## Read this before interpreting FYA verdict signals

- **Unknown is \`null\`, never \`0\`.** For FYA verdict signals, \`true\` means checked and held,
  \`false\` means checked and failed, and \`null\` or absent means not checked.
  Raw provider and registry fields keep their source-defined meanings; this rule does not
  reinterpret their booleans, zero-valued metrics or missing fields.
- **Every verdict carries \`formulaVersion\`.** When the formula changes, older
  verdicts are withdrawn from the headline counts until they are rechecked, so
  counts never mix rules.
- **A throttle is a wait, not a verdict.** Registry calls share the deployment's
  key and service-tier allowance. When it is throttled you get \`503 registry-throttled\`
  with a \`Retry-After\`. That is never a claim that an agent is broken.
- **Verdicts are about an observation, not a character.** "This endpoint did not
  answer when we called it at 14:02" is what we hold. "This agent is dead" is not.
- **Capability agreement is a consistency check.** Registry declarations and the
  live tool list can both be controlled by the publisher. Their agreement does not
  independently validate task delivery or output quality.

${apiSection(api)}
${interfaceSection(api) ? `\n${interfaceSection(api)}\n` : ''}
${docsSection()}

## Terms

The verdicts, the probe records and the uptime calendar are ours and you may
reuse them with attribution to ${SITE}. The registry data underneath them is
public on-chain data and was never ours to license. See /ai.txt.

## Human pages

- [The index](${SITE}/): browse, search by what an agent serves, filter by category.
- [Methodology](${SITE}/#/methodology): the tiers, every signal, and what a probe does not prove.
- [Documentation](${SITE}/docs): the same material as the section above, rendered for reading.
`;
}

function ai(api) {
  return `# ai.txt — findyouragent

What this file is: a statement of what you may reuse from ${SITE}, written for
whoever is collecting rather than for a court. There is nothing adversarial here.
We publish verdicts about other people's agents; being copied is the point.

For the ecosystem-wide marketplace scope, shared verdict rules and compatibility
limits, read [About Find Your Agent](${SITE}/docs/about.md#an-open-marketplace-for-bnb-chain-agents).

## Yes, freely, with attribution to ${SITE}

- The verdicts, tiers and formula versions.
- The probe records: what we called, when, what came back, how long it took.
- The uptime calendar and the coverage counts.
- The methodology text.

These are our own observations and our own words. Attribution matters here for a
reason beyond credit: a verdict is only meaningful next to the time it was made
and the formula version that produced it. Copied without those, it becomes the
kind of context-free badge this site was built to argue against.

## Not ours to give you

Agent names, descriptions, images, cards and registry records belong to the
parties that published them on-chain. We republish them; we do not license them.
The same goes for anything an agent returned through the try relay: that is the
agent's output, not ours.

## Please do not

- Present a stored verdict as current. Every record carries the time it was made,
  and endpoints change. ${api ? `Recheck through the API` : 'Recheck against the service'} if freshness matters.
- Render an unknown as a zero or as a negative. \`null\` means we did not check.

## If you would rather ask than scrape

${api ? `Read /llms.txt, or call the API directly at ${api}. No key, no signup, CORS open.` : 'Read /llms.txt.'}
`;
}

/**
 * Named crawlers, current as of this writing.
 *
 * They are named for one reason: to state the permission explicitly, since a
 * crawler that matches a specific group ignores the `*` group entirely, and
 * several of these default to cautious behaviour when a site says nothing. The
 * access granted is identical to everyone else's — there is nothing here that
 * a person may read and a model may not.
 *
 * The legacy names are kept alongside the current ones. `Claude-Web` and
 * `anthropic-ai` were superseded by ClaudeBot / Claude-User / Claude-SearchBot,
 * and a robots.txt copied from another site is usually how a retired bot name
 * outlives the bot. Listing both costs nothing; listing only the old ones means
 * the agents that actually crawl fall through to `*`.
 */
const AI_CRAWLERS = [
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot',
  'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'Claude-Web',
  'Google-Extended', 'PerplexityBot', 'PerplexityBot-User',
  'CCBot', 'cohere-ai', 'Applebot-Extended', 'meta-externalagent', 'Bytespider',
];

const SOCIAL_CRAWLERS = ['Twitterbot', 'facebookexternalhit', 'LinkedInBot', 'Slackbot', 'Discordbot', 'TelegramBot'];

function robots(api) {
  const group = (agents, allow) => `${agents.map((a) => `User-agent: ${a}`).join('\n')}\n${allow}`;
  return `# findyouragent
# ${SITE}
#
# The interactive app at / is hash-routed: fragments after "#" never reach a
# server. Read /docs/about for the static product explanation and evidence.
#
# /docs is the exception. Those pages are static HTML, they are crawlable, and
# every one of them is also served as markdown at the same path with a .md
# extension. /llms.txt indexes the JSON API for a reader rather than a browser,
# and /llms-full.txt is the whole corpus in a single fetch.${api ? `\n# The API is open: no key, no signup, CORS open.` : ''}
#
# There is no Disallow list here, and that is not an oversight: this site has
# no admin, no dashboard, no accounts and nothing behind a login. A robots.txt
# is a public file, so a list of forbidden paths is a map of what a site has.
# We have nothing to draw.

User-agent: *
Allow: /

# Link unfurlers, so a shared page arrives with its title card.
${group(SOCIAL_CRAWLERS, 'Allow: /')}

# AI and LLM crawlers. Same access as anyone else, said out loud.
${group(AI_CRAWLERS, 'Allow: /')}

# Content signals — https://contentsignals.org/
# Consistent with /ai.txt, which is the longer version of this line: the
# verdicts and probe records are ours and free to reuse with attribution.
Content-Signal: search=yes, ai-input=yes, ai-train=yes

Sitemap: ${SITE}/sitemap.xml
`;
}

/**
 * Only the paths that actually exist as documents.
 *
 * Every hash route on the app collapses to a single URL here, because that is
 * genuinely all a fetcher can retrieve — listing `#/agent/56/43129` would be
 * listing a URL no crawler can distinguish from `/`. The docs pages are real
 * files, so they are the sitemap. Built from the same NAV that renders the
 * sidebar and llms.txt, so a page cannot exist in one and be missing from
 * another.
 *
 * No `lastmod`: we have no per-page modification date, and stamping every
 * entry with the build time would publish a freshness we did not measure.
 */
function sitemap() {
  const urls = ['/', '/docs', ...PAGES.map((p) => `/docs/${p.slug}`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${SITE}${u}</loc></url>`).join('\n')}
</urlset>
`;
}

/**
 * Serves the three files in dev as well as emitting them into the build, so
 * what ships can be read locally before it ships. A build-only asset is a file
 * nobody looks at until it is wrong in production.
 */
export function machineReadable(apiBase) {
  const api = String(apiBase ?? '').replace(/\/+$/, '');
  const files = {
    '/llms.txt': llms(api),
    '/ai.txt': ai(api),
    '/robots.txt': robots(api),
    '/sitemap.xml': sitemap(),
  };
  return {
    name: 'findyouragent-machine-readable',
    apply() { return true; },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const route = (req.url ?? '').split('?')[0];
        const body = files[route];
        if (!body) return next();
        // A sitemap served as text/plain is a sitemap no validator will read.
        res.setHeader('content-type', route.endsWith('.xml')
          ? 'application/xml; charset=utf-8'
          : 'text/plain; charset=utf-8');
        res.end(body);
      });
    },
    generateBundle() {
      for (const [route, source] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName: route.slice(1), source });
      }
    },
  };
}
