// =============================================================
//  Leitor simples de playlists HLS (.m3u8)
//  - "master": lista de qualidades (1080p, 720p...) -> variants
//  - "media":  lista de pedaços (segmentos) do vídeo -> segments
// =============================================================

function parseAttrs(str) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function resolveUrl(u, base) {
  try { return new URL(u, base).href; } catch { return u; }
}

function parseByterange(str, lastEnd) {
  // formato: tamanho[@inicio]
  const [len, off] = str.split('@');
  const start = off !== undefined ? Number(off) : lastEnd;
  return { start, end: start + Number(len) - 1 };
}

function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || !lines[0].startsWith('#EXTM3U')) {
    throw new Error('Isso não parece uma playlist HLS válida.');
  }

  // ----- playlist MASTER (qualidades) -----
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variants = [];
    const audios = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = parseAttrs(line.slice(18));
        let j = i + 1;
        while (j < lines.length && lines[j].startsWith('#')) j++;
        if (j < lines.length) {
          const res = a.RESOLUTION || '';
          variants.push({
            url: resolveUrl(lines[j], baseUrl),
            bandwidth: Number(a.BANDWIDTH || a['AVERAGE-BANDWIDTH'] || 0),
            resolution: res,
            height: res ? Number(res.split('x')[1]) : 0,
            audioGroup: a.AUDIO || '',
          });
        }
      } else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(line.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) {
          audios.push({
            groupId: a['GROUP-ID'],
            name: a.NAME || a.LANGUAGE || 'áudio',
            isDefault: a.DEFAULT === 'YES',
            url: resolveUrl(a.URI, baseUrl),
          });
        }
      }
    }
    // melhor qualidade primeiro
    variants.sort((x, y) => (y.height - x.height) || (y.bandwidth - x.bandwidth));
    return { type: 'master', variants, audios };
  }

  // ----- playlist MEDIA (segmentos) -----
  const segments = [];
  let map = null;
  let encrypted = false;
  let duration = 0;
  let pendingRange = null;
  let lastEnd = 0;
  let segDur = 0;

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      segDur = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = parseByterange(line.slice(17), lastEnd);
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      if (a.METHOD && a.METHOD !== 'NONE') encrypted = true;
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      map = { url: resolveUrl(a.URI, baseUrl) };
      if (a.BYTERANGE) map.range = parseByterange(a.BYTERANGE, 0);
    } else if (!line.startsWith('#')) {
      const seg = { url: resolveUrl(line, baseUrl) };
      if (pendingRange) {
        seg.range = pendingRange;
        lastEnd = pendingRange.end + 1;
        pendingRange = null;
      }
      segments.push(seg);
      duration += segDur;
      segDur = 0;
    }
  }
  const isLive = !text.includes('#EXT-X-ENDLIST');
  return { type: 'media', segments, map, encrypted, duration, isLive };
}

function formatBytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i >= 2 ? 1 : 0) + ' ' + u[i];
}

function formatDuration(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function safeFilename(name) {
  return (name || 'video')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

// Inicia o download; se o Chrome recusar o nome (acontece com acentos em
// alguns sistemas), tenta de novo com um nome só com letras simples.
async function startDownload(url, filename) {
  const dot = filename.lastIndexOf('.');
  const base = filename.slice(0, dot), ext = filename.slice(dot);
  const ascii = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '').trim() || 'video';
  const tries = [filename, ascii + ext, 'video' + ext];
  let lastErr;
  for (const name of tries) {
    try {
      return await chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify' });
    } catch (e) {
      lastErr = e;
      if (!/filename/i.test(e.message)) throw e;
    }
  }
  throw lastErr;
}
