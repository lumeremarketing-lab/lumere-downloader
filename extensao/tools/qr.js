// =============================================================
//  Gerador de QR Code (link, texto, WhatsApp, Wi-Fi)
// =============================================================
import { el, opt, selectEl, segmented, download } from './common.js';

function utf8(s) { return unescape(encodeURIComponent(s)); } // bytes UTF-8 para o qrcode-generator
const escWifi = (s) => s.replace(/([\\;,:"])/g, '\\$1');

function buildMatrix(text, ecc) {
  const qr = qrcode(0, ecc);
  qr.addData(utf8(text), 'Byte');
  qr.make();
  return qr;
}

function drawCanvas(qr, size, fg, bg, margin = 4) {
  const n = qr.getModuleCount();
  const total = n + margin * 2;
  const scale = Math.max(1, Math.floor(size / total));
  const c = document.createElement('canvas');
  c.width = c.height = total * scale;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = fg;
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) {
    if (qr.isDark(r, col)) ctx.fillRect((col + margin) * scale, (r + margin) * scale, scale, scale);
  }
  return c;
}

function toSvg(qr, fg, bg, margin = 4) {
  const n = qr.getModuleCount();
  const total = n + margin * 2;
  let path = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c + margin} ${r + margin}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="${bg}"/><path d="${path}" fill="${fg}"/></svg>`;
}

export const qrTool = {
  id: 'qr', cat: 'qr', icon: '▦', name: 'Gerador de QR Code',
  desc: 'QR Code de link, texto, WhatsApp ou Wi-Fi, em PNG ou SVG.',
  render(view) {
    const form = el('div', { className: 'options', style: { margin: 0 } });
    const fields = el('div', { style: { display: 'contents' } });
    const inputs = {
      url: el('input', { type: 'url', value: 'https://', style: { width: '100%' } }),
      text: el('textarea', { placeholder: 'Qualquer texto' }),
      phone: el('input', { type: 'tel', placeholder: '(85) 99999-9999', style: { width: '180px' } }),
      msg: el('textarea', { placeholder: 'Mensagem que já vem escrita (opcional)' }),
      ssid: el('input', { type: 'text', placeholder: 'Nome da rede', style: { width: '180px' } }),
      pass: el('input', { type: 'text', placeholder: 'Senha', style: { width: '180px' } }),
      sec: selectEl([['WPA', 'WPA/WPA2'], ['WEP', 'WEP'], ['nopass', 'Sem senha']], 'WPA'),
    };
    const kind = segmented([['url', 'Link'], ['text', 'Texto'], ['wa', 'WhatsApp'], ['wifi', 'Wi-Fi']], 'url', () => { showFields(); update(); });
    const fg = el('input', { type: 'color', value: '#000000' });
    const bg = el('input', { type: 'color', value: '#ffffff' });
    const ecc = selectEl([['L', 'Baixa'], ['M', 'Média'], ['Q', 'Alta'], ['H', 'Máxima (resiste a sujeira/logo)']], 'M');
    const size = selectEl([['512', '512 px'], ['1024', '1024 px'], ['2048', '2048 px (impressão)']], '1024');

    const showFields = () => {
      const k = kind.value;
      fields.replaceChildren(...({
        url: [opt('Endereço', inputs.url, { wide: true })],
        text: [opt('Texto', inputs.text, { wide: true })],
        wa: [opt('Número com DDD', inputs.phone), opt('Mensagem', inputs.msg, { wide: true })],
        wifi: [opt('Rede (SSID)', inputs.ssid), opt('Senha', inputs.pass), opt('Segurança', inputs.sec)],
      })[k]);
    };

    const payload = () => {
      switch (kind.value) {
        case 'url': return inputs.url.value.trim();
        case 'text': return inputs.text.value;
        case 'wa': {
          let d = inputs.phone.value.replace(/\D/g, '');
          if (!d) return '';
          if (d.length <= 11) d = '55' + d; // Brasil por padrão
          const m = inputs.msg.value.trim();
          return `https://wa.me/${d}${m ? '?text=' + encodeURIComponent(m) : ''}`;
        }
        case 'wifi': {
          if (!inputs.ssid.value) return '';
          const t = inputs.sec.value;
          return `WIFI:T:${t};S:${escWifi(inputs.ssid.value)};${t !== 'nopass' ? `P:${escWifi(inputs.pass.value)};` : ''};`;
        }
      }
      return '';
    };

    const canvas = el('canvas', { width: 240, height: 240 });
    const info = el('div', { className: 'note', style: { textAlign: 'center', maxWidth: '240px', wordBreak: 'break-all' } });
    const png = el('button', { className: 'primary', textContent: 'Baixar PNG' });
    const svg = el('button', { className: 'secondary', textContent: 'Baixar SVG' });
    let current = null;

    const update = () => {
      const text = payload();
      const ctx = canvas.getContext('2d');
      if (!text || text === 'https://') {
        current = null;
        ctx.fillStyle = '#2a2c33'; ctx.fillRect(0, 0, 240, 240);
        info.textContent = 'Preencha os dados ao lado';
        png.disabled = svg.disabled = true;
        return;
      }
      try {
        current = buildMatrix(text, ecc.value);
        const c = drawCanvas(current, 240, fg.value, bg.value);
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, 240, 240);
        ctx.drawImage(c, 0, 0, 240, 240);
        info.textContent = text.length > 80 ? text.slice(0, 80) + '…' : text;
        png.disabled = svg.disabled = false;
      } catch {
        current = null;
        info.textContent = 'Texto longo demais para um QR Code.';
        png.disabled = svg.disabled = true;
      }
    };

    png.onclick = () => {
      if (!current) return;
      drawCanvas(current, Number(size.value), fg.value, bg.value).toBlob((b) => download(b, 'qrcode.png'), 'image/png');
    };
    svg.onclick = () => {
      if (!current) return;
      download(new Blob([toSvg(current, fg.value, bg.value)], { type: 'image/svg+xml' }), 'qrcode.svg');
    };

    for (const i of Object.values(inputs)) i.addEventListener('input', update);
    for (const i of [fg, bg, ecc]) i.addEventListener('input', update);

    form.append(opt('Tipo', kind.node, { wide: true }), fields, opt('Cor', fg), opt('Fundo', bg), opt('Correção de erro', ecc), opt('Tamanho do PNG', size));
    showFields();
    view.append(el('div', { className: 'qr-wrap' }, [
      el('div', { className: 'qr-form' }, [form]),
      el('div', { className: 'qr-preview' }, [canvas, info, el('div', { style: { display: 'flex', gap: '8px' } }, [png, svg])]),
    ]));
    update();
  },
};

export default [qrTool];
