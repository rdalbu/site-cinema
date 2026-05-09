// ── DOM refs ──────────────────────────────────────────────────────────────────
const player        = document.getElementById('player');
const overlayStatus = document.getElementById('overlay-status');
const statusBadge   = document.getElementById('status-badge');
const streamState   = document.getElementById('stream-state');
const overlayViewers= document.getElementById('overlay-viewers');
const viewerCount   = document.getElementById('viewer-count');
const watchError    = document.getElementById('watch-error');
const errorTitle    = document.getElementById('error-title');
const errorMsg      = document.getElementById('error-msg');
const loading       = document.getElementById('loading');

// ── State ─────────────────────────────────────────────────────────────────────
let ended = false;

// ── UI helpers ────────────────────────────────────────────────────────────────
function showPlayer() {
  loading.style.display = 'none';
  overlayStatus.classList.add('visible');
  overlayViewers.classList.add('visible');
}

function showError(title, msg) {
  loading.style.display = 'none';
  overlayStatus.classList.remove('visible');
  overlayViewers.classList.remove('visible');
  watchError.style.display = 'flex';
  errorTitle.textContent = title;
  errorMsg.textContent = msg;
}

// ── WebSocket connection (control only) ───────────────────────────────────────
function connect() {
  const roomId = location.pathname.split('/').pop();
  if (!roomId) {
    showError('Sala inválida', 'ID da sala não encontrado na URL.');
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?role=viewer&room=${roomId}`);

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    switch (msg.type) {
      case 'init':
        player.src = `/stream/${roomId}`;
        player.muted = true; // necessário para autoplay funcionar
        player.play().then(() => {
          player.muted = false; // desmuta assim que o browser permitiu o autoplay
        }).catch(() => {});
        showPlayer();
        streamState.textContent = 'Ao vivo';
        break;

      case 'pause':
        player.pause();
        statusBadge.textContent = '⏸ PAUSADO';
        statusBadge.className = 'paused';
        streamState.textContent = 'Pausado';
        break;

      case 'resume':
        player.play().catch(() => {});
        statusBadge.textContent = '● AO VIVO';
        statusBadge.className = '';
        streamState.textContent = 'Ao vivo';
        break;

      case 'seek':
        // Server closed our HTTP connection on seek; reconnect the stream
        player.src = `/stream/${roomId}`;
        player.play().catch(() => {});
        streamState.textContent = 'Sincronizando…';
        break;

      case 'end':
        ended = true;
        statusBadge.textContent = '■ ENCERRADO';
        statusBadge.className = 'ended';
        streamState.textContent = 'Encerrado';
        break;

      case 'viewers':
        viewerCount.textContent = msg.count;
        break;

      case 'error':
        showError('Erro', msg.message);
        break;
    }
  };

  ws.onclose = () => {
    if (!ended) {
      statusBadge.textContent = '✕ DESCONECTADO';
      statusBadge.className = 'ended';
      streamState.textContent = 'Conexão perdida';
    }
  };

  ws.onerror = () => {
    streamState.textContent = 'Erro de conexão';
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────
connect();
