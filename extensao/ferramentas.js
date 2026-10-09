// =============================================================
//  Ferramentas: menu, tela inicial e navegação
//  Funciona no painel lateral, numa aba ou (imagem/PDF/QR) até
//  como site comum, sem a extensão.
// =============================================================
import { el, inExtension } from './tools/common.js';
import imagem from './tools/imagem.js';
import pdf from './tools/pdf.js';
import midia from './tools/midia.js';
import qr from './tools/qr.js';

const CATS = [
  { id: 'img', name: 'Imagem', tools: imagem },
  { id: 'pdf', name: 'PDF', tools: pdf },
  { id: 'med', name: 'Vídeo e áudio', tools: midia },
  { id: 'qr', name: 'Outros', tools: qr },
];
const ALL = CATS.flatMap((c) => c.tools);

const view = document.getElementById('view');
const nav = document.getElementById('nav');
const isPanel = new URLSearchParams(location.search).has('painel');

function setNarrow() {
  document.body.classList.toggle('narrow', isPanel || window.innerWidth < 760);
}
setNarrow();
window.addEventListener('resize', setNarrow);

// botão "Tela cheia" no painel lateral
const full = document.getElementById('fullscreen');
if (isPanel && inExtension()) {
  full.hidden = false;
  full.onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('ferramentas.html') + location.hash });
}
document.getElementById('home').onclick = () => { location.hash = ''; };

const icon = (t) => el('span', { className: 'ico ' + t.cat, textContent: t.icon });

function renderNav(activeId) {
  nav.replaceChildren();
  for (const c of CATS) {
    nav.append(el('h3', { textContent: c.name }));
    for (const t of c.tools) {
      nav.append(el('button', {
        className: t.id === activeId ? 'active' : '',
        onclick: () => { location.hash = t.id; },
      }, [icon(t), t.name]));
    }
  }
}

function renderHome() {
  document.title = 'Ferramentas · Lumere Downloader';
  const home = el('div', { className: 'home' }, [
    el('h1', { textContent: 'O que você quer fazer?' }),
    el('p', { className: 'lead', textContent: 'Tudo roda no seu computador: nenhum arquivo é enviado para a internet.' }),
  ]);
  for (const c of CATS) {
    home.append(el('div', { className: 'cat', textContent: c.name }));
    home.append(el('div', { className: 'grid' }, c.tools.map((t) => el('button', {
      className: 'tile', onclick: () => { location.hash = t.id; },
    }, [
      el('span', { className: 'ico ' + t.cat, textContent: t.icon }),
      el('div', {}, [
        el('b', { textContent: t.name }),
        el('span', { textContent: t.desc }),
        t.needsHelper ? el('div', { className: 'need', textContent: 'Usa o ajudante do Windows' }) : null,
      ]),
    ]))));
  }
  view.replaceChildren(home);
}

async function renderTool(t) {
  document.title = t.name + ' · Ferramentas';
  const box = el('div');
  view.replaceChildren(
    el('button', { className: 'back', textContent: '← Todas as ferramentas', onclick: () => { location.hash = ''; } }),
    el('div', { className: 'tool-head' }, [el('span', { className: 'ico ' + t.cat, textContent: t.icon }), el('h2', { textContent: t.name })]),
    el('p', { className: 'tool-desc', textContent: t.desc }),
    box,
  );
  try {
    await t.render(box);
  } catch (e) {
    console.error(e);
    box.append(el('div', { className: 'warnbox', textContent: 'Erro ao abrir a ferramenta: ' + e.message }));
  }
}

function route() {
  const id = location.hash.slice(1);
  const tool = ALL.find((t) => t.id === id);
  renderNav(tool?.id);
  if (tool) renderTool(tool); else renderHome();
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', route);
route();
