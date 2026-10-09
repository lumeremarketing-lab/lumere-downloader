// =============================================================
//  Modelo de ferramenta "em lote": solta arquivos -> ajusta opções
//  -> processa todos -> baixa um a um ou tudo em .zip
// =============================================================
import { el, dropzone, fileRow, download, downloadZip, resultsPanel, formatBytes, pool, baseName } from './common.js';

export function batchTool(view, {
  accept, hint, title, multiple = true,
  options,            // (container) => () => objetoDeOpções
  process,            // async (file, opts, row) => { outputs: [{name, blob}], summary?: html }
  thumb,              // (file) => url | null
  actionLabel = 'Converter',
  zipName = 'convertidos.zip',
  concurrency = 2,
  onFilesChanged,     // (files) => void
}) {
  const files = [];
  const rows = new Map();
  const list = el('div', { className: 'files' });
  const results = resultsPanel(zipName);
  const optBox = el('div', { className: 'options' });
  const getOpts = options ? options(optBox) : () => ({});
  if (!optBox.children.length) optBox.hidden = true;

  const run = el('button', { className: 'primary', textContent: actionLabel, disabled: true });
  const clear = el('button', { className: 'secondary', textContent: 'Limpar', hidden: true });
  const status = el('span', { className: 'status' });

  const refresh = () => {
    run.disabled = !files.length;
    clear.hidden = !files.length;
    run.textContent = files.length > 1 ? `${actionLabel} ${files.length} arquivos` : actionLabel;
    onFilesChanged?.(files);
  };

  const addFiles = (incoming) => {
    if (!multiple) { files.length = 0; list.replaceChildren(); rows.clear(); }
    for (const f of incoming) {
      files.push(f);
      const row = fileRow(f, { thumb: thumb?.(f) });
      row.removeButton(() => { files.splice(files.indexOf(f), 1); rows.delete(f); refresh(); });
      rows.set(f, row);
      list.append(row.node);
    }
    refresh();
  };

  clear.onclick = () => { files.length = 0; rows.clear(); list.replaceChildren(); results.clear(); status.textContent = ''; refresh(); };

  run.onclick = async () => {
    run.disabled = true;
    results.clear();
    const opts = getOpts();
    let ok = 0, fail = 0;
    const t0 = performance.now();
    status.className = 'status';
    status.textContent = 'Processando…';
    await pool([...files], concurrency, async (f) => {
      const row = rows.get(f);
      if (!row) return;
      row.actions.querySelectorAll('.mini-btn').forEach((b) => b.remove());
      row.progress(5, 'Processando…');
      try {
        const { outputs, summary } = await process(f, opts, row);
        outputs.forEach((o) => results.add(o));
        const total = outputs.reduce((n, o) => n + o.blob.size, 0);
        row.done(summary || (outputs.length > 1 ? `${outputs.length} arquivos · ${formatBytes(total)}` : `${formatBytes(f.size)} → ${formatBytes(total)}`));
        const dl = outputs.length === 1
          ? row.button('Baixar', () => download(outputs[0].blob, outputs[0].name), 'blue')
          : row.button(`Baixar (${outputs.length}) .zip`, () => downloadZip(outputs, baseName(f.name) + '.zip'), 'blue');
        row.actions.prepend(dl);
        ok++;
      } catch (e) {
        console.error(e);
        row.error('Erro: ' + (e.message || e));
        fail++;
      }
    });
    const secs = ((performance.now() - t0) / 1000).toFixed(1).replace('.', ',');
    status.textContent = `${ok} pronto(s)${fail ? `, ${fail} com erro` : ''} em ${secs}s`;
    if (fail) status.className = 'status err';
    run.disabled = false;
    if (results.entries.length > 1) {
      const all = el('button', { className: 'secondary', textContent: `Baixar tudo (.zip)` });
      all.onclick = () => downloadZip(results.entries, zipName);
      status.after(all);
      setTimeout(() => all.remove(), 600000);
    }
  };

  const zone = dropzone({ accept, multiple, title, hint, onFiles: addFiles });
  view.append(zone, list, optBox, el('div', { className: 'actions' }, [run, clear, status]));
  return { addFiles, files, optBox, rows };
}
