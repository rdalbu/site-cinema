// ── DOM refs ──────────────────────────────────────────────────────────────────
const videoWrap   = document.getElementById('video-wrap');
const player      = document.getElementById('player');
const streamStatus= document.getElementById('stream-status');
const watchInfo   = document.getElementById('watch-info');
const viewerCount = document.getElementById('viewer-count');
const streamState = document.getElementById('stream-state');
const watchError  = document.getElementById('watch-error');
const errorTitle  = document.getElementById('error-title');
const errorMsg    = document.getElementById('error-msg');
const toast       = document.getElementById('toast');

// ── State ─────────────────────────────────────────────────────────────────────
let mediaSource  = null;
let sourceBuffer = null;
const queue      = [];
let ended        = false;
let playAttempted = false;

const MAX_QUEUE = 200;

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg, duration = 3000) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// ── MediaSource setup ─────────────────────────────────────────────────────────
function setupMediaSource(mimeType) {
  const supported = MediaSource.isTypeSupported(mimeType);
  const type = supported ? mimeType : (mimeType.split(';')[0]);

  if (!MediaSource.isTypeSupported(type)) {
    showError('Formato não suportado', `O formato "${type}" não é compatível com este browser. Use WebM ou MP4 H.264.`);
    return;
  }

  mediaSource = new MediaSource();
  player.src = URL.createObjectURL(mediaSource);

  mediaSource.addEventListener('sourceopen', () => {
    try {
      sourceBuffer = mediaSource.addSourceBuffer(type);
      sourceBuffer.addEventListener('updateend', processQueue);
      processQueue();
    } catch (e) {
      showError('Erro de codec', e.message);
    }
  });
}

function processQueue() {
  if (!sourceBuffer || sourceBuffer.updating || queue.length === 0) return;
  const chunk = queue.shift();
  try {
    sourceBuffer.appendBuffer(chunk);
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      if (sourceBuffer.buffered.length > 0) {
        const start = sourceBuffer.buffered.start(0);
        const end = sourceBuffer.buffered.end(0);
        // Keep last 30s; if less than 30s buffered, keep from currentTime-1
        const removeEnd = end - 30 > start ? end - 30 : Math.max(start, player.currentTime - 1);
        if (removeEnd > start) {
          sourceBuffer.remove(start, removeEnd);
          queue.unshift(chunk); // retry after removal fires updateend
        } else {
          console.warn('QuotaExceededError: cannot free space, dropping chunk.');
        }
      } else {
        console.warn('QuotaExceededError: no buffered range to evict, dropping chunk.');
      }
    } else {
      console.error('appendBuffer:', e);
    }
  }
}

function endStream() {
  if (!mediaSource || mediaSource.readyState !== 'open') return;
  let attempts = 0;
  const tryEnd = () => {
    if (attempts++ > 50) return; // 5s max wait
    if ((sourceBuffer && sourceBuffer.updating) || queue.length > 0) {
      setTimeout(tryEnd, 100);
      return;
    }
    try { mediaSource.endOfStream(); } catch (_) {}
  };
  tryEnd();
}

// ── UI helpers ────────────────────────────────────────────────────────────────
function showPlayer() {
  videoWrap.classList.remove('hidden');
  watchInfo.classList.remove('hidden');
}

function showError(title, msg) {
  videoWrap.classList.add('hidden');
  watchInfo.classList.add('hidden');
  watchError.classList.remove('hidden');
  queue.length = 0; // clear pending chunks
  errorTitle.textContent = title;
  errorMsg.textContent = msg;
}

// ── WebSocket connection ──────────────────────────────────────────────────────
function connect() {
  const roomId = location.pathname.split('/').pop();
  if (!roomId) {
    showError('Sala inválida', 'ID da sala não encontrado na URL.');
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${proto}//${location.host}/ws?role=viewer&room=${roomId}`);
  ws.binaryType = 'arraybuffer';

  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      switch (msg.type) {
        case 'init':
          setupMediaSource(msg.mimeType);
          showPlayer();
          streamState.textContent = 'Conectado';
          break;
        case 'buffer':
          streamState.textContent = `Sincronizando (${msg.chunks ?? '?'} chunks)...`;
          break;
        case 'pause':
          player.pause();
          streamStatus.textContent = '⏸ PAUSADO';
          streamState.textContent = 'Pausado pelo host';
          break;
        case 'resume':
          player.play().catch(() => {});
          streamStatus.textContent = '● AO VIVO';
          streamState.textContent = 'Ao vivo';
          break;
        case 'end':
          ended = true;
          endStream();
          streamStatus.textContent = '■ ENCERRADO';
          streamState.textContent = 'Transmissão encerrada';
          showToast('A transmissão foi encerrada.');
          break;
        case 'viewers':
          viewerCount.textContent = msg.count;
          break;
        case 'error':
          showError('Erro', msg.message);
          break;
      }
    } else {
      if (queue.length < MAX_QUEUE) queue.push(e.data);
      processQueue();
      if (!playAttempted && !ended) {
        playAttempted = true;
        player.play().catch(() => {});
      }
    }
  };

  ws.onclose = () => {
    if (!ended) {
      streamState.textContent = 'Desconectado';
      showToast('Conexão perdida com o servidor.');
    }
  };

  ws.onerror = () => showToast('Erro ao conectar. Recarregue a página.');
}

// ── Init ──────────────────────────────────────────────────────────────────────
connect();
