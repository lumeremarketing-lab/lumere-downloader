// =============================================================
//  Popup: downloads em andamento, busca por link, YouTube e
//  os vídeos detectados na aba atual (estilo Video DownloadHelper)
// =============================================================

const $ = (id) => document.getElementById(id);
const listEl = $('list');
const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 7v9M8 12l4 4 4-4"/></svg>';
const YOUTUBE_RE = /^https?:\/\/((www|m|music)\.)?(youtube\.com\/(watch|shorts\/|live\/)|youtu\.be\/)/i;

let helper = { ok: false };
let pageThumb = null;

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const c of [].concat(children)) if (c) e.append(c);
  return e;
}

const send = (msg) => chrome.runtime.sendMessage(msg);

function empty(msg) {
  listEl.replaceChildren(el('p', { className: 'empty', textContent: msg }));
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return { text: await res.text(), url: res.url };
}

// =============================================================
//  Miniatura: print da aba recortado no player
// =============================================================
async function makeThumbnail(tab) {
  try {
    const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 70 });
    let found = null;
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          let best = null, bestArea = 0;
          for (const e of document.querySelectorAll('video, iframe, embed, object')) {
            const r = e.getBoundingClientRect();
            const w = Math.min(r.right, innerWidth) - Math.max(r.left, 0);
            const h = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
            if (w > 80 && h > 60 && w * h > bestArea) { bestArea = w * h; best = { x: Math.max(r.left, 0), y: Math.max(r.top, 0), w, h }; }
          }
          return { rect: best, vw: innerWidth };
        },
      });
      if (res?.result?.rect) found = res.result;
    } catch { /* páginas especiais não permitem scripts */ }

    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = shot; });
    const scale = found ? img.width / found.vw : 1;
    const r = found ? found.rect : { x: 0, y: 0, w: img.width, h: img.height };
    const c = document.createElement('canvas');
    c.width = 264; c.height = 152;
    let sx = r.x * scale, sy = r.y * scale, sw = r.w * scale, sh = r.h * scale;
    const target = c.width / c.height;
    if (sw / sh > target) { const nw = sh * target; sx += (sw - nw) / 2; sw = nw; }
    else { const nh = sw / target; sy += (sh - nh) / 2; sh = nh; }
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}

// =============================================================
//  Cartão de vídeo  (options: [{ label, value }])
// =============================================================
function card({ title, ext = 'mp4', thumb, badge, duration, options, message, onDownload, onClose }) {
  const t = el('div', { className: 'thumb' });
  if (thumb) t.style.backgroundImage = `url("${thumb}")`;
  if (duration) t.append(el('span', { className: 'dur', textContent: duration }));

  const fullName = `${title}.${ext}`;
  const name = el('div', { className: 'name', title: fullName }, [el('span', { className: 'badge', textContent: badge }), fullName]);

  const btn = el('button', { className: 'dl' });
  btn.innerHTML = DL_ICON + '<span>Baixar</span>';

  let select = null;
  const controls = el('div', { className: 'controls' });
  if (options && options.length) {
    select = el('select');
    options.forEach((o) => select.append(el('option', { value: String(o.value), textContent: o.label })));
    controls.append(el('div', { className: 'quality' }, [ext.toUpperCase(), select]));
  }
  controls.append(el('div', { className: 'spacer' }), btn);

  const body = el('div', { className: 'body' }, [name]);
  if (message) body.append(el('div', { className: 'msg ' + (message.type || ''), textContent: message.text }));
  body.append(controls);

  const node = el('div', { className: 'card' }, [t, body]);
  if (onClose) {
    const close = el('button', { className: 'close', textContent: '×', title: 'Remover da lista' });
    close.onclick = () => { node.remove(); onClose(); };
    node.append(close);
  }

  if (!onDownload) btn.disabled = true;
  btn.onclick = async () => {
    btn.disabled = true;
    btn.lastChild.textContent = 'Iniciando…';
    try {
      const r = await onDownload(select ? select.value : null);
      if (r && r.ok === false) throw new Error(r.error);
      btn.lastChild.textContent = 'Na fila ✓';
      setTimeout(() => { btn.disabled = false; btn.lastChild.textContent = 'Baixar'; }, 2500);
    } catch (e) {
      btn.lastChild.textContent = 'Erro';
      btn.title = e.message;
    }
  };
  return node;
}

const startJob = (spec) => send({ cmd: 'start', spec });

// =============================================================
//  Downloads em andamento (atualiza sozinho)
// =============================================================
function renderJobs(jobs) {
  const list = (jobs || []).slice().sort((a, b) => b.time - a.time);
  $('jobsSection').hidden = !list.length;
  $('jobs').replaceChildren(...list.map((j) => {
    const bar = el('div', { className: 'jbar' }, [el('div')]);
    bar.firstChild.style.width = (j.percent || 0).toFixed(1) + '%';
    const text = j.status === 'error' ? 'Erro: ' + (j.error || '') : j.text || '';
    const actions = el('div', { className: 'jactions' });
    if (j.status === 'running') {
      const b = el('button', { className: 'small-btn', textContent: 'Cancelar' });
      b.onclick = () => send({ cmd: 'cancel', id: j.id });
      actions.append(b);
    } else {
      if (j.status === 'done') {
        const s = el('button', { className: 'small-btn', textContent: 'Mostrar' });
        s.onclick = () => send({ cmd: 'show', id: j.id });
        actions.append(s);
      }
      const x = el('button', { className: 'small-btn', textContent: '×', title: 'Tirar da lista' });
      x.onclick = () => send({ cmd: 'clear', id: j.id });
      actions.append(x);
    }
    const mini = el('div', { className: 'mini' });
    if (j.thumb) mini.style.backgroundImage = `url("${j.thumb}")`;
    const info = el('div', { className: 'jinfo' }, [
      el('div', { className: 'jtitle', textContent: j.title, title: j.title }),
      bar,
      el('div', { className: 'jtext', textContent: text, title: text }),
    ]);
    if (j.note) info.append(el('div', { className: 'jnote', textContent: j.note }));
    return el('div', { className: 'job ' + j.status }, [mini, info, actions]);
  }));
}

chrome.storage.session.get('jobs').then((d) => renderJobs(d.jobs));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.jobs) renderJobs(changes.jobs.newValue);
});
$('clearJobs').onclick = () => send({ cmd: 'clear' });

// =============================================================
//  Ajudante (yt-dlp): status, link colado e YouTube
// =============================================================
const openHelperPage = () => chrome.tabs.create({ url: chrome.runtime.getURL('ajudante.html') });

function renderHelperStatus() {
  const s = $('helperStatus');
  const a = $('helperAction');
  a.hidden = false;
  if (helper.ok) {
    s.className = 'helper-status ok';
    s.textContent = `Ajudante ${helper.version || ''} ativo · yt-dlp ${helper.ytdlp || ''}`;
    a.textContent = 'Atualizar yt-dlp';
    a.onclick = async () => {
      a.textContent = 'Atualizando…';
      const r = await send({ cmd: 'helper-update' });
      a.textContent = r.ok ? 'Atualizado ✓' : 'Falhou';
      helper = await send({ cmd: 'helper-status', force: true });
      setTimeout(renderHelperStatus, 1500);
    };
  } else {
    s.className = 'helper-status off';
    s.textContent = 'Ajudante não instalado';
    a.textContent = 'Instalar (YouTube e links)';
    a.onclick = openHelperPage;
  }
}

function helperCard(info, { onClose } = {}) {
  const heights = (info.heights || []).filter((h) => h >= 144);
  const options = [{ label: 'Melhor', value: 'best' }].concat(heights.map((h) => ({ label: h + 'p', value: String(h) })));
  if (info.hasAudio) options.push({ label: 'Só áudio', value: 'audio' });
  return card({
    title: safeFilename(info.title),
    thumb: info.thumbnail,
    badge: (info.site || 'LINK').toUpperCase().slice(0, 10),
    duration: formatDuration(info.duration),
    options,
    message: info.isLive ? { type: 'warn', text: 'Transmissão ao vivo: baixa enquanto estiver no ar.' } : null,
    onClose,
    onDownload: (quality) => startJob({ kind: 'helper', url: info.url, quality, title: info.title, thumb: info.thumbnail }),
  });
}

// =============================================================
//  Posts do Instagram (e outras galerias de fotos): só por link
// =============================================================
const INSTAGRAM_RE = /^https?:\/\/(www\.)?instagram\.com\/(p|reel|reels|tv|stories)\//i;

async function blobThumb(url) {
  // as imagens do Instagram não aparecem direto no popup, então buscamos pela extensão
  try {
    const r = await fetch(url, { credentials: 'omit' });
    if (!r.ok) return null;
    return URL.createObjectURL(await r.blob());
  } catch { return null; }
}

function galleryView(res, onClose) {
  const items = res.items || [];
  const selected = new Set(items.map((_, i) => i));
  const user = res.username && res.username !== 'directlink' ? '@' + res.username : 'Galeria';
  const box = el('div', { className: 'gallery' });
  const count = el('span', { className: 'g-count' });
  const head = el('div', { className: 'g-head' }, [
    el('span', { className: 'badge', textContent: 'INSTAGRAM' }),
    el('span', { className: 'g-user', textContent: user }),
    count,
    el('span', { className: 'spacer' }),
  ]);
  const close = el('button', { className: 'close', textContent: '×', title: 'Fechar' });
  close.style.position = 'static';
  close.onclick = onClose;
  head.append(close);
  box.append(head);
  if (res.description) box.append(el('div', { className: 'g-desc', textContent: res.description, title: res.description }));

  const grid = el('div', { className: 'g-grid' });
  const btn = el('button', { className: 'dl' });
  const toggleAll = el('button', { className: 'small-btn' });

  const refresh = () => {
    count.textContent = items.length > 1 ? `${items.length} itens (carrossel)` : '1 item';
    btn.innerHTML = DL_ICON + `<span>Baixar ${selected.size === items.length && items.length > 1 ? 'todos' : 'selecionados'} (${selected.size})</span>`;
    btn.disabled = !selected.size;
    toggleAll.textContent = selected.size === items.length ? 'Desmarcar todos' : 'Marcar todos';
    [...grid.children].forEach((n, i) => n.classList.toggle('sel', selected.has(i)));
  };

  items.forEach((it, i) => {
    const cell = el('div', { className: 'g-item', title: `Item ${i + 1}` }, [
      el('span', { className: 'chk', textContent: '✓' }),
      el('span', { className: 'kind', textContent: it.isVideo ? '▶ Vídeo' : 'Foto' }),
    ]);
    if (it.thumb) blobThumb(it.thumb).then((u) => { if (u) cell.style.backgroundImage = `url("${u}")`; });
    cell.onclick = () => { selected.has(i) ? selected.delete(i) : selected.add(i); refresh(); };
    grid.append(cell);
  });
  toggleAll.onclick = () => {
    if (selected.size === items.length) selected.clear(); else items.forEach((_, i) => selected.add(i));
    refresh();
  };
  btn.onclick = async () => {
    btn.disabled = true;
    const base = safeFilename([res.username !== 'directlink' ? res.username : '', res.shortcode].filter(Boolean).join('_') || 'instagram');
    for (const i of [...selected].sort((a, b) => a - b)) {
      const it = items[i];
      const ext = (it.ext || (it.isVideo ? 'mp4' : 'jpg')).replace('jpeg', 'jpg');
      await startJob({ kind: 'direct', url: it.url, ext, title: items.length > 1 ? `${base}_${i + 1}` : base, thumb: it.thumb });
    }
    btn.lastChild.textContent = 'Na fila ✓';
    setTimeout(refresh, 2500);
  };

  box.append(grid, el('div', { className: 'g-actions' }, [toggleAll, el('span', { className: 'spacer' }), btn]));
  refresh();
  return box;
}

async function lookupGallery(url, box) {
  if (!(helper.features || []).includes('gallery')) {
    box.replaceChildren(el('div', { className: 'info-line err', textContent: `Seu ajudante é da versão ${helper.version || 'antiga'}. Para posts do Instagram, rode o instalar.bat da versão 2.1 (ou mais nova).` }));
    return false;
  }
  if (!helper.gallery) {
    box.replaceChildren(el('div', { className: 'info-line err', textContent: 'O ajudante está atualizado, mas o gallery-dl (usado no Instagram) não foi instalado. Rode o instalar.bat mais novo de novo e veja se aparece algum aviso amarelo.' }));
    return false;
  }
  box.replaceChildren(el('div', { className: 'info-line', textContent: 'Carregando o post…' }));
  const r = await send({ cmd: 'helper-gallery', url, withCookies: true });
  if (!r.ok) {
    box.replaceChildren(el('div', { className: 'info-line err', textContent: 'Não consegui carregar: ' + r.error }));
    return false;
  }
  box.replaceChildren(galleryView(r.result, () => { $('helperSection').hidden = true; }));
  return true;
}

async function lookupWithHelper(url, { label } = {}) {
  const box = $('helperResults');
  $('helperSection').hidden = false;
  if (!helper.ok) {
    const how = el('button', { className: 'link-btn', textContent: 'Ver como instalar' });
    how.onclick = openHelperPage;
    box.replaceChildren(el('div', { className: 'info-line err' }, ['Para baixar do YouTube ou buscar por link, instale o ajudante. ', how]));
    return;
  }
  if (INSTAGRAM_RE.test(url)) { await lookupGallery(url, box); return; }
  box.replaceChildren(el('div', { className: 'info-line', textContent: label || 'Buscando o vídeo…' }));
  const r = await send({ cmd: 'helper-info', url });
  if (!r.ok) {
    // não é vídeo? tenta como galeria de fotos (X/Twitter, Pinterest, Reddit…)
    if (helper.gallery && /no video|unsupported url|no media/i.test(r.error || '')) {
      if (await lookupGallery(url, box)) return;
    }
    box.replaceChildren(el('div', { className: 'info-line err', textContent: 'Não encontrei vídeo nesse link: ' + r.error }));
    return;
  }
  box.replaceChildren(helperCard(r.info, { onClose: () => { $('helperSection').hidden = true; } }));
}

let currentWindowId = null;
chrome.windows.getCurrent().then((w) => { currentWindowId = w.id; });
$('openTools').onclick = () => {
  // precisa ser chamado direto no clique (o Chrome exige um gesto do usuário)
  chrome.sidePanel.open({ windowId: currentWindowId })
    .then(() => window.close())
    .catch(() => chrome.tabs.create({ url: chrome.runtime.getURL('ferramentas.html') }));
};

$('linkForm').onsubmit = (e) => {
  e.preventDefault();
  const url = $('linkInput').value.trim();
  if (!/^https?:\/\//i.test(url)) { $('linkInput').focus(); return; }
  lookupWithHelper(url);
};

// =============================================================
//  Vídeos detectados na aba (MP4, HLS, DASH)
// =============================================================
const qualityLabel = (h, fallback) => (h ? h + 'p' : fallback);

async function renderDetected(tab) {
  const key = 'tab_' + tab.id;
  const items = (await chrome.storage.session.get(key))[key] || [];
  const title = safeFilename(tab.title);
  const isYouTube = YOUTUBE_RE.test(tab.url || '');

  if (!items.length) {
    if (isYouTube) { listEl.replaceChildren(); return; }
    const nodes = [el('p', { className: 'empty', textContent: 'Nenhum vídeo detectado nesta página ainda. Dê play no vídeo e abra de novo.' })];
    if (helper.ok && /^https?:/.test(tab.url || '')) {
      const b = el('button', { className: 'go try-helper', textContent: 'Procurar com o ajudante (yt-dlp)' });
      b.onclick = () => { b.remove(); lookupWithHelper(tab.url, { label: 'Procurando vídeos nesta página…' }); };
      nodes.push(b);
    }
    listEl.replaceChildren(...nodes);
    return;
  }

  // Lê os manifestos (HLS/DASH) para descobrir qualidades e esconder os "filhos"
  const parsed = new Map();
  await Promise.all(items.filter((i) => i.kind === 'hls' || i.kind === 'dash').map(async (i) => {
    try {
      const { text, url } = await fetchText(i.url);
      if (i.kind === 'dash') { parsed.set(i.url, parseMPD(text, url)); return; }
      const pl = parseM3U8(text, url);
      if (pl.type === 'master' && pl.variants[0]) {
        try {
          const f = await fetchText(pl.variants[0].url);
          const first = parseM3U8(f.text, f.url);
          pl.duration = first.duration;
          pl.encrypted = first.encrypted;
        } catch {}
      }
      parsed.set(i.url, pl);
    } catch (e) { i.error = e.message; }
  }));

  const children = new Set();
  for (const pl of parsed.values()) {
    if (pl.type === 'master') {
      pl.variants.forEach((v) => children.add(v.url));
      pl.audios.forEach((a) => children.add(a.url));
    }
  }
  const isMain = (i) => ['master', 'dash'].includes(parsed.get(i.url)?.type);
  let visible = items.filter((i) => !children.has(i.url));
  if (visible.some(isMain)) visible = visible.filter((i) => !i.error);
  visible.sort((a, b) => (isMain(a) ? 0 : 1) - (isMain(b) ? 0 : 1) || a.time - b.time);

  const remove = (urls) => () => send({ cmd: 'remove', tabId: tab.id, urls });

  listEl.replaceChildren(...visible.map((item) => {
    const base = { title, thumb: pageThumb, onClose: remove([item.url]) };

    if (item.kind === 'direct') {
      const ext = item.format.toLowerCase().length <= 4 ? item.format.toLowerCase() : 'mp4';
      return card({
        ...base, ext, badge: item.format,
        options: [{ label: 'Original', value: 'orig' }],
        message: item.size ? { text: formatBytes(item.size) } : null,
        onDownload: () => startJob({ kind: 'direct', url: item.url, title, ext, thumb: pageThumb }),
      });
    }

    const pl = parsed.get(item.url);
    const badge = item.kind === 'dash' ? 'DASH' : 'HLS';
    if (item.error || !pl) {
      return card({ ...base, badge, message: { type: 'err', text: 'Não consegui ler o vídeo (' + (item.error || 'erro') + ')' } });
    }

    // ----- DASH -----
    if (pl.type === 'dash') {
      if (pl.encrypted) {
        return card({ ...base, badge, duration: formatDuration(pl.duration), message: { type: 'warn', text: 'Vídeo protegido por DRM: não pode ser baixado.' } });
      }
      const needsMerge = pl.video.length > 0 && pl.audio.length > 0;
      return card({
        ...base, badge, duration: formatDuration(pl.duration),
        options: pl.video.length
          ? pl.video.map((v, i) => ({ label: qualityLabel(v.height, 'Q' + (i + 1)), value: i }))
          : [{ label: 'Áudio', value: 0 }],
        message: needsMerge && !helper.ok ? { type: 'warn', text: 'Sai em 2 arquivos (vídeo e áudio). Com o ajudante sai 1 só.' } : null,
        onDownload: (idx) => {
          const v = pl.video[Number(idx)];
          if (needsMerge && helper.ok) {
            return startJob({ kind: 'helper', url: item.url, quality: String(v?.height || 'best'), title, thumb: pageThumb, useHeaders: true, useTitle: true });
          }
          return startJob({ kind: 'dash', url: item.url, videoIndex: Number(idx), title, thumb: pageThumb });
        },
      });
    }

    // ----- HLS com várias qualidades -----
    if (pl.type === 'master') {
      if (pl.encrypted) {
        return card({ ...base, badge, duration: formatDuration(pl.duration), message: { type: 'warn', text: 'Vídeo criptografado: não suportado.' } });
      }
      return card({
        ...base, badge,
        duration: formatDuration(pl.duration),
        options: pl.variants.map((v, i) => ({ label: qualityLabel(v.height, v.resolution || 'Q' + (i + 1)), value: i })),
        onClose: remove([item.url, ...pl.variants.map((v) => v.url)]),
        onDownload: (idx) => {
          const v = pl.variants[Number(idx)];
          const group = v.audioGroup ? pl.audios.filter((a) => a.groupId === v.audioGroup) : [];
          const audio = group.find((a) => a.isDefault) || group[0];
          if (audio && helper.ok) {
            // áudio separado: o ajudante junta tudo num MP4 só
            return startJob({ kind: 'helper', url: item.url, quality: String(v.height || 'best'), title, thumb: pageThumb, useHeaders: true, useTitle: true });
          }
          return startJob({ kind: 'hls', url: v.url, audio: audio?.url, title, thumb: pageThumb });
        },
      });
    }

    // ----- HLS simples -----
    let message = null;
    if (pl.encrypted) message = { type: 'warn', text: 'Vídeo criptografado: não suportado.' };
    else if (pl.isLive) message = { type: 'warn', text: 'Ao vivo: baixa só o trecho disponível.' };
    return card({
      ...base, badge,
      duration: formatDuration(pl.duration),
      options: [{ label: 'Original', value: 0 }],
      message,
      onDownload: pl.encrypted ? null : () => startJob({ kind: 'hls', url: item.url, title, thumb: pageThumb }),
    });
  }));
  if (!visible.length) empty('Nenhum vídeo detectado nesta página ainda.');
}

// =============================================================
//  Aviso de nova versão (consulta as Releases do GitHub)
// =============================================================
const REPO = 'lumeremarketing-lab/lumere-downloader';
const RELEASES = `https://github.com/${REPO}/releases/latest`;

function newerThan(a, b) {
  const pa = String(a).replace(/^v/i, '').split('.').map(Number);
  const pb = String(b).replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

async function checkUpdate() {
  const current = chrome.runtime.getManifest().version;
  let info = (await chrome.storage.local.get('update')).update;
  if (!info || Date.now() - info.checked > 6 * 3600 * 1000) {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (r.ok) {
        const rel = await r.json();
        info = { checked: Date.now(), tag: rel.tag_name, url: rel.html_url || RELEASES };
        await chrome.storage.local.set({ update: info });
      }
    } catch { /* sem internet: tenta depois */ }
  }
  if (info?.tag && newerThan(info.tag, current)) {
    const bar = $('updateBar');
    bar.href = info.url;
    bar.replaceChildren(el('span', {}, ['Nova versão disponível: ', el('b', { textContent: info.tag })]), el('span', { className: 'go-dl', textContent: 'Ver e baixar →' }));
    bar.hidden = false;
  }
}

// =============================================================
//  Início
// =============================================================
async function main() {
  // (?tab=ID permite abrir o popup numa aba normal para testes)
  const forced = Number(new URLSearchParams(location.search).get('tab'));
  const [tab] = forced
    ? [await chrome.tabs.get(forced)]
    : await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return empty('Nenhuma aba ativa.');

  const thumbP = forced ? Promise.resolve(null) : makeThumbnail(tab);
  helper = await send({ cmd: 'helper-status' }).catch(() => ({ ok: false }));
  renderHelperStatus();

  if (YOUTUBE_RE.test(tab.url || '')) {
    lookupWithHelper(tab.url, { label: 'Vídeo do YouTube detectado. Buscando as qualidades…' });
  }

  pageThumb = await thumbP;
  await renderDetected(tab);
}

main().catch((e) => empty('Erro: ' + e.message));
checkUpdate();
