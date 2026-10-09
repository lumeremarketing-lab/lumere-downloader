// =============================================================
//  Motor de download (roda num documento "offscreen", invisível)
//  Baixa HLS, DASH e arquivos diretos em segundo plano e avisa o
//  service worker do progresso, para aparecer no popup.
// =============================================================

const CONCURRENCY = 6;
const RETRIES = 4;
const running = new Map(); // jobId -> AbortController

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(type, id, data = {}) {
  chrome.runtime.sendMessage({ target: 'bg', type, id, ...data }).catch(() => {});
}

// avisos de progresso no máximo a cada 300 ms
function makeReporter(id) {
  let last = 0;
  return (percent, text, force) => {
    const now = Date.now();
    if (!force && now - last < 300) return;
    last = now;
    post('job-progress', id, { percent, text });
  };
}

async function fetchBytes(url, range, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const headers = range ? { Range: `bytes=${range.start}-${range.end}` } : {};
      const res = await fetch(url, { credentials: 'include', headers, signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal.aborted || attempt >= RETRIES) throw e;
      await sleep(800 * attempt);
    }
  }
}

async function fetchText(url, signal) {
  const res = await fetch(url, { credentials: 'include', signal });
  if (!res.ok) throw new Error('Não consegui abrir a playlist (HTTP ' + res.status + ')');
  return { text: await res.text(), url: res.url };
}

// Baixa uma lista de segmentos em paralelo, mantendo a ordem
async function downloadSegments(segments, signal, onPiece) {
  const parts = new Array(segments.length);
  let next = 0;
  async function worker() {
    while (next < segments.length) {
      const i = next++;
      parts[i] = await fetchBytes(segments[i].url, segments[i].range, signal);
      onPiece(parts[i].byteLength);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segments.length) }, worker));
  return parts;
}

// Converte pedaços MPEG-TS em MP4 (mux.js)
async function transmux(parts, report) {
  const out = [];
  let gotInit = false;
  const t = new muxjs.mp4.Transmuxer();
  t.on('data', (seg) => {
    if (!gotInit) { out.push(seg.initSegment); gotInit = true; }
    out.push(seg.data);
  });
  for (let i = 0; i < parts.length; i++) {
    t.push(parts[i]);
    t.flush();
    if (i % 20 === 0) { report(96, `Convertendo para MP4… ${Math.round((i / parts.length) * 100)}%`, true); await sleep(0); }
  }
  return gotInit && out.length > 1 ? out : null;
}

const looksLikeTs = (b) => b && b.length > 188 && b[0] === 0x47 && b[188] === 0x47;

// ---------------- preparação das trilhas ----------------
async function hlsTracks(job, signal) {
  let { text, url } = await fetchText(job.url, signal);
  let pl = parseM3U8(text, url);
  let audioUrl = job.audio || null;
  if (pl.type === 'master') {
    const best = pl.variants[0];
    if (!best) throw new Error('Playlist sem qualidades disponíveis.');
    if (!audioUrl && best.audioGroup) {
      const g = pl.audios.filter((a) => a.groupId === best.audioGroup);
      audioUrl = (g.find((a) => a.isDefault) || g[0])?.url;
    }
    ({ text, url } = await fetchText(best.url, signal));
    pl = parseM3U8(text, url);
  }
  const tracks = [{ name: 'video', segments: pl.segments, init: pl.map, duration: pl.duration, encrypted: pl.encrypted }];
  if (audioUrl) {
    const a = await fetchText(audioUrl, signal);
    const apl = parseM3U8(a.text, a.url);
    tracks.push({ name: 'audio', segments: apl.segments, init: apl.map, encrypted: apl.encrypted });
  }
  return tracks;
}

async function dashTracks(job, signal) {
  const { text, url } = await fetchText(job.url, signal);
  const mpd = parseMPD(text, url);
  if (mpd.encrypted) throw new Error('Este vídeo é protegido (DRM) e não pode ser baixado.');
  const v = mpd.video[job.videoIndex || 0];
  const a = mpd.audio[0];
  const tracks = [];
  if (v) tracks.push({ name: 'video', segments: v.segments, init: v.init, duration: mpd.duration });
  if (a) tracks.push({ name: v ? 'audio' : 'video', segments: a.segments, init: a.init, duration: mpd.duration, audioOnly: !v });
  if (!tracks.length) throw new Error('Nenhuma trilha de vídeo encontrada.');
  return tracks;
}

async function buildOutput(track, parts, init, title, report) {
  const suffix = track.name === 'audio' ? ' (audio)' : '';
  if (init) return { parts: [init, ...parts], filename: `${title}${suffix}.mp4`, mime: 'video/mp4' };
  if (looksLikeTs(parts[0])) {
    try {
      const mp4 = await transmux(parts, report);
      if (mp4) return { parts: mp4, filename: `${title}${suffix}.mp4`, mime: 'video/mp4' };
    } catch (e) { console.warn('conversão falhou', e); }
    return { parts, filename: `${title}${suffix}.ts`, mime: 'video/mp2t' };
  }
  // arquivo único (DASH SegmentBase) ou formato desconhecido
  const isMp4 = parts[0] && parts[0].length > 8 && String.fromCharCode(...parts[0].slice(4, 8)) === 'ftyp';
  const ext = isMp4 ? 'mp4' : track.name === 'audio' ? 'aac' : 'ts';
  return { parts, filename: `${title}${suffix}.${ext}`, mime: 'application/octet-stream' };
}

// ---------------- execução de um job ----------------
async function runSegmented(job, signal, report) {
  report(1, 'Lendo a playlist…', true);
  const tracks = job.kind === 'dash' ? await dashTracks(job, signal) : await hlsTracks(job, signal);
  if (tracks.some((t) => t.encrypted)) throw new Error('Este vídeo é criptografado e não é suportado.');

  const total = tracks.reduce((n, t) => n + t.segments.length, 0);
  let done = 0, bytes = 0;
  const start = performance.now();
  const outputs = [];
  for (const t of tracks) {
    const label = t.name === 'audio' ? 'Baixando o áudio' : 'Baixando o vídeo';
    const parts = await downloadSegments(t.segments, signal, (b) => {
      done++; bytes += b;
      const speed = bytes / Math.max((performance.now() - start) / 1000, 0.1);
      report((done / total) * 95, `${label} · ${formatBytes(bytes)} · ${formatBytes(speed)}/s`);
    });
    const init = t.init ? await fetchBytes(t.init.url, t.init.range, signal) : null;
    report(95, 'Montando o arquivo…', true);
    outputs.push(await buildOutput(t, parts, init, job.title, report));
  }
  let note = null;
  if (outputs.length > 1) note = 'Vídeo e áudio vieram separados (2 arquivos). Instale o ajudante para juntar automaticamente.';
  else if (outputs[0].filename.endsWith('.ts')) note = 'Salvo como .ts (abre no VLC).';
  return { outputs, note, bytes };
}

async function runDirect(job, signal, report) {
  report(0, 'Baixando…', true);
  const res = await fetch(job.url, { credentials: 'include', signal });
  if (!res.ok) throw new Error('O servidor recusou o download (HTTP ' + res.status + ')');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let bytes = 0;
  const start = performance.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    bytes += value.byteLength;
    const speed = bytes / Math.max((performance.now() - start) / 1000, 0.1);
    report(total ? (bytes / total) * 98 : 50, `${formatBytes(bytes)}${total ? ' de ' + formatBytes(total) : ''} · ${formatBytes(speed)}/s`);
  }
  const ext = job.ext || 'mp4';
  return { outputs: [{ parts: chunks, filename: `${job.title}.${ext}`, mime: res.headers.get('content-type') || 'video/mp4' }], bytes };
}

async function runJob(job) {
  const controller = new AbortController();
  running.set(job.id, controller);
  const report = makeReporter(job.id);
  try {
    const result = job.kind === 'direct'
      ? await runDirect(job, controller.signal, report)
      : await runSegmented(job, controller.signal, report);
    report(99, 'Salvando…', true);
    const files = result.outputs.map((o) => ({
      blobUrl: URL.createObjectURL(new Blob(o.parts, { type: o.mime })),
      filename: o.filename,
    }));
    post('job-save', job.id, { files, note: result.note || null, bytes: result.bytes });
  } catch (e) {
    if (controller.signal.aborted) post('job-cancelled', job.id);
    else post('job-error', job.id, { error: e.message });
  } finally {
    running.delete(job.id);
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.cmd === 'start') runJob(msg.job);
  if (msg.cmd === 'cancel') running.get(msg.id)?.abort();
  if (msg.cmd === 'revoke') URL.revokeObjectURL(msg.blobUrl);
});
