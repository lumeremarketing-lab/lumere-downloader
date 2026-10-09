// =============================================================
//  Conexão direta com o ajudante do Windows (ffmpeg)
//  Usada pelas ferramentas de vídeo e áudio.
// =============================================================
import { inExtension } from './common.js';

const HOST = 'com.meuvideo.downloader';
const CHUNK = 4 * 1024 * 1024; // 4 MB por mensagem

let port = null;
let ridSeq = 0;
const pending = new Map();
const jobListeners = new Map();

function connect() {
  if (port) return port;
  if (!inExtension() || !chrome.runtime.connectNative) throw new Error('Disponível só na extensão, com o ajudante instalado.');
  port = chrome.runtime.connectNative(HOST);
  port.onMessage.addListener((m) => {
    if (m.type === 'reply') {
      const p = pending.get(m.rid);
      if (!p) return;
      pending.delete(m.rid);
      m.ok ? p.resolve(m) : p.reject(new Error(m.error || 'Erro no ajudante.'));
      return;
    }
    jobListeners.get(m.job)?.(m);
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || 'O ajudante foi fechado.';
    const msg = /not found/i.test(err) ? 'Ajudante não instalado.' : err;
    port = null;
    for (const p of pending.values()) p.reject(new Error(msg));
    pending.clear();
    for (const fn of jobListeners.values()) fn({ type: 'error', error: msg });
    jobListeners.clear();
  });
  return port;
}

export function call(cmd, data = {}, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const rid = String(++ridSeq);
    pending.set(rid, { resolve, reject });
    try { connect().postMessage({ cmd, rid, ...data }); }
    catch (e) { pending.delete(rid); return reject(e); }
    setTimeout(() => { if (pending.delete(rid)) reject(new Error('O ajudante não respondeu.')); }, timeout);
  });
}

let statusCache = null;
export async function helperStatus() {
  if (statusCache) return statusCache;
  try {
    const r = await call('ping', {}, 15000);
    statusCache = { ok: true, ffmpeg: !!r.ffmpeg, media: (r.features || []).includes('media'), version: r.version };
  } catch (e) {
    statusCache = { ok: false, error: e.message };
  }
  return statusCache;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// Envia o arquivo para o ajudante em partes; devolve o "token" do arquivo temporário
export async function upload(file, onProgress, signal) {
  const { token } = await call('upload-begin', { name: file.name });
  try {
    for (let off = 0; off < file.size; off += CHUNK) {
      if (signal?.aborted) throw new Error('Cancelado');
      const bytes = new Uint8Array(await file.slice(off, off + CHUNK).arrayBuffer());
      await call('upload-chunk', { token, data: toBase64(bytes) });
      onProgress?.(Math.min(1, (off + CHUNK) / file.size));
    }
  } catch (e) {
    call('upload-cancel', { token }).catch(() => {});
    throw e;
  }
  return token;
}

// Roda uma operação do ffmpeg e acompanha o progresso
export function runMedia({ token, op, params, outName }, onProgress) {
  const job = 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const result = new Promise((resolve, reject) => {
    jobListeners.set(job, (m) => {
      if (m.type === 'progress') onProgress?.(m.percent || 0);
      else if (m.type === 'done') { jobListeners.delete(job); resolve(m); }
      else if (m.type === 'error') { jobListeners.delete(job); reject(new Error(m.error)); }
      else if (m.type === 'cancelled') { jobListeners.delete(job); reject(new Error('Cancelado')); }
    });
  });
  const started = call('media', { job, token, op, params, outName }).catch((e) => { jobListeners.delete(job); throw e; });
  return { job, started, result, cancel: () => call('cancel', { job }).catch(() => {}) };
}

export const showInFolder = (path) => call('show', { path }).catch(() => {});
