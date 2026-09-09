import fs from 'node:fs';

// One manifest supplies the HTML, Markdown and machine-readable evidence index.
// Provider response bodies stay in their original downloads, never interpolated
// into the page as markup.
const text = (value) => String(value).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  .replace(/[\\`*_\[\]]/g, '\\$&').replace(/\r?\n/g, ' ');
const link = (label, href) => {
  if (!/^\/evidence\/[a-zA-Z0-9/_.-]+$/.test(href) || href.includes('..')) throw new Error('Invalid evidence link');
  return `[${text(label)}](${href})`;
};

export function evidenceMarkdown() {
  const manifest = JSON.parse(fs.readFileSync(new URL('./public/evidence/index.json', import.meta.url), 'utf8'));
  const records = manifest.records.map((record) => {
    if (!/^[a-z0-9-]+$/.test(record.id)) throw new Error('Invalid evidence anchor');
    const { provider, observation, request, rawCapture } = record;
    let excerpt = '';
    if (record.id === 'pancake-bsc-lp-position') {
      const capture = JSON.parse(fs.readFileSync(new URL(`./public${rawCapture.href}`, import.meta.url), 'utf8'));
      const position = capture.response.body.result.structuredContent.data.positions[0];
      excerpt = [
        '**Provider-reported output excerpt:**',
        '| Returned field | Recorded value |',
        '| --- | --- |',
        ...['positionId', 'amount0', 'amount1', 'lowerPrice', 'upperPrice'].map((key) => `| ${key} | ${text(position[key])} |`),
        '',
        `The provider identifies token0 as ${text(position.token0.symbol)} and token1 as ${text(position.token1.symbol)}. These are the original reported strings, without conversion or independent valuation. Inspect the full response below for token addresses, fees and the remaining fields.`,
      ].join('\n');
    }
    return [
      `<a id="${record.id}" style="display:block;scroll-margin-top:74px"></a>`,
      `### ${text(record.title)}`,
      text(record.summary),
      `**Provider:** ${text(provider.name)} · BSC #${text(provider.tokenId)}. **Observed:** ${text(observation.checkedAt)}.`,
      `**Recorded outcome:** ${text(observation.outcome)}; capture ${observation.captureComplete ? 'complete' : 'incomplete'}; task checks ${text(observation.task.status)}. Elapsed provider observation: ${observation.latencyMs} ms, not an end-to-end journey benchmark.`,
      excerpt,
      `**Exact input:** MCP tool \`${request.tool}\` with these public fixture arguments:`,
      `\`\`\`json\n${JSON.stringify(request.arguments, null, 2)}\n\`\`\``,
      '**Checks applied to this response:**',
      observation.task.checks.map((check) => `- ${check.passed ? 'Passed' : 'Failed'}: ${text(check.label)}.`).join('\n'),
      text(observation.task.limitation),
      `${link('Download the original result', rawCapture.href)} · [Open this agent](${provider.agentPage}) · [Registry listing](${provider.registryUrl})`,
      `<details><summary>File integrity and run identifier</summary>\n\nRun ID: \`${observation.runId}\`. Original file: ${rawCapture.bytes} bytes. SHA-256: \`${rawCapture.sha256}\`. Capture-time source revision: unknown.\n\n</details>`,
    ].join('\n\n');
  }).join('\n\n');
  const release = manifest.reliability;
  return {
    EVIDENCE_RECORDS: records,
    EVIDENCE_RELIABILITY: `The saved local check dated **${text(release.observedDate)}** recorded **${release.counts.passed} passed, ${release.counts.failed} failed and ${release.counts.incomplete} incomplete**. Its overall status was **${text(release.status)}**. ${text(release.scope)}\n\n${link('Inspect the saved check and timestamp limitations', release.href)}.`,
    EVIDENCE_SOURCES: manifest.implementationSources.map((source) => `- ${link(source.sourcePath, source.href)} — ${text(source.description)}`).join('\n'),
  };
}
