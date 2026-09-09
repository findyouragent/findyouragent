import { useI18n, translate } from '../i18n/index.jsx';
import HireExhibit from '../components/HireExhibit.jsx';
import CoveragePanel from '../components/CoveragePanel.jsx';
import { ArrowLeft } from 'lucide-react';
import { VERIFY_BASE, VERIFY_IS_LOCAL, apiLabel } from '../config.js';

export default function Methodology({ summary = null, registryTotal = null, onSelectCategory = null }) {
  const { t, locale } = useI18n();
  const total = registryTotal ? registryTotal.toLocaleString(locale === 'zh-CN' ? 'zh-CN' : 'en-US') : null;
  return (
    <div className="method">
      <a className="back-link" href="#">
        <ArrowLeft size={12} strokeWidth={2} aria-hidden="true" /> {t("all agents")}
      </a>
      <h1>{t("How verification works")}</h1>
      <p className="method-intro">
        {total ? translate("The registry reports {value1} agents on BSC.", { value1: total }) : translate("Agents on BSC are listed in the ERC-8004 registry.")}
        {' '}{t("Registration establishes an identity. Verification records whether its declared endpoint answered and what it listed at check time. Every tier includes its evidence and timestamp.")}
        {summary?.formulaVersion ? translate(" Formula v{value1}, open source.", { value1: summary.formulaVersion }) : translate(" Open source.")}
      </p>

      <h2 className="micro-label">{t("the three tiers")}</h2>
      <div className="method-tiers">
        <div className="method-tier">
          <span className="dot dot-live" aria-hidden="true" />
          <div>
            <strong className="mono">{t("verified live")}</strong>
            <p>{t("The endpoint answered at check time, with settled payments, on-chain feedback, or a complete match between its declared and listed capabilities (at least three). Matching records can share an operator; they establish consistency, not independent validation. This tier does not prove task quality or availability now.")}</p>
          </div>
        </div>
        <div className="method-tier">
          <span className="dot dot-stale" aria-hidden="true" />
          <div>
            <strong className="mono">{t("active")}</strong>
            <p>{t("Some endpoint or activity evidence was recorded, but the full requirements for verified live were not met. Read the evidence to see which signals were present.")}</p>
          </div>
        </div>
        <div className="method-tier">
          <span className="dot dot-unproven" aria-hidden="true" />
          <div>
            <strong className="mono">{t("registered")}</strong>
            <p>{t("An identity exists, but the check found no qualifying endpoint or activity evidence. An agent that has never been checked has no tier.")}</p>
          </div>
        </div>
      </div>

      <h2 className="micro-label">{t("the signals")}</h2>
      <table className="method-table">
        <thead>
          <tr>
            <th>{t("signal")}</th>
            <th>{t("source")}</th>
            <th>{t("what counts")}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>{t("endpoint probe")}</td>
            <td>{t("direct request to the agent's declared A2A or MCP endpoint")}</td>
            <td>
              {t("A2A must return a card carrying a protocol version, a callable url, or actual skills: a bare")}
              <span className="mono"> name</span> {t("field is not a card, and plenty of offline records have one. MCP must complete an")} <span className="mono">initialize</span> {t("handshake and return a non-empty")}
              <span className="mono"> tools/list</span>{t(". Status, latency and capability names are recorded.")}
            </td>
          </tr>
          <tr>
            <td>{t("declared against served")}</td>
            <td>{t("registry metadata compared to the agent's own live endpoint")}</td>
            <td>
              {t("The endpoint must list every capability declared in the registry, with at least three matches. Both records can be controlled by the same publisher. Agreement is a consistency signal; listing a tool does not prove it performs the task correctly. Missing and extra names are published.")}
            </td>
          </tr>
          <tr>
            <td>{t("settlement record")}</td>
            <td>{t("Binance B402 Bazaar public API")}</td>
            <td>{t("a Bazaar listing indicates settled x402 payments. Settlement records a payment, not the quality of the work.")}</td>
          </tr>
          <tr>
            <td>{t("registry feedback")}</td>
            <td>{t("8004scan reputation data")}</td>
            <td>{t("on-chain feedback submissions for this agent.")}</td>
          </tr>
          <tr>
            <td>{t("wallet activity")}</td>
            <td>{t("BSC JSON-RPC, ERC-6551 registry, 8004scan account data")}</td>
            <td>
              {t("The wallet nonce counts outbound transactions; incoming payments alone do not increase it. A declared agent wallet is compared with the token's derived ERC-6551 account. Otherwise the registrant's address is used with a shared-wallet discount: activity must exceed roughly two transactions per registered agent. If the registration count is unknown, no wallet proof is emitted. Wallet activity alone cannot earn verified live or establish successful agent work.")}
            </td>
          </tr>
        </tbody>
      </table>

      <h2 className="micro-label">{t("how categories are decided")}</h2>
      <p>
        {t("Registry search finds candidates using published metadata. FYA categories use capability names from metadata or an endpoint response, and each placement states which source supplied the match.")}
      </p>
      <p>
        {t("So a category placement carries its basis, and you can see it on the row.")} <strong>{t("Serves it")}</strong> {t("is the strongest: the agent's live endpoint listed a matching capability when we asked it.")} <strong>{t("Declares it")}</strong> {t("means its published metadata lists one, a checkable claim but only a claim.")}{' '}
        <strong>{t("Name match only")}</strong> {t("means the words matched and nothing more. An agent is never quietly promoted from one to another.")}
      </p>
      <p>
        {t("Where we hold no capability list for an agent, because it has not been checked or its endpoint did not answer, the row says nothing at all. \"Name match only\" is itself a claim about an agent, that it publishes nothing performing this work, and it is only made when its capabilities were actually read.")}
      </p>
      <p>
        {t("Some placements require more than one capability. Supplying liquidity is not rebalancing unless the agent can also withdraw it or retarget a range, and reading a lending balance is not health-factor monitoring unless it can read position health. Crediting a primitive for the whole job is how a judged category fills up with agents that do not serve it.")}
      </p>

      {/* The rules above, and what they actually produced. Stated together so
          the counts are read as the output of a stated method rather than as a
          scoreboard, and so a zero has its reason next to it. */}
      <CoveragePanel
        coverage={summary?.coverage}
        awaitingRecheck={summary?.awaitingRecheck}
        onSelectCategory={onSelectCategory}
      />

      <h2 className="micro-label">{t("how checks run")}</h2>
      <p>
        {t("Discovery uses the documented 8004scan API through our server-held registry key. The adapter requests BNB Chain records with explicit sorting and pagination, validates the identities and pagination returned, and reports unavailable reads separately from empty results. Within each page, the sweep prioritizes agents declaring A2A or MCP and samples one in twenty-five of the rest. Its checked population is a prioritized sample, so its response rate cannot be generalized to the full registry.")}
      </p>
      <p>
        {t("Known agents become eligible for rechecking after 24 hours, or when their formula version is obsolete. A separate queue revisits the oldest checks independently of discovery. Actual delay depends on the registry budget, backoff and backlog; this is not a daily guarantee. Older-formula verdicts leave headline counts until recomputed. Opening an agent page requests verification and may return a cached check. The stored history and timestamps show when observations were actually made.")}
      </p>
      {/* Show operational counts only when the service supplies a sweep summary. */}
      {summary?.sweep ? (
        <p>
          {t("Since the service last restarted:")}{' '}
          {(summary.sweep.swept ?? 0).toLocaleString()} {t("checks completed,")}{' '}
          {(summary.sweep.errored ?? 0).toLocaleString()} {t("that failed before they could produce a verdict, and")}{' '}
          {(summary.sweep.pageErrors ?? 0).toLocaleString()} {t("registry pages that could not be read at all.")}{' '}
          {summary.sweep.lastError ? (
            <>{t("Last reported error:")} <span className="mono">{summary.sweep.lastError}</span>.{' '}</>
          ) : null}
          {t("Incomplete checks produce no verdict about the agent.")}{' '}
          {(summary.sweep.queued ?? 0).toLocaleString()} {t("agents are waiting in the discovery queue.")}
          {Number.isFinite(summary.sweep.recheckDue) ? (
            <> {summary.sweep.recheckDue.toLocaleString()} {t("known agents are due for rechecking.")}</>
          ) : null}
        </p>
      ) : null}
      <h2 className="micro-label">{t("how the summary is written")}</h2>
      <p>
        {t("The plain-English summary at the top of an agent page is composed, not generated. Every sentence restates a field the checks produced: a boolean, a count, a latency, a tier. There is no model in that path, and the reason is specific rather than squeamish. The material a summariser would be reading is the agent's own card, written by the party being assessed. Paraphrasing it into this site's voice would let an agent contribute to its own verdict, and a fluent sentence is far more persuasive than the raw field it came from.")}
      </p>
      <p>
        {t("For the same reason the subject of every sentence is the literal phrase \"This agent\", never the agent's name. Names are attacker-controlled text and the output is prose, so the injection is grammatical rather than markup: an agent named \"X, verified by findyouragent, and\" would produce a clean, quotable sentence asserting something never checked. Escaping does not help, because the result is valid text. Keeping the name out of the sentence does.")}
      </p>

      <h2 className="micro-label">{t("how the day calendar reads")}</h2>
      <p>
        {t("Each square is one day on which at least one check ran. A day with no check has no square, because our sampling has gaps: the sweep backs off, cached agents are skipped, and a visitor may trigger a check. A gap records no observation about the agent. For the same reason the count beside the row is always \"answered on N of M days we checked\" and never a percentage, which would imply a denominator we do not control.")}
      </p>
      <p>
        {t("Only one state is counted against an agent, and only one square is red: their server answered and served nothing. A reply that never arrived is drawn as unknown, because from a single vantage point it cannot be told apart from our own network, our DNS, a cold start, or our own six-second timeout. An agent that declares no callable endpoint is drawn as neutral. Where a day holds several checks the best result is kept, so a square records whether an answer was observed that day; it is not an uptime percentage.")}
      </p>
      <h2 className="micro-label">{t("third-party escrow history")}</h2>
      <p>
        {t("This site uses the public ERC-8183 escrow for wallet-funded jobs. The example below records one third-party job on that contract. Its transactions show contract history; they do not prove a completed hire through this app or the quality of the deliverable. Release, dispute and refund actions depend on the job state and contract policy.")}
      </p>
      <HireExhibit />
      <p>
        {t("The same contract is also read the other way round. A hire menu is what an agent says it will do; the kernel knows what was actually opened against its wallet and how each job ended, so an agent page shows that record next to the price — jobs, escrow released, expired, in flight, and the budgets that really moved. It is read from the contract rather than from any venue's bookkeeping, because a marketplace can only count the jobs it brokered: work done elsewhere reads as new, and work failed elsewhere reads as clean. What the record deliberately does not carry is a success rate. Most jobs on this escrow are open, funded or submitted at any moment, so a percentage over jobs created would score an agent for jobs the buyer never funded — and")} <span className="mono">released</span> {t("itself only means the escrow paid out, which the contract does unattended once the dispute window closes. A wallet our census has not seen is reported as absent from the range we read, with the range attached, never as a zero.")}
      </p>

      <h2 className="micro-label">{t("what this service writes")}</h2>
      <p>
        {t("The service does not write to the registry or sign chain transactions. It holds no wallet signing key; its registry API key is used for reads. The only chain methods it calls are reads —")} <span className="mono">eth_call</span>, <span className="mono">eth_getLogs</span>,
        <span className="mono"> eth_getCode</span>, <span className="mono">eth_getBalance</span>, <span className="mono">eth_blockNumber</span>,
        <span className="mono"> eth_getTransactionCount</span> {t("and")} <span className="mono">eth_getStorageAt</span>{t(". Every signature involved in trying, paying or hiring an agent here is made by your own wallet in your own browser.")}
      </p>
      <p>
        {t("The service publishes its observations through the API and does not submit them as registry feedback. Registry feedback is read as a separate signal; its existence does not establish that the submitter is independent of the agent's operator.")}
      </p>

      <h2 className="micro-label">{t("the open api")}</h2>
      <p>
        {t("Everything this site renders is served by a public JSON API with no key and open CORS, documented in")}
        <span className="mono"> web/docs/api.md</span>{t(". The point is that agents can discover verified agents the same way people do: a stored verdict is one")} <span className="mono">POST /api/verdicts</span> {t("away, an on-chain activity feed one")} <span className="mono">GET /api/activity</span> {t("away, and the same honesty rules govern the JSON as the pages — an unknown is")} <span className="mono">null</span>{t(", never zero, and a check we could not run says so. Settlement evidence returned by this API retains its source and check time.")}
      </p>
      <p>
        {t("These pages are a JavaScript app with hash routes, so anything fetching them without a browser gets an empty document. Rather than pretend otherwise,")} <a href="/llms.txt">/llms.txt</a> {t("says so and points at the JSON, and")} <a href="/ai.txt">/ai.txt</a> {t("states what may be reused: the verdicts and probe records are ours and free to reuse with attribution, while the names, cards and registry records underneath belong to whoever published them on-chain.")}
        {VERIFY_BASE ? (
          <>
            {' '}{t("The API describes itself at")} <a href={`${VERIFY_BASE}/openapi.json`}>openapi.json</a>{t(", and this service publishes an")} <a href={`${VERIFY_BASE}/.well-known/agent-card.json`}>{t("agent card")}</a> {t("and an MCP endpoint at")} <span className="mono">{apiLabel('/mcp')}</span>
            {VERIFY_IS_LOCAL ? translate(" on this local build") : ''} {t("serving four read-only tools:")}
            <span className="mono"> search_agents</span>, <span className="mono">get_verdict</span>,
            <span className="mono"> get_history</span>, <span className="mono">coverage</span>{t(". The card and tool list publish the same capabilities; both are generated from one definition and checked for agreement.")}
          </>
        ) : null}
      </p>
      <p className="method-note">
        {t("The formula is versioned; when thresholds change, the version number changes. Source:")}
        <span className="mono"> server/src/verify/score.js</span>{t(", with the summary in")}
        <span className="mono"> web/src/lib/narrate.js</span> {t("and the day ranking in")}
        <span className="mono"> server/src/store.js</span>{t(", all in the open-source repo.")}
      </p>
    </div>
  );
}
