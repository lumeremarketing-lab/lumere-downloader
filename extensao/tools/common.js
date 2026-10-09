// =============================================================
//  Peças compartilhadas pelas ferramentas
// =============================================================

export function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else e[k] = v;
  }
  for (const c of [].concat(children)) if (c != null && c !== false) e.append(c);
  return e;
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i >= 2 ? 1 : 0).replace('.', ',') + ' ' + u[i];
}

export const baseName = (name) => name.replace(/\.[^.]+$/, '');
export const extOf = (name) => (name.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const inExtension = () => typeof chrome !== 'undefined' && !!chrome.runtime?.id;

export function savings(before, after) {
  if (!before) return '';
  const pct = Math.round((1 - after / before) * 100);
  return pct > 0 ? `<span class="good">−${pct}%</span>` : `<span class="bad">+${Math.abs(pct)}%</span>`;
}

// ---------- download ----------
export async function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  if (inExtension() && chrome.downloads) {
    const dot = filename.lastIndexOf('.');
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const ext = dot > 0 ? filename.slice(dot) : '';
    const ascii = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '').trim() || 'arquivo';
    for (const name of [filename, ascii + ext, 'arquivo' + ext]) {
      try { return await chrome.downloads.download({ url, filename: name.replace(/[\\/:*?"<>|]/g, '_'), conflictAction: 'uniquify' }); }
      catch (e) { if (!/filename/i.test(e.message)) break; }
    }
  }
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

export async function downloadZip(entries, zipName) {
  const zip = new JSZip();
  const used = new Set();
  for (const { name, blob } of entries) {
    let n = name, i = 2;
    while (used.has(n)) n = `${baseName(name)} (${i++}).${extOf(name)}`;
    used.add(n);
    zip.file(n, blob);
  }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return download(blob, zipName);
}

// ---------- área de soltar arquivos ----------
export function dropzone({ accept = '', multiple = true, title = 'Arraste arquivos aqui', hint = '', onFiles }) {
  const input = el('input', { type: 'file', accept, multiple, hidden: true });
  const zone = el('div', { className: 'drop', tabIndex: 0 }, [
    el('b', { textContent: title }),
    'ou clique para escolher',
    hint ? el('small', { textContent: hint }) : null,
    input,
  ]);
  const deliver = (files) => {
    const list = [...files].filter((f) => f && f.size !== undefined);
    if (list.length) onFiles(multiple ? list : [list[0]]);
  };
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => { deliver(input.files); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (e.dataTransfer.files.length) return deliver(e.dataTransfer.files);
    // imagem arrastada de um site: baixa pelo endereço
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (/^https?:\/\//.test(url)) {
      try {
        const r = await fetch(url);
        const b = await r.blob();
        const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'imagem') || 'imagem';
        deliver([new File([b], /\.[a-z0-9]{2,4}$/i.test(name) ? name : name + '.' + (b.type.split('/')[1] || 'bin'), { type: b.type })]);
      } catch { /* ignora */ }
    }
  });
  // colar (Ctrl+V) uma imagem copiada
  const onPaste = (e) => {
    if (!document.body.contains(zone)) return document.removeEventListener('paste', onPaste);
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); deliver(files.map((f, i) => new File([f], f.name && f.name !== 'image.png' ? f.name : `colado-${Date.now()}-${i + 1}.${f.type.split('/')[1] || 'png'}`, { type: f.type }))); }
  };
  document.addEventListener('paste', onPaste);
  return zone;
}

// ---------- linha de arquivo com progresso ----------
export function fileRow(file, { thumb, badge } = {}) {
  const th = el('div', { className: 'th', textContent: badge || extOf(file.name).toUpperCase().slice(0, 4) });
  if (thumb) { th.style.backgroundImage = `url("${thumb}")`; th.textContent = ''; }
  const fs = el('div', { className: 'fs', textContent: formatBytes(file.size) });
  const bar = el('div', { className: 'bar' }, [el('div')]);
  const actions = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } });
  const node = el('div', { className: 'file' }, [
    th,
    el('div', { className: 'fi' }, [el('div', { className: 'fn', textContent: file.name, title: file.name }), fs, bar]),
    actions,
  ]);
  bar.hidden = true;
  return {
    node,
    actions,
    setThumb(url) { th.style.backgroundImage = `url("${url}")`; th.textContent = ''; },
    progress(p, text) {
      bar.hidden = false;
      bar.firstChild.style.width = Math.max(0, Math.min(100, p)) + '%';
      if (text != null) fs.textContent = text;
    },
    status(html, cls) { node.classList.remove('done', 'error'); if (cls) node.classList.add(cls); fs.innerHTML = html; },
    done(html) { bar.hidden = false; bar.firstChild.style.width = '100%'; node.classList.add('done'); fs.innerHTML = html; },
    error(msg) { node.classList.add('error'); fs.textContent = msg; bar.hidden = true; },
    button(label, onClick, cls = '') {
      const b = el('button', { className: 'mini-btn ' + cls, textContent: label, onclick: onClick });
      actions.append(b);
      return b;
    },
    removeButton(onRemove) {
      const b = el('button', { className: 'icon-btn', textContent: '×', title: 'Remover', onclick: () => { node.remove(); onRemove?.(); } });
      actions.append(b);
      return b;
    },
  };
}

// ---------- resultados (baixar um a um ou tudo em .zip) ----------
export function resultsPanel(zipName = 'arquivos.zip') {
  const entries = [];
  const list = el('div', { className: 'files' });
  const allBtn = el('button', { className: 'mini-btn blue', textContent: 'Baixar tudo (.zip)', hidden: true });
  const head = el('div', { className: 'results-head', hidden: true }, [el('h4', { textContent: 'Prontos' }), allBtn]);
  allBtn.onclick = () => downloadZip(entries, typeof zipName === 'function' ? zipName() : zipName);
  return {
    node: el('div', {}, [head, list]),
    list,
    entries,
    add(entry) {
      entries.push(entry);
      head.hidden = false;
      allBtn.hidden = entries.length < 2;
    },
    clear() { entries.length = 0; list.replaceChildren(); head.hidden = true; },
  };
}

// ---------- controles de opções ----------
export function opt(label, control, { wide } = {}) {
  return el('label', { className: 'opt' + (wide ? ' wide' : '') }, [label, control]);
}

export function selectEl(options, value) {
  const s = el('select');
  for (const o of options) {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    s.append(el('option', { value: v, textContent: t, selected: v === value }));
  }
  return s;
}

export function segmented(options, value, onChange) {
  const box = el('div', { className: 'seg' });
  let current = value;
  for (const [v, t] of options) {
    const b = el('button', { type: 'button', textContent: t, className: v === value ? 'on' : '' });
    b.onclick = () => {
      current = v;
      [...box.children].forEach((c) => c.classList.toggle('on', c === b));
      onChange?.(v);
    };
    box.append(b);
  }
  return { node: box, get value() { return current; } };
}

export function rangeEl(min, max, step, value, fmt = (v) => v) {
  const input = el('input', { type: 'range', min, max, step, value });
  const val = el('span', { className: 'val', textContent: fmt(value) });
  input.addEventListener('input', () => (val.textContent = fmt(input.value)));
  return { node: el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [input, val]), input, get value() { return Number(input.value); } };
}

export function numberEl(value, { min, max, step = 1, width = 90 } = {}) {
  return el('input', { type: 'number', value, min, max, step, style: { width: width + 'px' } });
}

export function checkEl(label, checked = false) {
  const input = el('input', { type: 'checkbox', checked });
  return { node: el('label', { className: 'check' }, [input, label]), input, get value() { return input.checked; } };
}

// executa tarefas com limite de simultaneidade
export async function pool(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

// intervalos de páginas "1-3, 5, 8-10" -> [[1,3],[5,5],[8,10]]
export function parseRanges(text, max) {
  const out = [];
  for (const part of text.split(/[,;]+/)) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(\d+)\s*(?:-\s*(\d+)?)?$/);
    if (!m) throw new Error(`Não entendi "${t}". Use algo como 1-3, 5, 8-10.`);
    let a = Number(m[1]);
    let b = m[2] ? Number(m[2]) : t.includes('-') ? max : a;
    if (a < 1 || b < 1 || a > max || b > max) throw new Error(`O PDF tem ${max} páginas; "${t}" está fora disso.`);
    if (b < a) [a, b] = [b, a];
    out.push([a, b]);
  }
  if (!out.length) throw new Error('Informe as páginas.');
  return out;
}
