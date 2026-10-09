// =============================================================
//  Leitor de manifestos DASH (.mpd)
//  Transforma o XML em listas de segmentos para vídeo e áudio.
// =============================================================

function parseIsoDuration(s) {
  if (!s) return 0;
  const m = s.match(/P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

function childrenByTag(node, tag) {
  return node ? [...node.children].filter((c) => c.localName === tag) : [];
}
function firstChild(node, tag) {
  return childrenByTag(node, tag)[0] || null;
}

function resolveBase(node, base) {
  const b = firstChild(node, 'BaseURL');
  return b ? new URL(b.textContent.trim(), base).href : base;
}

function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, name, pad) => {
    let v = String(vars[name]);
    if (pad) v = v.padStart(Number(pad), '0');
    return v;
  }).replace(/\$\$/g, '$');
}

function parseRange(r) {
  if (!r) return null;
  const [a, b] = r.split('-').map(Number);
  return { start: a, end: b };
}

// Monta a lista de segmentos de uma Representation
function buildSegments(rep, as, period, base, totalDuration) {
  const vars = { RepresentationID: rep.getAttribute('id'), Bandwidth: rep.getAttribute('bandwidth') };
  const tpl = firstChild(rep, 'SegmentTemplate') || firstChild(as, 'SegmentTemplate') || firstChild(period, 'SegmentTemplate');
  const list = firstChild(rep, 'SegmentList') || firstChild(as, 'SegmentList');

  if (tpl) {
    const get = (a) => tpl.getAttribute(a) ?? firstChild(as, 'SegmentTemplate')?.getAttribute(a);
    const timescale = Number(get('timescale') || 1);
    const startNumber = Number(get('startNumber') ?? 1);
    const media = get('media');
    const initTpl = get('initialization');
    const init = initTpl ? { url: new URL(fillTemplate(initTpl, vars), base).href } : null;
    const segments = [];
    const timeline = firstChild(tpl, 'SegmentTimeline') || firstChild(firstChild(as, 'SegmentTemplate'), 'SegmentTimeline');
    if (timeline) {
      let t = 0, n = startNumber;
      for (const s of childrenByTag(timeline, 'S')) {
        if (s.hasAttribute('t')) t = Number(s.getAttribute('t'));
        const d = Number(s.getAttribute('d'));
        let r = Number(s.getAttribute('r') || 0);
        if (r < 0) r = Math.max(0, Math.ceil((totalDuration * timescale - t) / d) - 1);
        for (let i = 0; i <= r; i++) {
          segments.push({ url: new URL(fillTemplate(media, { ...vars, Number: n, Time: t }), base).href });
          t += d; n++;
        }
      }
    } else {
      const dur = Number(get('duration'));
      const count = dur ? Math.ceil((totalDuration * timescale) / dur) : 0;
      for (let i = 0; i < count; i++) {
        const n = startNumber + i;
        segments.push({ url: new URL(fillTemplate(media, { ...vars, Number: n, Time: i * dur }), base).href });
      }
    }
    return { init, segments };
  }

  if (list) {
    const initEl = firstChild(list, 'Initialization');
    const init = initEl ? {
      url: new URL(initEl.getAttribute('sourceURL') || '', base).href,
      range: parseRange(initEl.getAttribute('range')),
    } : null;
    const segments = childrenByTag(list, 'SegmentURL').map((s) => ({
      url: new URL(s.getAttribute('media') || '', base).href,
      range: parseRange(s.getAttribute('mediaRange')),
    }));
    return { init, segments };
  }

  // SegmentBase ou arquivo único: baixa o arquivo inteiro
  return { init: null, segments: [{ url: base }] };
}

function parseMPD(text, url) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD') throw new Error('Isso não parece um manifesto DASH válido.');
  const isLive = mpd.getAttribute('type') === 'dynamic';
  const duration = parseIsoDuration(mpd.getAttribute('mediaPresentationDuration'));
  const period = firstChild(mpd, 'Period');
  if (!period) throw new Error('Manifesto DASH sem conteúdo.');
  const periodDur = parseIsoDuration(period.getAttribute('duration')) || duration;

  let base = resolveBase(mpd, url);
  base = resolveBase(period, base);

  const video = [], audio = [];
  let encrypted = false;
  for (const as of childrenByTag(period, 'AdaptationSet')) {
    if (childrenByTag(as, 'ContentProtection').length) encrypted = true;
    const asBase = resolveBase(as, base);
    const asType = as.getAttribute('contentType') || (as.getAttribute('mimeType') || '').split('/')[0];
    for (const rep of childrenByTag(as, 'Representation')) {
      if (childrenByTag(rep, 'ContentProtection').length) encrypted = true;
      const mime = rep.getAttribute('mimeType') || as.getAttribute('mimeType') || '';
      const type = asType || mime.split('/')[0];
      const repBase = resolveBase(rep, asBase);
      const info = {
        id: rep.getAttribute('id'),
        bandwidth: Number(rep.getAttribute('bandwidth') || 0),
        width: Number(rep.getAttribute('width') || as.getAttribute('width') || 0),
        height: Number(rep.getAttribute('height') || as.getAttribute('height') || 0),
        codecs: rep.getAttribute('codecs') || as.getAttribute('codecs') || '',
        lang: as.getAttribute('lang') || '',
        mime,
        ...buildSegments(rep, as, period, repBase, periodDur),
      };
      if (type === 'video') video.push(info);
      else if (type === 'audio') audio.push(info);
    }
  }
  video.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  audio.sort((a, b) => b.bandwidth - a.bandwidth);
  return { type: 'dash', video, audio, encrypted, isLive, duration: periodDur };
}
