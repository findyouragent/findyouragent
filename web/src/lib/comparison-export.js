const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const safeJson = (value) => JSON.stringify(value).replace(/[<>&]/g, (char) => ({ '<': '\\u003c', '>': '\\u003e', '&': '\\u0026' }[char]));

export function comparisonHtml(input) {
  const snapshot = { schemaVersion: 1, recordType: 'fya-agent-comparison', ...input };
  const locale = escapeHtml(snapshot.locale || 'en');
  const zh = snapshot.locale === 'zh-CN';
  const title = zh ? 'Find Your Agent 对比' : 'Find Your Agent comparison';
  const heads = snapshot.columns.map((column) => `<th scope="col"><strong>${escapeHtml(column.name)}</strong><span class="id">${escapeHtml(column.key)}</span><span class="meta">${zh ? '检查时间' : 'checked'}: ${escapeHtml(column.checkedAt || (zh ? '未检查' : 'not checked'))}<br>${zh ? '来源' : 'source'}: ${escapeHtml(column.evidenceSource || 'unknown')}${column.loadingParts?.length ? `<br>${zh ? '加载中' : 'loading'}: ${escapeHtml(column.loadingParts.join(', '))}` : ''}${column.unavailableParts?.length ? `<br>${zh ? '不可用' : 'unavailable'}: ${escapeHtml(column.unavailableParts.join(', '))}` : ''}</span></th>`).join('');
  const body = snapshot.rows.map((row) => `<tr><th scope="row">${escapeHtml(row.label)}</th>${snapshot.columns.map((_, index) => { const value = row.values?.[index] ?? { text: 'not checked' }; return `<td${value.title ? ` title="${escapeHtml(value.title)}"` : ''}>${escapeHtml(value.text)}</td>`; }).join('')}</tr>`).join('');
  const field = zh ? '证据字段' : 'Evidence field';
  const exported = zh ? '导出时间' : 'Exported';
  const footer = zh ? '已保存的记录证据对比。不代表当前可用性或已完成任务。' : 'Saved comparison of recorded evidence. It does not establish current availability or a completed task.';
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
html { background: #0b0e11; color: #eaecef; font: 15px/1.5 system-ui, sans-serif; }
body { max-width: 1100px; margin: 32px auto; padding: 0 20px; }
h1 { font-size: 22px; }
p, .meta { color: #b7bdc6; }
.stamp { font: 12px ui-monospace, monospace; }
.table-scroll { max-width: 100%; overflow-x: auto; }
table { width: 100%; min-width: 620px; border-collapse: collapse; margin-top: 24px; }
th, td { border: 1px solid #30353d; padding: 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
thead th { background: #181c22; }
.id, .meta { display: block; font-size: 12px; font-weight: 400; margin-top: 4px; overflow-wrap: anywhere; }
.id { font-family: ui-monospace, monospace; color: #f0b90b; }
tbody th { color: #b7bdc6; white-space: normal; }
footer { margin-top: 24px; color: #848e9c; font-size: 13px; }
@media print {
  html { background: #fff; color: #111; }
  body { max-width: none; margin: 0; padding: 0; }
  table { min-width: 0; table-layout: fixed; }
  th, td { border-color: #999; }
  .table-scroll { overflow: visible; }
  thead th { background: #eee; }
  tbody th, .id, .meta, p, footer { color: #444; }
}
</style></head><body><h1>${escapeHtml(title)}</h1><p class="stamp">${exported}: ${escapeHtml(snapshot.exportedAt || '')}</p><div class="table-scroll"><table><thead><tr><th scope="col">${field}</th>${heads}</tr></thead><tbody>${body}</tbody></table></div><footer>${footer}</footer><script type="application/json" id="fya-comparison-data">${safeJson(snapshot)}</script></body></html>`;
}

export function downloadComparison(input) {
  const snapshot = { ...input, exportedAt: input.exportedAt || new Date().toISOString() };
  const blob = new Blob([comparisonHtml(snapshot)], { type: 'text/html;charset=utf-8' });
  const href = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = href; link.download = `fya-comparison-${snapshot.exportedAt.slice(0, 10)}.html`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}
