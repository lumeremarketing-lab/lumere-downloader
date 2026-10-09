// =============================================================
//  Vídeo e áudio: rodam no ffmpeg do ajudante do Windows
//  (rápido e sem limite de tamanho). O arquivo vai do Chrome para
//  o ajudante no seu PC; nada é enviado para a internet.
// =============================================================
import { el, opt, selectEl, segmented, checkEl, numberEl, dropzone, fileRow, formatBytes, baseName, savings, inExtension } from './common.js';
import { helperStatus, upload, runMedia, showInFolder } from './helper-client.js';

const VIDEO_ACCEPT = 'video/*,.mkv,.avi,.mov,.wmv,.flv,.webm,.3gp,.ts,.m4v';
const AUDIO_ACCEPT = VIDEO_ACCEPT + ',audio/*,.opus,.ogg,.m4a,.wav,.flac,.aac,.wma,.amr';

function parseTime(t) {
  const s = String(t || '').trim().replace(',', '.');
  if (!s) return 0;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) throw new Error(`Tempo inválido: "${t}". Use 1:23 ou 83.`);
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}
function fmtTime(sec) {
  sec = Math.max(0, sec || 0);
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0').replace('.', ',')}`;
}

async function helperGate(view) {
  if (!inExtension()) {
    view.append(el('div', { className: 'warnbox', textContent: 'As ferramentas de vídeo e áudio funcionam só na extensão, com o ajudante do Windows instalado.' }));
    return false;
  }
  const s = await helperStatus();
  if (!s.ok || !s.media || !s.ffmpeg) {
    const box = el('div', { className: 'warnbox' }, [
      !s.ok ? 'Estas ferramentas usam o ajudante do Windows, que ainda não está instalado. ' : 'Atualize o ajudante para usar estas ferramentas: rode o instalar.bat da versão 2.1 de novo. ',
      el('a', { href: 'ajudante.html', target: '_blank', textContent: 'Ver como instalar', style: { color: '#6fb6ff' } }),
    ]);
    view.append(box);
    return false;
  }
  return true;
}

function mediaTool({ id, icon, name, desc, accept, multiple = true, suffix = '', actionLabel, options, preview }) {
  return {
    id, cat: 'med', icon, name, desc, needsHelper: true,
    async render(view) {
      if (!(await helperGate(view))) return;
      const files = [];
      const rows = new Map();
      const list = el('div', { className: 'files' });
      const optBox = el('div', { className: 'options' });
      const previewBox = el('div');
      const ctx = { files, previewBox };
      const getOpts = options(optBox, ctx);
      const run = el('button', { className: 'primary', textContent: actionLabel, disabled: true });
      const status = el('span', { className: 'status' });
      let cancelCurrent = null;
      const cancel = el('button', { className: 'secondary', textContent: 'Cancelar', hidden: true, onclick: () => cancelCurrent?.() });

      const refresh = () => {
        run.disabled = !files.length;
        run.textContent = files.length > 1 ? `${actionLabel} ${files.length} arquivos` : actionLabel;
        if (preview) preview(ctx);
      };
      const add = (incoming) => {
        if (!multiple) { files.length = 0; list.replaceChildren(); rows.clear(); }
        for (const f of incoming) {
          files.push(f);
          const row = fileRow(f);
          row.removeButton(() => { files.splice(files.indexOf(f), 1); rows.delete(f); refresh(); });
          rows.set(f, row);
          list.append(row.node);
        }
        refresh();
      };

      run.onclick = async () => {
        let o;
        try { o = getOpts(); } catch (e) { status.className = 'status err'; status.textContent = e.message; return; }
        run.disabled = true;
        cancel.hidden = false;
        status.className = 'status';
        status.textContent = 'Mantenha esta janela aberta até terminar.';
        let ok = 0;
        for (const f of [...files]) {
          const row = rows.get(f);
          if (!row) continue;
          row.actions.querySelectorAll('.mini-btn').forEach((b) => b.remove());
          const abort = new AbortController();
          let job = null;
          cancelCurrent = () => { abort.abort(); job?.cancel(); };
          try {
            row.progress(0, 'Enviando para o ajudante…');
            const token = await upload(f, (p) => row.progress(p * 30, `Enviando para o ajudante… ${Math.round(p * 100)}%`), abort.signal);
            row.progress(30, 'Processando…');
            job = runMedia({ token, op: o.op, params: o.params, outName: baseName(f.name) + suffix }, (p) => row.progress(30 + p * 0.7, `Processando… ${Math.round(p)}%`));
            await job.started;
            const r = await job.result;
            const fname = r.file.split(/[\\/]/).pop();
            row.done(`${fname} · ${formatBytes(f.size)} → ${formatBytes(r.size)} ${o.op === 'compress' ? savings(f.size, r.size) : ''}`);
            row.button('Mostrar na pasta', () => showInFolder(r.file), 'blue');
            ok++;
          } catch (e) {
            row.error(e.message === 'Cancelado' ? 'Cancelado' : 'Erro: ' + e.message);
            if (abort.signal.aborted) break;
          }
        }
        cancelCurrent = null;
        cancel.hidden = true;
        run.disabled = false;
        status.textContent = ok ? `${ok} pronto(s) na sua pasta Downloads.` : '';
      };

      view.append(
        dropzone({ accept, multiple, title: multiple ? 'Arraste os arquivos aqui' : 'Arraste o vídeo aqui', hint: 'Sem limite de tamanho. O resultado vai para a pasta Downloads.', onFiles: add }),
        list, previewBox, optBox, el('div', { className: 'actions' }, [run, cancel, status]),
      );
    },
  };
}

// prévia com marcação de início/fim (cortar e GIF)
function rangePicker(optBox, ctx, { defaultEnd = 0 } = {}) {
  const start = el('input', { type: 'text', value: '0:00', style: { width: '90px' } });
  const end = el('input', { type: 'text', value: defaultEnd ? fmtTime(defaultEnd) : '', placeholder: 'fim do vídeo', style: { width: '110px' } });
  const video = el('video', { className: 'player', controls: true, hidden: true });
  const setStart = el('button', { type: 'button', className: 'secondary', textContent: '⏮ Início = agora', onclick: () => (start.value = fmtTime(video.currentTime)) });
  const setEnd = el('button', { type: 'button', className: 'secondary', textContent: 'Fim = agora ⏭', onclick: () => (end.value = fmtTime(video.currentTime)) });
  const marks = el('div', { className: 'marks', hidden: true }, [setStart, setEnd, el('span', { className: 'note', textContent: 'Pause o vídeo no ponto certo e clique.' })]);
  ctx.previewBox.append(video, marks);
  optBox.append(opt('Início', start), opt('Fim', end));
  ctx.onPreview = () => {
    const f = ctx.files[0];
    if (!f) { video.hidden = true; marks.hidden = true; return; }
    video.src = URL.createObjectURL(f);
    video.hidden = false;
    marks.hidden = false;
    video.onloadedmetadata = () => { if (!end.value && !defaultEnd) end.placeholder = fmtTime(video.duration); };
    video.onerror = () => { video.hidden = true; marks.hidden = true; };
  };
  return {
    get start() { return parseTime(start.value); },
    get end() { return end.value.trim() ? parseTime(end.value) : (video.duration || 0); },
  };
}

// ---------------------------------------------------------------
export const audio = mediaTool({
  id: 'media-audio', icon: '♫', name: 'Extrair / converter áudio',
  desc: 'MP4 → MP3, áudio do WhatsApp (.opus) → MP3, M4A, WAV…',
  accept: AUDIO_ACCEPT, actionLabel: 'Converter',
  options(box) {
    const fmt = segmented([['mp3', 'MP3'], ['m4a', 'M4A'], ['wav', 'WAV'], ['ogg', 'OGG']], 'mp3', (v) => (brOpt.hidden = v === 'wav'));
    const br = selectEl([['128', '128 kbps (menor)'], ['192', '192 kbps (padrão)'], ['320', '320 kbps (máxima)']], '192');
    const brOpt = opt('Qualidade', br);
    box.append(opt('Formato', fmt.node), brOpt);
    return () => ({ op: 'audio', params: { format: fmt.value, bitrate: Number(br.value) } });
  },
});

export const compressVideo = mediaTool({
  id: 'media-compress', icon: '🗜', name: 'Comprimir vídeo',
  desc: 'Deixa o vídeo leve para WhatsApp, e-mail ou site, mantendo boa qualidade.',
  accept: VIDEO_ACCEPT, suffix: '-comprimido', actionLabel: 'Comprimir',
  options(box) {
    const level = segmented([['leve', 'Leve'], ['media', 'Média'], ['forte', 'Forte (720p)'], ['size', 'Caber em…']], 'media', (v) => (sizeOpt.hidden = v !== 'size'));
    const mb = numberEl(25, { min: 1, max: 4000, width: 80 });
    const sizeOpt = opt('Tamanho máximo (MB)', el('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, [mb, el('span', { className: 'note', textContent: 'e-mail: 25 · Discord: 10' })]));
    sizeOpt.hidden = true;
    box.append(opt('Compressão', level.node), sizeOpt);
    return () => (level.value === 'size'
      ? { op: 'compress', params: { targetMB: Number(mb.value) } }
      : { op: 'compress', params: { level: level.value } });
  },
});

export const convertVideo = mediaTool({
  id: 'media-convert', icon: '⇄', name: 'Converter vídeo → MP4',
  desc: 'MOV, MKV, AVI, WEBM, WMV… para MP4, que abre em qualquer lugar.',
  accept: VIDEO_ACCEPT, actionLabel: 'Converter',
  options: () => () => ({ op: 'convert', params: {} }),
});

export const trim = mediaTool({
  id: 'media-trim', icon: '✂', name: 'Cortar vídeo',
  desc: 'Escolha o início e o fim assistindo à prévia, e salve só o trecho.',
  accept: VIDEO_ACCEPT + ',audio/*', multiple: false, suffix: '-corte', actionLabel: 'Cortar',
  options(box, ctx) {
    const r = rangePicker(box, ctx);
    const fast = checkEl('Rápido (sem reprocessar; o corte pode variar 1–2 s)', false);
    box.append(fast.node);
    return () => {
      if (r.end <= r.start) throw new Error('O fim precisa ser depois do início.');
      return { op: 'trim', params: { start: r.start, end: r.end, fast: fast.value } };
    };
  },
  preview: (ctx) => ctx.onPreview?.(),
});

export const gif = mediaTool({
  id: 'media-gif', icon: '▶', name: 'Vídeo → GIF',
  desc: 'Transforma um trecho do vídeo em GIF animado.',
  accept: VIDEO_ACCEPT, multiple: false, actionLabel: 'Criar GIF',
  options(box, ctx) {
    const r = rangePicker(box, ctx, { defaultEnd: 5 });
    const fps = selectEl([['10', '10 quadros/s (leve)'], ['15', '15 quadros/s'], ['24', '24 quadros/s (suave)']], '15');
    const width = selectEl([['320', '320 px'], ['480', '480 px'], ['640', '640 px'], ['800', '800 px']], '480');
    box.append(opt('Fluidez', fps), opt('Largura', width), el('span', { className: 'note', textContent: 'GIFs pesam muito: prefira trechos de até 10 s.' }));
    return () => {
      if (r.end <= r.start) throw new Error('O fim precisa ser depois do início.');
      return { op: 'gif', params: { start: r.start, end: r.end, fps: Number(fps.value), width: Number(width.value) } };
    };
  },
  preview: (ctx) => ctx.onPreview?.(),
});

export default [audio, compressVideo, convertVideo, trim, gif];
