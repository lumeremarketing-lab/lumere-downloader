// =============================================================
//  Ferramentas de PDF (PDF.js para ler, pdf-lib para montar)
// =============================================================
import { el, opt, selectEl, segmented, checkEl, dropzone, fileRow, download, downloadZip, baseName, extOf, formatBytes, parseRanges, sleep } from './common.js';
import { batchTool } from './batch.js';

const LIB = new URL('../lib/pdfjs/', import.meta.url).href;
let pdfjsPromise = null;
function pdfjs() {
  pdfjsPromise ||= import('../lib/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = LIB + 'pdf.worker.min.mjs';
    return m;
  });
  return pdfjsPromise;
}

async function openPdf(bytes) {
  const lib = await pdfjs();
  try {
    return await lib.getDocument({
      data: bytes.slice(0),
      cMapUrl: LIB + 'cmaps/', cMapPacked: true,
      standardFontDataUrl: LIB + 'standard_fonts/',
      wasmUrl: LIB + 'wasm/',
      isEvalSupported: false,
    }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new Error('Este PDF tem senha. Remova a senha antes de usar.');
    throw new Error('Não consegui abrir este PDF (' + (e?.message || e) + ')');
  }
}

async function renderPage(doc, n, scale) {
  const page = await doc.getPage(n);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  page.cleanup();
  return canvas;
}

function closePdf(doc) {
  try { (doc.loadingTask?.destroy?.() ?? doc.destroy?.())?.catch?.(() => {}); } catch { /* ignora */ }
}

const toBlob = (canvas, type, q) => new Promise((ok) => canvas.toBlob(ok, type, q));
const loadLib = (bytes) => PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });

// ---------------------------------------------------------------
export const pdfToImages = {
  id: 'pdf-to-img', cat: 'pdf', icon: '🖼', name: 'PDF → JPG / PNG',
  desc: 'Transforma cada página do PDF em uma imagem, na qualidade que você escolher.',
  render(view) {
    batchTool(view, {
      accept: 'application/pdf,.pdf', title: 'Arraste o(s) PDF(s) aqui', badge: 'PDF',
      actionLabel: 'Converter', zipName: 'paginas.zip', concurrency: 1,
      options(box) {
        const fmt = segmented([['jpg', 'JPG'], ['png', 'PNG']], 'jpg');
        const dpi = selectEl([['72', 'Tela (72 DPI)'], ['150', 'Boa (150 DPI)'], ['200', 'Alta (200 DPI)'], ['300', 'Impressão (300 DPI)']], '150');
        const pages = el('input', { type: 'text', placeholder: 'Todas (ou ex.: 1-3, 5)', style: { width: '170px' } });
        box.append(opt('Formato', fmt.node), opt('Qualidade', dpi), opt('Páginas', pages));
        return () => ({ fmt: fmt.value, scale: Number(dpi.value) / 72, pages: pages.value.trim() });
      },
      async process(file, o, row) {
        const doc = await openPdf(new Uint8Array(await file.arrayBuffer()));
        const total = doc.numPages;
        const list = [];
        if (o.pages) for (const [a, b] of parseRanges(o.pages, total)) for (let p = a; p <= b; p++) list.push(p);
        else for (let p = 1; p <= total; p++) list.push(p);
        const outputs = [];
        const pad = String(total).length;
        for (let i = 0; i < list.length; i++) {
          row.progress(((i + 0.5) / list.length) * 100, `Página ${list[i]} de ${total}…`);
          const canvas = await renderPage(doc, list[i], o.scale);
          const blob = await toBlob(canvas, o.fmt === 'png' ? 'image/png' : 'image/jpeg', 0.9);
          outputs.push({ name: `${baseName(file.name)}-pagina-${String(list[i]).padStart(pad, '0')}.${o.fmt}`, blob });
          if (i === 0) row.setThumb(URL.createObjectURL(blob));
        }
        closePdf(doc);
        return { outputs, summary: `${outputs.length} imagem(ns) · ${formatBytes(outputs.reduce((n, x) => n + x.blob.size, 0))}` };
      },
    });
  },
};

// ---------------------------------------------------------------
const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };

export const imagesToPdf = {
  id: 'img-to-pdf', cat: 'pdf', icon: '📄', name: 'Imagens → PDF',
  desc: 'Junta várias imagens em um único PDF, na ordem que você quiser.',
  render(view) {
    const images = [];
    const list = el('div', { className: 'files' });
    const status = el('span', { className: 'status' });

    const redraw = () => {
      list.replaceChildren(...images.map((f, i) => {
        const row = fileRow(f, { thumb: URL.createObjectURL(f) });
        row.node.querySelector('.fs').textContent = `Página ${i + 1} · ${formatBytes(f.size)}`;
        const up = row.button('↑', () => { if (i > 0) { [images[i - 1], images[i]] = [images[i], images[i - 1]]; redraw(); } });
        const down = row.button('↓', () => { if (i < images.length - 1) { [images[i + 1], images[i]] = [images[i], images[i + 1]]; redraw(); } });
        up.disabled = i === 0; down.disabled = i === images.length - 1;
        row.removeButton(() => { images.splice(i, 1); redraw(); });
        return row.node;
      }));
      make.disabled = !images.length;
      make.textContent = images.length > 1 ? `Criar PDF com ${images.length} páginas` : 'Criar PDF';
    };

    const size = selectEl([['a4', 'A4'], ['letter', 'Carta'], ['fit', 'Do tamanho da imagem']], 'a4');
    const orient = selectEl([['auto', 'Automática'], ['portrait', 'Retrato'], ['landscape', 'Paisagem']], 'auto');
    const margin = selectEl([['0', 'Sem margem'], ['20', 'Pequena'], ['40', 'Média']], '20');
    const quality = selectEl([['0.92', 'Alta'], ['0.8', 'Média (arquivo menor)'], ['0.6', 'Baixa (bem leve)']], '0.92');
    const name = el('input', { type: 'text', value: 'documento', style: { width: '160px' } });
    const make = el('button', { className: 'primary', textContent: 'Criar PDF', disabled: true });

    make.onclick = async () => {
      make.disabled = true;
      status.className = 'status';
      try {
        const doc = await PDFLib.PDFDocument.create();
        for (let i = 0; i < images.length; i++) {
          status.textContent = `Adicionando página ${i + 1} de ${images.length}…`;
          const f = images[i];
          const bmp = await createImageBitmap(f).catch(() => { throw new Error(`"${f.name}" não é uma imagem suportada.`); });
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext('2d');
          const keepPng = /png|gif/.test(f.type);
          if (!keepPng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
          ctx.drawImage(bmp, 0, 0);
          const blob = await c.convertToBlob(keepPng ? { type: 'image/png' } : { type: 'image/jpeg', quality: Number(quality.value) });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const img = keepPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);

          let [pw, ph] = size.value === 'fit' ? [bmp.width * 0.75, bmp.height * 0.75] : PAGE_SIZES[size.value];
          const landscape = orient.value === 'landscape' || (orient.value === 'auto' && bmp.width > bmp.height);
          if (size.value !== 'fit' && landscape) [pw, ph] = [ph, pw];
          const m = size.value === 'fit' ? 0 : Number(margin.value);
          const s = Math.min((pw - 2 * m) / bmp.width, (ph - 2 * m) / bmp.height);
          const w = bmp.width * s, h = bmp.height * s;
          const page = doc.addPage([pw, ph]);
          page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
          await sleep(0);
        }
        const out = new Blob([await doc.save()], { type: 'application/pdf' });
        await download(out, (name.value.trim() || 'documento') + '.pdf');
        status.textContent = `PDF criado · ${images.length} página(s) · ${formatBytes(out.size)}`;
      } catch (e) {
        status.className = 'status err';
        status.textContent = 'Erro: ' + e.message;
      }
      make.disabled = false;
    };

    view.append(
      dropzone({ accept: 'image/*', title: 'Arraste as imagens aqui', hint: 'Use as setas para mudar a ordem das páginas.', onFiles: (fs) => { images.push(...fs); redraw(); } }),
      list,
      el('div', { className: 'options' }, [opt('Tamanho da página', size), opt('Orientação', orient), opt('Margem', margin), opt('Qualidade', quality), opt('Nome do arquivo', name)]),
      el('div', { className: 'actions' }, [make, status]),
    );
  },
};

// ---------------------------------------------------------------
const COLORS = ['#3b82f6', '#e8453c', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899'];

export const organize = {
  id: 'pdf-organize', cat: 'pdf', icon: '⧉', name: 'Juntar e organizar PDF',
  desc: 'Junte vários PDFs e arraste as páginas para reordenar, girar ou apagar.',
  render(view) {
    const sources = []; // { name, bytes, color, lib }
    const pages = [];   // { src, index, rotation, thumb }
    const grid = el('div', { className: 'pages' });
    const status = el('span', { className: 'status' });
    const save = el('button', { className: 'primary', textContent: 'Salvar PDF', disabled: true });
    const name = el('input', { type: 'text', value: '', placeholder: 'documento', style: { width: '170px' } });
    let dragFrom = null;

    const redraw = () => {
      grid.replaceChildren(...pages.map((p, i) => {
        const img = el('img', { src: p.thumb || '', alt: '' });
        img.style.transform = `rotate(${p.rotation}deg)`;
        const card = el('div', { className: 'page', draggable: true }, [
          sources.length > 1 ? el('span', { className: 'src', textContent: String(p.src + 1), style: { background: sources[p.src].color } }) : null,
          el('div', { className: 'pv' }, [img]),
          el('div', { className: 'pl' }, [
            el('span', { textContent: String(i + 1), title: `${sources[p.src].name} · página ${p.index + 1}` }),
            el('button', { className: 'icon-btn', textContent: '⟲', title: 'Girar para a esquerda', onclick: () => { p.rotation = (p.rotation + 270) % 360; redraw(); } }),
            el('button', { className: 'icon-btn', textContent: '⟳', title: 'Girar para a direita', onclick: () => { p.rotation = (p.rotation + 90) % 360; redraw(); } }),
            el('button', { className: 'icon-btn', textContent: '🗑', title: 'Apagar página', onclick: () => { pages.splice(i, 1); redraw(); } }),
          ]),
        ]);
        card.addEventListener('dragstart', () => { dragFrom = i; card.classList.add('dragging'); });
        card.addEventListener('dragend', () => card.classList.remove('dragging'));
        card.addEventListener('dragover', (e) => { e.preventDefault(); card.classList.add('over'); });
        card.addEventListener('dragleave', () => card.classList.remove('over'));
        card.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (dragFrom == null || dragFrom === i) return;
          const [moved] = pages.splice(dragFrom, 1);
          pages.splice(i, 0, moved);
          dragFrom = null;
          redraw();
        });
        return card;
      }));
      save.disabled = !pages.length;
      status.className = 'status';
      status.textContent = pages.length ? `${pages.length} página(s) de ${sources.length} arquivo(s). Arraste para reordenar.` : '';
    };

    const addFiles = async (files) => {
      for (const f of files) {
        if (!/pdf$/i.test(f.type) && extOf(f.name) !== 'pdf') continue;
        const bytes = new Uint8Array(await f.arrayBuffer());
        const srcIdx = sources.length;
        let doc;
        try { doc = await openPdf(bytes); }
        catch (e) { status.className = 'status err'; status.textContent = `${f.name}: ${e.message}`; continue; }
        sources.push({ name: f.name, bytes, color: COLORS[srcIdx % COLORS.length] });
        if (!name.value) name.value = baseName(f.name) + (files.length > 1 || sources.length > 1 ? '-junto' : '-organizado');
        const newPages = [];
        for (let n = 0; n < doc.numPages; n++) newPages.push({ src: srcIdx, index: n, rotation: 0, thumb: null });
        pages.push(...newPages);
        redraw();
        // miniaturas aos poucos
        for (const p of newPages) {
          const c = await renderPage(doc, p.index + 1, 0.35);
          p.thumb = c.toDataURL('image/jpeg', 0.7);
          const imgs = grid.querySelectorAll('.page img');
          const idx = pages.indexOf(p);
          if (idx >= 0 && imgs[idx]) imgs[idx].src = p.thumb;
        }
        closePdf(doc);
      }
    };

    save.onclick = async () => {
      save.disabled = true;
      status.className = 'status';
      try {
        const out = await PDFLib.PDFDocument.create();
        const libs = [];
        for (let i = 0; i < pages.length; i++) {
          const p = pages[i];
          status.textContent = `Montando página ${i + 1} de ${pages.length}…`;
          libs[p.src] ||= await loadLib(sources[p.src].bytes);
          const [copy] = await out.copyPages(libs[p.src], [p.index]);
          if (p.rotation) copy.setRotation(PDFLib.degrees((copy.getRotation().angle + p.rotation) % 360));
          out.addPage(copy);
        }
        const blob = new Blob([await out.save()], { type: 'application/pdf' });
        await download(blob, (name.value.trim() || 'documento') + '.pdf');
        status.textContent = `PDF salvo · ${pages.length} página(s) · ${formatBytes(blob.size)}`;
      } catch (e) {
        status.className = 'status err';
        status.textContent = 'Erro: ' + e.message;
      }
      save.disabled = false;
    };

    const reverse = el('button', { className: 'secondary', textContent: 'Inverter ordem', onclick: () => { pages.reverse(); redraw(); } });
    const reset = el('button', { className: 'secondary', textContent: 'Limpar', onclick: () => { sources.length = 0; pages.length = 0; name.value = ''; redraw(); } });

    view.append(
      dropzone({ accept: 'application/pdf,.pdf', title: 'Arraste um ou mais PDFs', hint: 'Pode ir adicionando mais arquivos depois; as páginas entram no final.', onFiles: addFiles }),
      grid,
      el('div', { className: 'options' }, [opt('Nome do arquivo', name)]),
      el('div', { className: 'actions' }, [save, reverse, reset, status]),
    );
  },
};

// ---------------------------------------------------------------
export const split = {
  id: 'pdf-split', cat: 'pdf', icon: '✂', name: 'Dividir PDF',
  desc: 'Extraia páginas ou separe o PDF em vários arquivos.',
  render(view) {
    batchTool(view, {
      accept: 'application/pdf,.pdf', title: 'Arraste o PDF aqui', multiple: false,
      actionLabel: 'Dividir', zipName: 'pdf-dividido.zip', concurrency: 1,
      options(box) {
        const mode = segmented([['extract', 'Extrair páginas (1 PDF)'], ['ranges', 'Um PDF por intervalo'], ['each', 'Cada página um PDF']], 'extract', (v) => (rangesOpt.hidden = v === 'each'));
        const ranges = el('input', { type: 'text', placeholder: 'ex.: 1-3, 5, 8-10', style: { width: '200px' } });
        const rangesOpt = opt('Páginas', ranges);
        box.append(opt('Como dividir', mode.node), rangesOpt);
        return () => ({ mode: mode.value, ranges: ranges.value });
      },
      async process(file, o, row) {
        const src = await loadLib(new Uint8Array(await file.arrayBuffer()));
        const total = src.getPageCount();
        const groups = [];
        if (o.mode === 'each') for (let p = 1; p <= total; p++) groups.push([[p, p]]);
        else {
          const rs = parseRanges(o.ranges, total);
          if (o.mode === 'extract') groups.push(rs); else rs.forEach((r) => groups.push([r]));
        }
        const outputs = [];
        for (let g = 0; g < groups.length; g++) {
          row.progress(((g + 0.5) / groups.length) * 100, `Criando ${g + 1} de ${groups.length}…`);
          const idx = [];
          for (const [a, b] of groups[g]) for (let p = a; p <= b; p++) idx.push(p - 1);
          const out = await PDFLib.PDFDocument.create();
          (await out.copyPages(src, idx)).forEach((pg) => out.addPage(pg));
          const label = groups[g].map(([a, b]) => (a === b ? a : `${a}-${b}`)).join('_');
          outputs.push({ name: `${baseName(file.name)}-p${label}.pdf`, blob: new Blob([await out.save()], { type: 'application/pdf' }) });
        }
        return { outputs, summary: `${total} páginas → ${outputs.length} arquivo(s)` };
      },
    });
  },
};

export default [pdfToImages, imagesToPdf, organize, split];
