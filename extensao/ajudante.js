async function check() {
  const el = document.getElementById('status');
  el.className = 'status';
  el.textContent = 'Verificando…';
  const s = await chrome.runtime.sendMessage({ cmd: 'helper-status', force: true }).catch((e) => ({ ok: false, error: e.message }));
  if (s.ok) {
    el.className = 'status ok';
    el.textContent = `✓ Ajudante instalado e funcionando (versão ${s.version}, yt-dlp ${s.ytdlp}). Já pode fechar esta aba.`;
  } else {
    el.textContent = 'O ajudante ainda não está instalado (' + (s.error || 'sem resposta') + ').';
  }
}
document.getElementById('check').onclick = check;
check();
