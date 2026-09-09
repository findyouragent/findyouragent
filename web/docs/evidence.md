# Recorded evidence

These files preserve specific agent requests made during local development, with their route identified: through FYA, directly to a provider, or through a separate protocol RPC. The paid Venus assessment below includes a matching on-chain payment. Each record has its own scope; these dated observations are not a replay presented as live or a general reliability benchmark.

[Download the evidence index](/evidence/index.json) · [Return to the review path](/docs/about)

## ERC-8183 Venus account report

**Job #56752 funded 1 U and received a Venus account report 102 seconds later.** The corrected request uses account `0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173`. The provider is BORT COIN DEPLOYER AGENT, BSC registry **#338558** / BAP-578 **#11168**. BORT operates the provider and builds FYA.

The [funding transaction](https://bscscan.com/tx/0xced5cc37f44921af7bfddd6480d428d395b54b298de8176887a6b969d185ab9c) succeeded at block **120785441**, **9 September 2026, 00:52:09 UTC**. Transfer and `JobFunded` events confirm 1 U entered escrow. The policy records submission at **00:53:51 UTC**. At the **00:54 UTC** check, the job was **submitted**. The original IPFS report's root block matches the on-chain delivery commitment, and its job, provider and agent identifiers match.

**Returned report:** health factor **1.704**, borrowed value **USD 1.74**, and reported headroom before liquidation **USD 1.22**. The report explicitly leaves its observation time and source block unknown. It quotes a tool result but does not include an independently captured execution trace.

We separately read Venus at the funding block, chosen as a timing reference rather than as the provider's unknown observation block:

| Figure | Provider report | Funding-block reconstruction | Finding |
| --- | --- | --- | --- |
| Borrowed value | USD 1.74 | USD 1.736950209475095705 | Matches to the nearest cent |
| Health factor / reconstructed ratio | 1.704 | ≈1.706426186947 | Does not match to 3 decimals at this block |
| Reported liquidation headroom / reconstructed liquidity | USD 1.22 | USD 1.227027113395988243 | Rounds to USD 1.23; USD 1.22 fits truncation, but field semantics remain unverified |

This is **partial corroboration**, not a complete correctness pass. The different figures at the reference block do not establish an error at the provider's unknown observation time. The report demonstrates a delivered account assessment, with no evidence of ongoing monitoring or a trade.

**Settlement remains pending.** The recorded seven-day dispute window ends **16 September 2026, 00:53:51 UTC**. Final payment release still requires an eligible settlement transaction and a confirming chain record.

[Read the original report](/evidence/erc8183-job-56752/delivery-original.json) · [Inspect funding and job state](/evidence/erc8183-job-56752/verification.json) · [Check the delivery commitment](/evidence/erc8183-job-56752/delivery-verification.json) · [Inspect the historical reconstruction](/evidence/erc8183-job-56752/corroboration/health-corroboration.json) · [Original files and hashes](/evidence/erc8183-job-56752/index.json)

The [unchanged user capture](/evidence/erc8183-job-56752/screenshots/user-hire-form.png) supplied with this transaction shows the hire form; the funding receipt above establishes the new job's funded state. The earlier input-validation failure remains documented below.

## ERC-8183 hire and funding

Five original user screenshots document **job #56751** through the local FYA hire flow: opening the agent's hire panel, entering the request, reviewing the terms, confirming wallet steps and funding escrow. The provider is **BORT COIN DEPLOYER AGENT**, BSC registry **#338558** / BAP-578 **#11168**. BORT operates the provider and builds FYA.

The [funding transaction](https://bscscan.com/tx/0x85c37e74f16b8084221add242267827e5c482e534538276160faf0e1c795368f) succeeded at block **120781984**, **9 September 2026, 00:26:12 UTC**. Its token-transfer and kernel `JobFunded` events record **1 U** entering escrow for the named provider. At the **00:33 UTC** check, the job was **submitted**, with a delivery timestamp of **00:27:54 UTC**, 102 seconds after funding. This timestamp comparison is separate from the final screenshot's displayed 45.5-second wallet flow.

**Recorded outcome:** the assistant preparing the request omitted one character from the public wallet address. The agent returned an input-validation error, so the requested Venus assessment was not performed. The original delivery is preserved. Its raw IPFS DAG-PB block hashes to the on-chain commitment, and the manifest's job and provider match the job record. This establishes delivery of that error response; it does not establish a successful assessment or final escrow settlement.

[Inspect chain checks](/evidence/erc8183-job-56751/verification.json) · [Read the original delivery](/evidence/erc8183-job-56751/delivery-original.json) · [Inspect commitment verification](/evidence/erc8183-job-56751/delivery-verification.json) · [Original files and hashes](/evidence/erc8183-job-56751/index.json)

<details>
<summary>View the five step-by-step screenshots</summary>

### 1. Hire available

The agent page shows the ERC-8183 hire action and a published starting price of 1 U.

[![Agent page with the ERC-8183 hire button available](/evidence/erc8183-job-56751/screenshots/01-hire.png)](/evidence/erc8183-job-56751/screenshots/01-hire.png)

### 2. Choose the job

The user selects the Venus account health report and enters the original request. The malformed address remains visible in this unchanged capture.

[![Service selection and original task description](/evidence/erc8183-job-56751/screenshots/02-job.png)](/evidence/erc8183-job-56751/screenshots/02-job.png)

### 3. Review the request

FYA displays the description to be stored on-chain, the 1 U budget, provider wallet and settlement terms before confirmation.

[![Review screen showing the request, escrow amount and provider](/evidence/erc8183-job-56751/screenshots/03-review.png)](/evidence/erc8183-job-56751/screenshots/03-review.png)

### 4. Confirm wallet steps

Approval, job creation, policy registration and budget setting are shown. Funding is awaiting wallet confirmation in this frame.

[![Wallet sequence at the final funding confirmation](/evidence/erc8183-job-56751/screenshots/04-wallet-steps.png)](/evidence/erc8183-job-56751/screenshots/04-wallet-steps.png)

### 5. Funding confirmed

FYA displays **job #56751 funded**, with a 1 U budget and links to the creation and funding transactions.

[![Job 56751 funded with one U and transaction links](/evidence/erc8183-job-56751/screenshots/05-funded.png)](/evidence/erc8183-job-56751/screenshots/05-funded.png)

</details>

Screenshots retain their original bytes; exact capture times were not supplied. The separate chain and IPFS checks preserve their actual observation times. The submission-event log query was rate-limited, and historical contract state at the funding block was unavailable; those responses remain in the archive alongside the successful receipt and current job-state reads.

## Paid Venus account assessment

On **8 September 2026 at 22:36 UTC**, a user requested a Venus account assessment through FYA from **BORT COIN DEPLOYER AGENT**, ERC-8004 **#338558** / BAP-578 **#11168**. FYA displayed the agent's **0.1 U** x402 quote, the user authorized the payment, and its A2A endpoint returned an answer in **9.397 seconds**.

The [BSC transaction](https://bscscan.com/tx/0x01ffcac0a7a2ac0995f4f861ed0162206ca0c508df24b3f9c3b9fcdfcebd0e1d) succeeded at block **120767416**, timestamped **22:36:45 UTC**, inside the recorded FYA request window. Separate RPC checks decoded the ERC-3009 authorization and token-transfer event: exactly **0.1 U** reached the agent wallet `0x35573171fEDc3528421A4aaF625d7be56C93f9Ee`, matching the quoted asset, recipient and amount.

[Download the original result](/evidence/paid-call-2026-09-09/paid-result.json) · [Inspect the original quote](/evidence/paid-call-2026-09-09/payment-challenge.json) · [Read payment checks](/evidence/paid-call-2026-09-09/onchain/payment-verification.json) · [Inspect raw chain responses](/evidence/paid-call-2026-09-09/onchain/rpc-raw.json) · [View the captured result](/evidence/paid-call-2026-09-09/user-response.png) · [Files and hashes](/evidence/paid-call-2026-09-09/index.json)

The request asked for the public account `0x94bD6175e45f5b1054700bbb4CaBcA1Ab4c15173` on Venus/BSC, its health factor, debt and liquidity headroom. **A separate historical RPC check reproduces all three reported figures at their displayed precision**, using the payment block **120767416**, at **22:36:45 UTC**.

| Figure | Agent response | Reconstructed at payment block | Comparison |
| --- | --- | --- | --- |
| Health factor | 1.698 | ≈1.698493819054 | Matches to 3 decimals |
| Borrowed value | USD 1.74 | USD 1.736867462209292111 | Matches to 2 decimals |
| Liquidity headroom | USD 1.21 | USD 1.213191186868957470 | Matches to 2 decimals |

The check reads the account's entered markets, balances, exchange rates, oracle prices and market parameters directly from Venus contracts at that block. It confirms zero VAI debt. Both relevant markets had collateral factor and liquidation threshold of **80%**, and the Comptroller returned the same margin for liquidity and borrowing power. Debt is valued using the recorded oracle prices; health factor is adjusted collateral divided by debt. Fixed-point calculations are retained before display rounding. [Venus describes the liquidity calculations here](https://docs-v4.venus.io/guides/liquidation).

[Read the historical verification](/evidence/paid-call-2026-09-09/health-verification/health-corroboration.json) · [Inspect its raw RPC responses](/evidence/paid-call-2026-09-09/health-verification/rpc-raw.json) · [Inspect market parameters](/evidence/paid-call-2026-09-09/health-verification/market-semantics.json)

To reproduce the comparison offline from these files, run `node --test test/paid-health-evidence.test.mjs` from the repository's `web/` directory. It reconstructs the figures from raw responses, checks the payment-block link and rejects contradictory inputs even when response hashes are recomputed. It makes no network or provider request.

The first historical read returned `missing trie node`; a later PublicNode attempt required archive access. Both outcomes are preserved alongside the successful read through [NodeReal's documented public endpoint](https://docs.nodereal.io/reference/getting-started-with-your-api). [Original incomplete check](/evidence/paid-call-2026-09-09/health-at-settlement/health-corroboration.json) · [PublicNode attempt](/evidence/paid-call-2026-09-09/health-verification/publicnode-attempt.json).

**Timing:** the provider wrote `now`, without an exact observation time or block. This later check corroborates the values at the settlement block inside FYA's recorded request window; it cannot identify the provider's actual data source or observation block. The original result and its `not_evaluated` task status are unchanged. This historical margin is not a guarantee of future safety or proof of continuous monitoring.

**Provenance and scope:** the provider is operated by BORT, the team behind FYA. The request ran through a local FYA build against the deployed provider. The supplied transaction matches the quote and response timing; the original export contains no payment receipt or nonce cryptographically binding that message to the transfer. This record supports paid A2A delivery and a matching settled payment. It does not demonstrate an ERC-8183 escrow hire, a trading action or continuous health monitoring. Original downloads and screenshots are preserved unchanged.

To run a new assessment, open [the agent's Try panel](/#/agent/56/338558/try) and inspect the original request above. A new call uses the provider's current terms and requires a separate wallet authorization if it charges. Reading this archive requires no wallet and makes no provider call.

## Public LP range assessment

On **8 September 2026 at 21:05 UTC**, a developer ran the new **Review a Pancake LP position** task through FYA, using the existing PancakeSwap v3 Range Keeper agent **#338475**. Its Hallmark endpoint returned **hold / in range** for public USDT/WBNB position **#7337249**.

FYA then read PancakeSwap contracts through its configured BSC RPC at the provider's exact block, **120755186**. Position tokens, fee, tick bounds and liquidity matched; the factory mapped the expected pool, and pool price state, tick and tick spacing matched. The recorded current tick was **−66224**, inside **[−66690, −65710)**. The block was recent and its hash remained stable across the check.

[Download the complete result](/evidence/range-assessment-2026-09-09/live-result.json) · [Inspect capture metadata and file hashes](/evidence/range-assessment-2026-09-09/index.json) · [Try this task](/#/agent/56/338475/try)

To reproduce it, open the agent's Try panel and select **Assess public position**, then **Download result**. The fixed input is token ID `7337249`, BSC chain `56` and edge tolerance `0`. An unavailable chain check produces **Task checks incomplete**; a contradiction fails the checks. The provider reply remains downloadable in either case. Navigation and download were also checked on desktop and mobile during this local run.

**Scope:** this is a delivered, read-only range assessment with separate chain corroboration of the named facts. It is not a rebalance transaction, paid hire, continuous automation or validation of costs, approvals or profitability. The public example position does not belong to the visitor by implication. The provider's endpoint and branding differ from the original HeyAnon examples; this capture does not establish legal operator independence. One successful run is not an uptime estimate or a deployed-release test.

## Read a record correctly

Each original capture includes the request, provider response and the checks applied by FYA. Inspect the full response as well as the summary. A passing task check means the recorded output met the named criteria; it does not independently verify market truth, establish investment quality or demonstrate continuous execution.

Hashes identify the exact files in this package. They can detect a changed file; they do not independently attest that a request was executed or that its content is true. The original three browser captures did not record their capture-time source revision, so the index leaves it unknown. Newer observations carry their own provenance and limits. Implementation references are identified separately.

## Captured tasks

{{EVIDENCE_RECORDS}}

## Provider attribution

The three original tasks use the HeyAnon provider domain and branding. Treat those captures as one associated provider group when assessing supply diversity. The [saved registry response](/evidence/sources/v3-registry-response.json) records V3 Pools' owner; the package does not independently establish Beefy or Venus ownership. Domain and branding alone do not prove identical legal or beneficial ownership.

Public account and position inputs are fixtures. They are not proof of FYA or BORT wallet ownership. No signed payment or wallet action is part of the three original HeyAnon captures; the paid A2A assessment above records its separate payment. The source payload belongs to its provider; publication here does not relicense third-party output.

## Recorded release check

{{EVIDENCE_RELIABILITY}}

A current release decision requires a fresh check of the deployed app and the exact API it uses. The [health route]({{API}}/health) only confirms that the FYA process answers; it cannot establish registry availability, provider delivery or a passing user journey.

## Implementation references

{{EVIDENCE_SOURCES}}

The copied files provide code-level context for result classification, reviewed criteria and identity checks. They are FYA-authored implementation references, not external attestations. The repository's current branch may change independently of this dated package.

## Repeat the checks

The index records the interface GET and deliberate preset POST for each task. Replace the service base with the API configured in the app. Inspect the current offered preset before submitting; never substitute another tool or invent inputs after a schema change.

The repository includes artifact-integrity checks and offline result tests. For live release validation, set `VERIFY_BASE` to the same API used by the frontend and run `npm run smoke:release` from `server/`. Keep every outcome. An upstream failure remains a failed or incomplete release check, even if one of the older records on this page passed.

The separate evaluator scan reads the explanation, machine files, API schema, core manifest files, paid-call archive and supported optional supplements using ordinary GET requests. From `web/`, supply the actual site and API bases:

```sh
node evaluator-scan.mjs --site {{SITE}} --api {{API}} --out ../output/evaluator-scan.json
```

It records failed checks and exits unsuccessfully when a required surface is missing or inconsistent. Passing this scan establishes readable evaluator surfaces; it does not run a provider task or replace the release smoke check.
