// Editorial setup links, bound to the registry identity observed on 7 Sep 2026.
// Historical evidence is separate from FYA verification and task completion.
const providers = [
  {
    tokenId: '269703', name: 'Agripinaa Grid', category: 'Grid trading',
    owner: '0xd6db7ade6ed34d1cf0836d7a1aac5ba3b860c82a',
    manifest: 'https://agripinaa.vercel.app/manifests/grid.json',
    checkedAt: '2026-09-07T22:23:27.052Z',
    evidenceLabel: 'Provider-published execution record',
    evidence: 'The provider reports a fulfilled 2 USDT → 0.002690914776894297 WBNB order on 6 September 2026.',
    evidenceUrl: 'https://agripinaa.vercel.app/api/exec/receipt/0x4aaafc466f70545a608c12fa6b1d7090ae0bb4bd66a3cf4b93924cc6312b87aed6db7ade6ed34d1cf0836d7a1aac5ba3b860c82a6a9d8719',
    transaction: '0xc0ad27a53d584867360ce36610273d937b415d8a11fdf4aa95d94611b9d7ead9',
    limitation: 'This was an operator-funded order. FYA has not independently confirmed the transaction or observed continuous grid execution.',
  },
  {
    tokenId: '269706', name: 'Agripinaa Ranger', category: 'LP rebalancing',
    owner: '0x79827ef1fadea3b30a8e77fdbaf17944298a3bb6',
    manifest: 'https://agripinaa.vercel.app/manifests/lp-range.json',
    checkedAt: '2026-09-07T22:22:08.032Z',
    evidenceLabel: 'Historical mint confirmed on BSC',
    evidence: 'A successful transaction minted Pancake LP position #7337249 to the registered wallet. The provider dates it to 5 September 2026.',
    evidenceUrl: 'https://agripinaa.vercel.app/api/proof',
    transaction: '0xd7de2e0e8aee323de2f42576e71774d1df1fd00199ad29170ff8b50a3d78c484',
    limitation: 'The mint was checked using a BSC transaction receipt. It predates this FYA integration and does not establish continuous rebalancing or returns.',
    relatedTask: { href: '#/agent/56/45650/try', label: 'Read this LP position through HeyAnon' },
  },
];

export function providerHandoff(agent) {
  if (Number(agent?.chain_id) !== 56) return null;
  const provider = providers.find((entry) => entry.tokenId === String(agent?.token_id));
  if (!provider || typeof agent?.owner_address !== 'string'
      || agent.owner_address.toLowerCase() !== provider.owner
      || typeof agent?.agent_wallet !== 'string' || agent.agent_wallet.toLowerCase() !== provider.owner
      || agent.raw_metadata?.offchain_uri !== provider.manifest) return null;
  return { ...provider, setupUrl: `https://agripinaa.vercel.app/agent/56/${provider.tokenId}/activate` };
}
