// =============================================================
//  Ferramentas de imagem (tudo no navegador, nada é enviado)
// =============================================================
import { el, opt, selectEl, segmented, rangeEl, numberEl, checkEl, baseName, extOf, formatBytes, savings } from './common.js';
import { batchTool } from './batch.js';

const ACCEPT = 'image/*,.heic,.heif';
const isHeic = (f) => /hei[cf]/i.test(f.type) || /\.(heic|heif)$/i.test(f.name);
const thumbFor = (f) => (isHeic(f) ? null : URL.createObjectURL(f));

let heicModule = null;
async function decode(file) {
  let blob = file;
  if (isHeic(file)) {
    heicModule ||= await import('../lib/heic-to.js');
    blob = await heicModule.heicTo({ blob: file, type: 'image/png' });
  }
  try {
    return await createImageBitmap(blob);
  } catch {
    throw new Error('Formato de imagem não suportado.');
  }
}

function canvasOf(w, h) {
  const c = new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
  return [c, c.getContext('2d')];
}

const MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

async function encode(canvas, fmt, quality = 0.9, smartPng = false) {
  if (fmt === 'png' && smartPng) {
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const buf = UPNG.encode([data.buffer], canvas.width, canvas.height, 256);
    return new Blob([buf], { type: 'image/png' });
  }
  return canvas.convertToBlob({ type: MIME[fmt], quality: fmt === 'png' ? undefined : quality });
}

// desenha a imagem, com fundo (para JPG não ficar com fundo preto)
function draw(bmp, w, h, fmt, bg = '#ffffff') {
  const [c, ctx] = canvasOf(w, h);
  if (fmt === 'jpg') { ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return c;
}

function fitWithin(w, h, max) {
  if (!max || (w <= max && h <= max)) return [w, h];
  const s = max / Math.max(w, h);
  return [Math.round(w * s), Math.round(h * s)];
}

const outExt = (fmt, file) => (fmt === 'same' ? (['png', 'webp'].includes(extOf(file.name)) ? extOf(file.name) : 'jpg') : fmt);

// ---------------------------------------------------------------
export const convert = {
  id: 'img-convert', cat: 'img', icon: '⇄', name: 'Converter imagem',
  desc: 'PNG, JPG, WebP e fotos do iPhone (HEIC) para JPG, PNG ou WebP.',
  render(view) {
    batchTool(view, {
      accept: ACCEPT, title: 'Arraste as imagens aqui', hint: 'PNG, JPG, WebP, GIF, BMP, HEIC… Também dá para colar (Ctrl+V).',
      thumb: thumbFor, actionLabel: 'Converter', zipName: 'imagens-convertidas.zip',
      options(box) {
        const fmt = segmented([['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP']], 'jpg', (v) => { q.node.parentElement.hidden = v === 'png'; bgOpt.hidden = v !== 'jpg'; });
        const q = rangeEl(40, 100, 1, 92, (v) => v + '%');
        const bg = el('input', { type: 'color', value: '#ffffff' });
        const bgOpt = opt('Fundo (onde for transparente)', bg);
        box.append(opt('Converter para', fmt.node), opt('Qualidade', q.node), bgOpt);
        return () => ({ fmt: fmt.value, quality: q.value / 100, bg: bg.value });
      },
      async process(file, o) {
        const bmp = await decode(file);
        const c = draw(bmp, bmp.width, bmp.height, o.fmt, o.bg);
        const blob = await encode(c, o.fmt, o.quality);
        return { outputs: [{ name: `${baseName(file.name)}.${o.fmt}`, blob }], summary: `${bmp.width}×${bmp.height} · ${formatBytes(file.size)} → ${formatBytes(blob.size)}` };
      },
    });
  },
};

// ---------------------------------------------------------------
export const compress = {
  id: 'img-compress', cat: 'img', icon: '🗜', name: 'Comprimir imagem',
  desc: 'Deixa fotos e PNGs bem mais leves, estilo TinyPNG, mostrando quanto economizou.',
  render(view) {
    const compare = el('div', { className: 'compare', hidden: true });
    batchTool(view, {
      accept: ACCEPT, title: 'Arraste as imagens para comprimir', hint: 'Dica: WebP costuma ficar 30% menor que JPG com a mesma qualidade.',
      thumb: thumbFor, actionLabel: 'Comprimir', zipName: 'imagens-comprimidas.zip', concurrency: 2,
      options(box) {
        const q = rangeEl(30, 95, 1, 75, (v) => v + '%');
        const fmt = selectEl([['same', 'Manter o formato'], ['jpg', 'JPG'], ['webp', 'WebP (menor)'], ['png', 'PNG']], 'same');
        const max = selectEl([['0', 'Não redimensionar'], ['3840', 'Até 3840 px (4K)'], ['2560', 'Até 2560 px'], ['1920', 'Até 1920 px (Full HD)'], ['1280', 'Até 1280 px'], ['1080', 'Até 1080 px (redes sociais)']], '0');
        const smart = checkEl('PNG inteligente (reduz as cores, quase sem diferença visível)', true);
        box.append(opt('Qualidade', q.node), opt('Formato', fmt), opt('Tamanho máximo', max), smart.node);
        return () => ({ quality: q.value / 100, fmt: fmt.value, max: Number(max.value), smart: smart.value });
      },
      async process(file, o, row) {
        const bmp = await decode(file);
        const fmt = outExt(o.fmt, file);
        const [w, h] = fitWithin(bmp.width, bmp.height, o.max);
        const c = draw(bmp, w, h, fmt);
        let blob = await encode(c, fmt, o.quality, o.smart);
        let note = '';
        const sameFormat = fmt === extOf(file.name).replace('jpeg', 'jpg');
        if (blob.size >= file.size && sameFormat && w === bmp.width && !isHeic(file)) {
          blob = file; // não ficou menor: mantém o original
          note = ' · já estava otimizada';
        }
        // mostra antes/depois da primeira imagem
        if (compare.hidden) {
          compare.hidden = false;
          compare.replaceChildren(
            el('figure', {}, [el('img', { src: thumbFor(file) || URL.createObjectURL(blob) }), el('figcaption', { textContent: `Antes · ${formatBytes(file.size)}` })]),
            el('figure', {}, [el('img', { src: URL.createObjectURL(blob) }), el('figcaption', { textContent: `Depois · ${formatBytes(blob.size)}` })]),
          );
        }
        return {
          outputs: [{ name: `${baseName(file.name)}.${fmt}`, blob }],
          summary: `${formatBytes(file.size)} → ${formatBytes(blob.size)} ${savings(file.size, blob.size)}${note}`,
        };
      },
      onFilesChanged: (files) => { if (!files.length) { compare.hidden = true; compare.replaceChildren(); } },
    });
    view.append(compare);
  },
};

// ---------------------------------------------------------------
const PRESETS = [
  ['ig-feed', 'Instagram quadrado', 1080, 1080],
  ['ig-portrait', 'Instagram retrato', 1080, 1350],
  ['stories', 'Stories / Reels / TikTok', 1080, 1920],
  ['yt-thumb', 'Miniatura do YouTube', 1280, 720],
  ['fb-cover', 'Capa do Facebook', 1640, 624],
  ['linkedin', 'Post do LinkedIn', 1200, 627],
  ['x-post', 'Post do X (Twitter)', 1600, 900],
  ['wa-profile', 'Foto de perfil', 800, 800],
  ['custom', 'Personalizado', 0, 0],
  ['percent', 'Porcentagem', 0, 0],
];

function drawFit(bmp, W, H, mode, bg, fmt) {
  const [c, ctx] = canvasOf(W, H);
  ctx.imageSmoothingQuality = 'high';
  const sw = bmp.width, sh = bmp.height;
  if (mode === 'stretch') { if (fmt === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); } ctx.drawImage(bmp, 0, 0, W, H); return c; }
  const cover = Math.max(W / sw, H / sh);
  const contain = Math.min(W / sw, H / sh);
  if (mode === 'cover') {
    const dw = sw * cover, dh = sh * cover;
    if (fmt === 'jpg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
    ctx.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return c;
  }
  // ajustar sem cortar: fundo de cor ou desfocado
  if (bg === 'blur') {
    const dw = sw * cover, dh = sh * cover;
    ctx.filter = `blur(${Math.round(Math.max(W, H) / 30)}px) brightness(0.8)`;
    ctx.drawImage(bmp, (W - dw) / 2 - 20, (H - dh) / 2 - 20, dw + 40, dh + 40);
    ctx.filter = 'none';
  } else if (bg !== 'transparent' || fmt === 'jpg') {
    ctx.fillStyle = bg === 'transparent' ? '#ffffff' : bg;
    ctx.fillRect(0, 0, W, H);
  }
  const dw = sw * contain, dh = sh * contain;
  ctx.drawImage(bmp, (W - dw) / 2, (H - dh) / 2, dw, dh);
  return c;
}

export const resize = {
  id: 'img-resize', cat: 'img', icon: '⤢', name: 'Redimensionar',
  desc: 'Tamanhos prontos para Instagram, Stories, YouTube, LinkedIn… ou medida própria.',
  render(view) {
    batchTool(view, {
      accept: ACCEPT, title: 'Arraste as imagens para redimensionar', thumb: thumbFor,
      actionLabel: 'Redimensionar', zipName: 'imagens-redimensionadas.zip',
      options(box) {
        let preset = 'ig-feed';
        const chips = el('div', { className: 'presets' });
        const w = numberEl(1080, { min: 1, max: 10000 });
        const h = numberEl(1080, { min: 1, max: 10000 });
        const pct = rangeEl(5, 200, 5, 50, (v) => v + '%');
        const custom = el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, [w, '×', h, 'px']);
        const customOpt = opt('Medida', custom);
        const pctOpt = opt('Porcentagem', pct.node);
        const mode = segmented([['cover', 'Preencher (corta)'], ['contain', 'Ajustar (sem cortar)'], ['stretch', 'Esticar']], 'cover', (v) => (bgOpt.hidden = v !== 'contain'));
        const bg = selectEl([['blur', 'Fundo desfocado'], ['#ffffff', 'Branco'], ['#000000', 'Preto'], ['transparent', 'Transparente (PNG/WebP)']], 'blur');
        const bgOpt = opt('Fundo', bg);
        const fmt = selectEl([['same', 'Mesmo formato'], ['jpg', 'JPG'], ['png', 'PNG'], ['webp', 'WebP']], 'same');
        const modeOpt = opt('Como encaixar', mode.node);
        const update = () => {
          [...chips.children].forEach((c) => c.classList.toggle('on', c.dataset.id === preset));
          customOpt.hidden = preset !== 'custom';
          pctOpt.hidden = preset !== 'percent';
          modeOpt.hidden = preset === 'percent';
          bgOpt.hidden = preset === 'percent' || mode.value !== 'contain';
        };
        for (const [id, label, pw, ph] of PRESETS) {
          chips.append(el('button', { type: 'button', className: 'chip', dataset: { id }, textContent: pw ? `${label} · ${pw}×${ph}` : label, onclick: () => { preset = id; update(); } }));
        }
        box.append(opt('Tamanho', chips, { wide: true }), customOpt, pctOpt, modeOpt, bgOpt, opt('Formato', fmt));
        update();
        return () => {
          const p = PRESETS.find((x) => x[0] === preset);
          return { preset, W: preset === 'custom' ? Number(w.value) : p[2], H: preset === 'custom' ? Number(h.value) : p[3], pct: pct.value, mode: mode.value, bg: bg.value, fmt: fmt.value };
        };
      },
      async process(file, o) {
        const bmp = await decode(file);
        let fmt = outExt(o.fmt, file);
        if (o.bg === 'transparent' && fmt === 'jpg' && o.mode === 'contain') fmt = 'png';
        let c;
        if (o.preset === 'percent') {
          c = draw(bmp, bmp.width * o.pct / 100, bmp.height * o.pct / 100, fmt);
        } else {
          if (!o.W || !o.H) throw new Error('Informe largura e altura.');
          c = drawFit(bmp, o.W, o.H, o.mode, o.bg, fmt);
        }
        const blob = await encode(c, fmt, 0.92);
        return { outputs: [{ name: `${baseName(file.name)}-${c.width}x${c.height}.${fmt}`, blob }], summary: `${bmp.width}×${bmp.height} → ${c.width}×${c.height} · ${formatBytes(blob.size)}` };
      },
    });
  },
};

// ---------------------------------------------------------------
//  Remover metadados (EXIF / GPS) sem perder qualidade
// ---------------------------------------------------------------
function exifHasGps(tiff) {
  try {
    const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const le = dv.getUint16(0) === 0x4949;
    const ifd = dv.getUint32(4, le);
    const n = dv.getUint16(ifd, le);
    for (let i = 0; i < n; i++) if (dv.getUint16(ifd + 2 + i * 12, le) === 0x8825) return true;
  } catch { /* ignora */ }
  return false;
}

function stripJpeg(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const out = [bytes.subarray(0, 2)];
  let i = 2, found = [], gps = false;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xda) { out.push(bytes.subarray(i)); break; } // início da imagem: copia o resto
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    const seg = bytes.subarray(i, i + 2 + len);
    const isExif = marker === 0xe1 && String.fromCharCode(...seg.subarray(4, 8)) === 'Exif';
    const isXmp = marker === 0xe1 && !isExif;
    if (isExif) { found.push('EXIF'); if (exifHasGps(seg.subarray(10))) gps = true; }
    else if (isXmp) found.push('XMP');
    else if (marker === 0xed) found.push('IPTC');
    else if (marker === 0xfe) found.push('comentário');
    const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe || (marker >= 0xe3 && marker <= 0xef && marker !== 0xee);
    if (!drop) out.push(seg);
    i += 2 + len;
  }
  return { blob: new Blob(out, { type: 'image/jpeg' }), found: [...new Set(found)], gps };
}

function stripPng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!sig.every((b, i) => bytes[i] === b)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = [bytes.subarray(0, 8)];
  const found = [];
  let i = 8;
  while (i < bytes.length) {
    const len = dv.getUint32(i);
    const type = String.fromCharCode(...bytes.subarray(i + 4, i + 8));
    const chunk = bytes.subarray(i, i + 12 + len);
    if (['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME'].includes(type)) found.push(type === 'eXIf' ? 'EXIF' : 'texto');
    else out.push(chunk);
    i += 12 + len;
    if (type === 'IEND') break;
  }
  return { blob: new Blob(out, { type: 'image/png' }), found: [...new Set(found)], gps: false };
}

export const metadata = {
  id: 'img-metadata', cat: 'img', icon: '⌖', name: 'Remover localização (EXIF)',
  desc: 'Tira GPS, modelo do celular e outros dados escondidos da foto, sem perder qualidade.',
  render(view) {
    batchTool(view, {
      accept: ACCEPT, title: 'Arraste as fotos para limpar', thumb: thumbFor,
      hint: 'JPG e PNG são limpos sem perder nada de qualidade. Outros formatos são regravados.',
      actionLabel: 'Remover dados', zipName: 'fotos-sem-dados.zip',
      async process(file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let r = stripJpeg(bytes) || stripPng(bytes);
        let name = file.name;
        if (!r) {
          const bmp = await decode(file);
          const fmt = extOf(file.name) === 'webp' ? 'webp' : 'jpg';
          const blob = await encode(draw(bmp, bmp.width, bmp.height, fmt), fmt, 0.95);
          r = { blob, found: ['todos (regravada)'], gps: false };
          name = `${baseName(file.name)}.${fmt}`;
        }
        const info = r.found.length ? `Removido: ${r.found.join(', ')}${r.gps ? ' · <span class="bad">tinha localização GPS</span>' : ''}` : 'Não tinha dados extras';
        return { outputs: [{ name: name.replace(/(\.[^.]+)$/, '-limpa$1'), blob: r.blob }], summary: info };
      },
    });
  },
};

export default [convert, compress, resize, metadata];
