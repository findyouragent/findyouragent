/**
 * The plain-language dictionary. FROZEN: one entry per term of art, written in
 * this site's own voice, rendered as a dotted-underline tooltip wherever the
 * term appears in our prose.
 *
 * Why a single fixed map instead of explaining terms inline where they occur:
 * two definition sources for one term drift the first time either is edited,
 * and a definition that drifts can start vouching for something the checks do
 * not establish. Every entry here is held to the same rule as the narrative:
 * exactly as strong as what the site actually verifies, in both directions.
 * "Being listed proves registration, not quality" is not humility, it is the
 * measured fact.
 *
 * No entry may contain agent-authored text, a URL, or a claim about any
 * specific agent. The strength tests sweep these strings with the same banned
 * patterns as the narrative.
 */

export const TERMS = {
  'ERC-8004':
    'A public on-chain directory where anyone can register an agent by sending one transaction. Being listed proves registration, not quality.',
  'BAP-578':
    'BNB Chain’s standard for agents that exist as programmable NFTs: a token with a logic contract behind it, so the agent itself can be owned, funded and sold.',
  'registry record':
    'What whoever registered this agent wrote about it in the public directory. A self-description: checkable, but a claim until compared with what the agent actually serves.',
  endpoint:
    'The web address an agent publishes so software can call it. Publishing one is a claim; answering on it is what we check.',
  A2A:
    'A standard way for agents to receive requests from other software. An A2A server identifies itself by serving a small description file called an agent card.',
  MCP:
    'A standard way for software to ask a server which tools it offers and call them. The tool list is what the server itself reports it will execute.',
  'agent card':
    'A small file an agent’s server returns, describing what it is and the skills it offers. Written by the agent about itself: a self-description, not a review.',
  skill:
    'A named operation an agent can be asked to perform. This page compares the ones its listing advertises with the ones its live server actually offered.',
  'on-chain feedback':
    'Feedback recorded permanently against this agent’s directory entry by another blockchain account. It provably exists; the directory does not vouch for who left it.',
  'on-chain':
    'Recorded on a public blockchain: anyone can read it and nobody can quietly edit or delete it. Permanence proves the record exists, not that it is true.',
  B402:
    'A public index of agents that have been paid through x402. An agent appears there only because at least one payment to it actually settled.',
  x402:
    'A way for an agent to charge per call: the server quotes a price and the caller pays before the work runs. Support for it is declared by the agent; a settled payment is the part anyone can verify.',
  'ERC-6551':
    'A standard that gives an NFT its own wallet, derived from the token itself. Whoever owns the token controls the wallet, so its contents move with a sale automatically.',
  'logic contract':
    'The on-chain program a BAP-578 agent points at: the code that runs when the agent acts. Which contract an agent uses is public and can be changed by its owner.',
};

// Longest first, so "on-chain feedback" wins over "on-chain" and a compound
// term is never half-underlined by its own substring.
export const TERM_KEYS = Object.keys(TERMS).sort((a, b) => b.length - a.length);
