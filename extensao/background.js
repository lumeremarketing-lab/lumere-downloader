// =============================================================
//  Lumere Downloader - service worker (roda em segundo plano)
//  Observa as requisições de rede de cada aba e guarda os vídeos
//  encontrados. O popup lê essa lista e oferece o download.
// =============================================================

const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'mkv', 'm4v', 'flv', 'ogv', '3gp', 'avi'];
const HLS_TYPES = ['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl'];
// Pedaços de stream (não são vídeos completos, então ignoramos)
const SEGMENT_TYPES = ['video/mp2t', 'video/iso.segment'];
const SEGMENT_EXTS = ['ts', 'm4s', 'aac', 'm4a'];
const DASH_TYPES = ['application/dash+xml'];
// O YouTube usa um formato próprio: ele é tratado pelo ajudante (yt-dlp),
// então ignoramos o tráfego de vídeo dele aqui.
const IGNORED_HOSTS = ['googlevideo.com', 'youtube.com'];
const MIN_SIZE = 300 * 1024; // ignora arquivos menores que 300 KB (anúncios, prévias)
const MAX_PER_TAB = 50;

importScripts('m3u8.js'); // safeFilename, startDownload

// ---------- armazenamento por aba ----------
const cache = new Map();          // tabId -> array de vídeos
const locks = new Map();          // tabId -> Promise (evita escrita concorrente)

async function getList(tabId) {
  if (cache.has(tabId)) return cache.get(tabId);
  const key = 'tab_' + tabId;
  const data = await chrome.storage.session.get(key);
  const list = data[key] || [];
  cache.set(tabId, list);
  return list;
}

function withLock(tabId, fn) {
  const prev = locks.get(tabId) || Promise.resolve();
  const next = prev.then(fn).catch((e) => console.warn(e));
  locks.set(tabId, next);
  return next;
}

async function saveList(tabId, list) {
  cache.set(tabId, list);
  await chrome.storage.session.set({ ['tab_' + tabId]: list });
  updateBadge(tabId, list.length);
}

function updateBadge(tabId, count) {
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#e8453c' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

function clearTab(tabId) {
  return withLock(tabId, async () => {
    cache.set(tabId, []);
    await chrome.storage.session.remove('tab_' + tabId);
    updateBadge(tabId, 0);
  });
}

// ---------- utilidades ----------
function header(headers, name) {
  const h = (headers || []).find((x) => x.name.toLowerCase() === name);
  return h ? h.value : '';
}

function getExt(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    const m = path.match(/\.([a-z0-9]{2,5})$/);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function totalSize(headers) {
  // Em requisições parciais (206) o tamanho real vem em Content-Range: bytes 0-1/123456
  const range = header(headers, 'content-range');
  const m = range.match(/\/(\d+)\s*$/);
  if (m) return Number(m[1]);
  const len = Number(header(headers, 'content-length'));
  return Number.isFinite(len) && len > 0 ? len : 0;
}

function classify(details) {
  let host = '';
  try { host = new URL(details.url).hostname; } catch { return null; }
  if (IGNORED_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return null;

  const ct = header(details.responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  const ext = getExt(details.url);

  if (ext === 'm3u8' || HLS_TYPES.includes(ct)) {
    return { kind: 'hls', format: 'HLS', size: 0 };
  }
  if (ext === 'mpd' || DASH_TYPES.includes(ct)) {
    return { kind: 'dash', format: 'DASH', size: 0 };
  }
  if (SEGMENT_TYPES.includes(ct) || SEGMENT_EXTS.includes(ext)) return null;

  if (ct.startsWith('video/') || VIDEO_EXTS.includes(ext)) {
    const size = totalSize(details.responseHeaders);
    if (size && size < MIN_SIZE) return null;
    const format = (VIDEO_EXTS.includes(ext) ? ext : ct.replace('video/', '').replace('x-', '')).toUpperCase();
    return { kind: 'direct', format: format || 'VIDEO', size };
  }
  return null;
}

// ---------- ouvintes de rede ----------

// Página nova carregando na aba -> limpa a lista antiga
chrome.webRequest.onBeforeRequest.addListener(
  (details) => { if (details.tabId >= 0) clearTab(details.tabId); },
  { urls: ['<all_urls>'], types: ['main_frame'] }
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0 || isOwnRequest(details)) return;
    if (details.statusCode !== 200 && details.statusCode !== 206) return;
    const info = classify(details);
    if (!info) return;

    withLock(details.tabId, async () => {
      const list = [...(await getList(details.tabId))];
      const existing = list.find((v) => v.url === details.url);
      if (existing) {
        if (!existing.size && info.size) {
          existing.size = info.size;
          await saveList(details.tabId, list);
        }
        return;
      }
      if (list.length >= MAX_PER_TAB) return;
      list.push({ url: details.url, ...info, time: Date.now() });
      await saveList(details.tabId, list);
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

// =============================================================
//  Cabeçalhos "de permissão" (Referer, Origin, tokens)
//  Muitos sites respondem 403 se o pedido não vier "de dentro" da
//  página. Aqui copiamos os cabeçalhos que o próprio player usou e
//  aplicamos aos downloads feitos pela extensão (regras DNR).
// =============================================================
const KEEP_HEADERS = ['referer', 'origin', 'authorization'];
const MEDIA_EXTS = [...VIDEO_EXTS, 'm3u8', 'mpd', 'ts', 'm4s', 'aac', 'm4a', 'key'];
const hostHeaders = new Map();      // host -> { Referer, Origin, ... } (para o ajudante)
const pendingHeaders = new Map();   // requestId -> cabeçalhos capturados
const lastSignature = new Map();    // host -> assinatura dos cabeçalhos aplicados
let ruleLock = Promise.resolve();

function isOwnRequest(d) {
  return (d.initiator || '').startsWith('chrome-extension://');
}

function looksLikeMedia(d) {
  if (d.type === 'media') return true;
  return MEDIA_EXTS.includes(getExt(d.url));
}

function applyHeaderRule(host, headers) {
  const sig = JSON.stringify(headers);
  const plain = {};
  for (const h of headers) if (h.operation === 'set') plain[h.header.replace(/(^|-)\w/g, (c) => c.toUpperCase())] = h.value;
  hostHeaders.set(host, plain);
  if (lastSignature.get(host) === sig) return;
  lastSignature.set(host, sig);
  chrome.storage.session.set({ ['hh_' + host]: plain });
  ruleLock = ruleLock.then(async () => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const old = rules.filter((r) => r.condition.requestDomains?.[0] === host).map((r) => r.id);
    const maxId = rules.reduce((m, r) => Math.max(m, r.id), 0);
    const action = { type: 'modifyHeaders', requestHeaders: headers };
    const types = ['xmlhttprequest', 'media', 'other'];
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: old,
      addRules: [
        // pedidos feitos pelas páginas da extensão (popup / tela de download)
        { id: maxId + 1, priority: 1, action,
          condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id], resourceTypes: types } },
        // downloads diretos (chrome.downloads não tem aba nem "initiator")
        { id: maxId + 2, priority: 1, action,
          condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: types } },
      ],
    });
  }).catch((e) => console.warn('regra de cabeçalho falhou', e));
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0 || isOwnRequest(details)) return;
    const headers = [];
    for (const h of details.requestHeaders || []) {
      const n = h.name.toLowerCase();
      if (KEEP_HEADERS.includes(n) || n.startsWith('x-')) {
        headers.push({ header: n, operation: 'set', value: h.value });
      }
    }
    // Se a página não mandou Origin, removemos o "chrome-extension://" que o Chrome colocaria
    if (!headers.some((h) => h.header === 'origin')) headers.push({ header: 'origin', operation: 'remove' });
    pendingHeaders.set(details.requestId, headers);
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = pendingHeaders.get(details.requestId);
    pendingHeaders.delete(details.requestId);
    if (!headers || details.statusCode >= 400) return;
    const ct = header(details.responseHeaders, 'content-type').toLowerCase();
    const media = looksLikeMedia(details) || ct.startsWith('video/') || ct.includes('mpegurl');
    if (!media) return;
    try { applyHeaderRule(new URL(details.url).hostname, headers); } catch {}
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => pendingHeaders.delete(details.requestId),
  { urls: ['<all_urls>'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  cache.delete(tabId);
  locks.delete(tabId);
  chrome.storage.session.remove('tab_' + tabId);
});

async function getHostHeaders(url) {
  let host;
  try { host = new URL(url).hostname; } catch { return {}; }
  if (hostHeaders.has(host)) return hostHeaders.get(host);
  const saved = (await chrome.storage.session.get('hh_' + host))['hh_' + host];
  return saved || {};
}

// =============================================================
//  Fila de downloads (aparece no popup com barra de progresso)
// =============================================================
const jobs = new Map();
let jobsLoaded = null;
let saveTimer = null;

function loadJobs() {
  if (!jobsLoaded) {
    jobsLoaded = chrome.storage.session.get('jobs').then((d) => {
      for (const j of d.jobs || []) jobs.set(j.id, j);
    });
  }
  return jobsLoaded;
}

function persistJobs(now) {
  clearTimeout(saveTimer);
  const write = () => chrome.storage.session.set({ jobs: [...jobs.values()] });
  if (now) return write();
  saveTimer = setTimeout(write, 250);
}

async function updateJob(id, patch, now) {
  await loadJobs();
  const j = jobs.get(id);
  if (!j) return null;
  Object.assign(j, patch);
  persistJobs(now || ['done', 'error', 'cancelled'].includes(patch.status));
  return j;
}

function newJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

async function startJob(spec) {
  await loadJobs();
  const job = {
    id: newJobId(),
    kind: spec.kind,
    title: spec.title || 'video',
    thumb: spec.thumb || null,
    status: 'running',
    percent: 0,
    text: 'Iniciando…',
    time: Date.now(),
    downloadIds: [],
  };
  jobs.set(job.id, job);
  persistJobs(true);

  try {
    if (spec.kind === 'helper') await startHelperJob(job, spec);
    else if (spec.kind === 'direct') await startNativeDirect(job, spec);
    else await startOffscreenJob(job, spec);
  } catch (e) {
    await updateJob(job.id, { status: 'error', error: e.message });
  }
  return job.id;
}

// ---------- documento offscreen (HLS / DASH / direto com cabeçalhos) ----------
let creatingOffscreen = null;
async function ensureOffscreen() {
  const has = chrome.offscreen.hasDocument
    ? await chrome.offscreen.hasDocument()
    : (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0;
  if (has) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Juntar os pedaços do vídeo e gerar o arquivo final',
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function startOffscreenJob(job, spec) {
  job.via = 'offscreen';
  await ensureOffscreen();
  await chrome.runtime.sendMessage({
    target: 'offscreen', cmd: 'start',
    job: { id: job.id, kind: spec.kind, url: spec.url, audio: spec.audio, title: safeFilename(job.title), videoIndex: spec.videoIndex, ext: spec.ext },
  });
}

const blobByDownload = new Map(); // downloadId -> blobUrl

async function onOffscreenMessage(msg) {
  const { id } = msg;
  if (msg.type === 'job-progress') {
    await updateJob(id, { percent: msg.percent, text: msg.text });
  } else if (msg.type === 'job-error') {
    await updateJob(id, { status: 'error', error: msg.error });
  } else if (msg.type === 'job-cancelled') {
    await updateJob(id, { status: 'cancelled', text: 'Cancelado' });
  } else if (msg.type === 'job-save') {
    const ids = [];
    for (const f of msg.files) {
      const dlId = await startDownload(f.blobUrl, f.filename);
      blobByDownload.set(dlId, f.blobUrl);
      ids.push(dlId);
    }
    await updateJob(id, {
      status: 'done', percent: 100, downloadIds: ids, note: msg.note,
      text: 'Pronto · ' + formatBytes(msg.bytes || 0),
    });
  }
}

// ---------- download direto nativo do Chrome ----------
async function startNativeDirect(job, spec) {
  job.via = 'native';
  job.spec = { url: spec.url, ext: spec.ext, title: spec.title };
  try {
    const dlId = await startDownload(spec.url, `${safeFilename(spec.title)}.${spec.ext || 'mp4'}`);
    await updateJob(job.id, { downloadIds: [dlId], text: 'Baixando…' }, true);
    pollNative();
  } catch {
    await startOffscreenJob(job, spec); // se o Chrome recusar, tenta pelo motor
  }
}

let pollTimer = null;
function pollNative() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const active = [...jobs.values()].filter((j) => j.via === 'native' && j.status === 'running');
    if (!active.length) { clearInterval(pollTimer); pollTimer = null; return; }
    for (const j of active) {
      const [d] = await chrome.downloads.search({ id: j.downloadIds[0] });
      if (!d || d.state !== 'in_progress') continue;
      const pct = d.totalBytes > 0 ? (d.bytesReceived / d.totalBytes) * 100 : 50;
      await updateJob(j.id, { percent: pct, text: `${formatBytes(d.bytesReceived)}${d.totalBytes > 0 ? ' de ' + formatBytes(d.totalBytes) : ''}` });
    }
  }, 700);
}

chrome.downloads.onChanged.addListener(async (d) => {
  if (!d.state) return;
  if (d.state.current !== 'in_progress' && blobByDownload.has(d.id)) {
    chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'revoke', blobUrl: blobByDownload.get(d.id) }).catch(() => {});
    blobByDownload.delete(d.id);
  }
  await loadJobs();
  const job = [...jobs.values()].find((j) => j.via === 'native' && j.downloadIds[0] === d.id && j.status === 'running');
  if (!job) return;
  if (d.state.current === 'complete') {
    const [item] = await chrome.downloads.search({ id: d.id });
    await updateJob(job.id, { status: 'done', percent: 100, text: 'Pronto · ' + formatBytes(item?.fileSize || 0) });
  } else if (d.state.current === 'interrupted') {
    const [item] = await chrome.downloads.search({ id: d.id });
    if (item?.error === 'USER_CANCELED') return updateJob(job.id, { status: 'cancelled', text: 'Cancelado' });
    chrome.downloads.erase({ id: d.id });
    await updateJob(job.id, { text: 'Tentando de outro jeito…', downloadIds: [] }, true);
    await startOffscreenJob(job, { kind: 'direct', ...job.spec }); // servidor recusou: refaz com os cabeçalhos da página
  }
});

// =============================================================
//  Ajudante do Windows (yt-dlp) via "native messaging"
// =============================================================
const HELPER = 'com.meuvideo.downloader';
let port = null;
let ridSeq = 0;
const pending = new Map();
let idleTimer = null;
let helperCache = null; // { at, status }

function helperPort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HELPER);
  port.onMessage.addListener(onHelperMessage);
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || 'O ajudante foi fechado.';
    port = null;
    for (const p of pending.values()) p.reject(new Error(translateHelperError(err)));
    pending.clear();
    for (const j of jobs.values()) {
      if (j.via === 'helper' && j.status === 'running') updateJob(j.id, { status: 'error', error: 'O ajudante parou: ' + translateHelperError(err) });
    }
  });
  return port;
}

function translateHelperError(msg) {
  if (/not found/i.test(msg)) return 'Ajudante não instalado.';
  if (/forbidden/i.test(msg)) return 'O ajudante não reconhece esta extensão (reinstale o ajudante).';
  if (/exited|native host has exited/i.test(msg)) return 'O ajudante fechou inesperadamente.';
  return msg;
}

function scheduleIdleDisconnect() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const busy = pending.size || [...jobs.values()].some((j) => j.via === 'helper' && j.status === 'running');
    if (busy) return scheduleIdleDisconnect();
    if (port) { port.disconnect(); port = null; }
  }, 60000);
}

function helperCall(cmd, data = {}, timeout = 180000) {
  return new Promise((resolve, reject) => {
    const rid = String(++ridSeq);
    pending.set(rid, { resolve, reject });
    try {
      helperPort().postMessage({ cmd, rid, ...data });
    } catch (e) {
      pending.delete(rid);
      return reject(new Error(translateHelperError(e.message)));
    }
    setTimeout(() => {
      if (pending.delete(rid)) reject(new Error('O ajudante demorou demais para responder.'));
    }, timeout);
    scheduleIdleDisconnect();
  });
}

async function helperStatus(force) {
  if (!force && helperCache && Date.now() - helperCache.at < 30000) return helperCache.status;
  let status;
  try {
    const r = await helperCall('ping', {}, 15000);
    status = { ok: true, version: r.version, ytdlp: r.ytdlp, features: r.features || [], gallery: !!r.gallery, ffmpeg: !!r.ffmpeg };
  } catch (e) {
    status = { ok: false, error: e.message };
  }
  helperCache = { at: Date.now(), status };
  return status;
}

function onHelperMessage(m) {
  if (m.type === 'reply') {
    const p = pending.get(m.rid);
    if (!p) return;
    pending.delete(m.rid);
    return m.ok ? p.resolve(m) : p.reject(new Error(m.error || 'Erro no ajudante.'));
  }
  const id = m.job;
  if (m.type === 'progress') {
    const label = m.part > 1 ? `Parte ${m.part}` : 'Baixando';
    updateJob(id, { percent: Math.min(m.percent || 0, 99), text: `${label} · ${m.speed || ''}${m.eta && m.eta !== 'Unknown' ? ' · falta ' + m.eta : ''}` });
  } else if (m.type === 'status') {
    updateJob(id, { text: m.text, percent: 99 });
  } else if (m.type === 'done') {
    updateJob(id, { status: 'done', percent: 100, file: m.file, text: 'Pronto' });
  } else if (m.type === 'error') {
    updateJob(id, { status: 'error', error: m.error });
  } else if (m.type === 'cancelled') {
    updateJob(id, { status: 'cancelled', text: 'Cancelado' });
  }
}

async function startHelperJob(job, spec) {
  job.via = 'helper';
  const headers = spec.useHeaders ? await getHostHeaders(spec.url) : undefined;
  await helperCall('download', {
    job: job.id,
    url: spec.url,
    quality: spec.quality || 'best',
    filename: spec.useTitle ? safeFilename(job.title) : undefined,
    headers,
  });
  await updateJob(job.id, { text: 'Preparando…' }, true);
}

// =============================================================
//  Mensagens do popup e do motor offscreen
// =============================================================
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'bg') { onOffscreenMessage(msg); return; }
  if (msg.target === 'offscreen') return;

  const handle = async () => {
    switch (msg.cmd) {
      case 'remove': {
        await withLock(msg.tabId, async () => {
          const list = (await getList(msg.tabId)).filter((v) => !msg.urls.includes(v.url));
          await saveList(msg.tabId, list);
        });
        return { ok: true };
      }
      case 'start':
        return { ok: true, id: await startJob(msg.spec) };
      case 'cancel': {
        await loadJobs();
        const j = jobs.get(msg.id);
        if (!j || j.status !== 'running') return { ok: true };
        if (j.via === 'helper') await helperCall('cancel', { job: j.id }).catch(() => {});
        else if (j.via === 'native' && j.downloadIds[0] != null) chrome.downloads.cancel(j.downloadIds[0]);
        else chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'cancel', id: j.id }).catch(() => {});
        return { ok: true };
      }
      case 'clear': {
        await loadJobs();
        for (const [id, j] of jobs) if (j.status !== 'running' && (!msg.id || msg.id === id)) jobs.delete(id);
        await persistJobs(true);
        return { ok: true };
      }
      case 'show': {
        await loadJobs();
        const j = jobs.get(msg.id);
        if (!j) return { ok: false };
        if (j.file) await helperCall('show', { path: j.file }).catch(() => {});
        else if (j.downloadIds[0] != null) chrome.downloads.show(j.downloadIds[0]);
        return { ok: true };
      }
      case 'helper-status':
        return helperStatus(msg.force);
      case 'helper-info': {
        const r = await helperCall('info', { url: msg.url, headers: msg.useHeaders ? await getHostHeaders(msg.url) : undefined });
        return { ok: true, info: r };
      }
      case 'helper-gallery': {
        const cookies = msg.withCookies ? await cookiesFor(msg.url) : null;
        const r = await helperCall('gallery', { url: msg.url, cookies }, 180000);
        return { ok: true, result: r };
      }
      case 'helper-update': {
        const r = await helperCall('update', {}, 300000);
        helperCache = null;
        return { ok: true, output: r.output };
      }
    }
    return { ok: false, error: 'comando desconhecido' };
  };
  handle().then(reply, (e) => reply({ ok: false, error: e.message }));
  return true;
});

// =============================================================
//  Instagram e galerias de imagens (gallery-dl no ajudante)
//  Os cookies do Instagram vão só para o ajudante, no seu PC,
//  e o arquivo temporário é apagado logo depois.
// =============================================================
async function cookiesFor(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
  const base = host.split('.').slice(-2).join('.');
  const list = await chrome.cookies.getAll({ domain: base });
  if (!list.length) return null;
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of list) {
    const domain = c.hostOnly ? c.domain : (c.domain.startsWith('.') ? c.domain : '.' + c.domain);
    lines.push([domain, c.hostOnly ? 'FALSE' : 'TRUE', c.path, c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate || 0), c.name, c.value].join('\t'));
  }
  return lines.join('\n') + '\n';
}
