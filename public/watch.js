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
let mediaSource  = null;
let sourceBuffer = null;
const queue      = [];
let ended        = false;
let playAttempted = false;

const MAX_QUEUE = 200;

// ── MediaSource setup ─────────────────────────────────────────────────────────
const CODEC_FALLBACKS = {
  'video/mp4':  ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4; codecs="avc1.4D401F, mp4a.40.2"', 'video/mp4; codecs="avc1.640028"'],
  'video/webm': ['video/webm; codecs="vp9, opus"', 'video/webm; codecs="vp8, vorbis"', 'video/webm; codecs="vp9"'],
};

function resolveType(mimeType) {
  if (MediaSource.isTypeSupported(mimeType)) return mimeType;
  const base = mimeType.split(';')[0].trim();
  if (MediaSource.isTypeSupported(base)) return base;
  const fallbacks = CODEC_FALLBACKS[base] || [];
  return fallbacks.find(t => MediaSource.isTypeSupported(t)) || null;
}

function setupMediaSource(mimeType) {
  const type = resolveType(mimeType);

  if (!type) {
    showError('Formato não suportado', `O formato "${mimeType.split(';')[0]}" não é compatível com este browser. Use WebM (VP9) ou MP4 H.264.`);
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
        const removeEnd = end - 30 > start ? end - 30 : Math.max(start, player.currentTime - 1);
        if (removeEnd > start) {
          sourceBuffer.remove(start, removeEnd);
          queue.unshift(chunk);
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
    if (attempts++ > 50) return;
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
  loading.style.display = 'none';
  overlayStatus.classList.add('visible');
  overlayViewers.classList.add('visible');
}

function showError(title, msg) {
  loading.style.display = 'none';
  overlayStatus.classList.remove('visible');
  overlayViewers.classList.remove('visible');
  queue.length = 0;
  watchError.style.display = 'flex';
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
          streamState.textContent = 'Ao vivo';
          break;
        case 'buffer':
          streamState.textContent = `Sincronizando…`;
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
          queue.length = 0;
          playAttempted = false;
          if (sourceBuffer && mediaSource && mediaSource.readyState === 'open') {
            if (sourceBuffer.updating) sourceBuffer.abort();
            if (sourceBuffer.buffered.length > 0) {
              try { sourceBuffer.remove(0, Infinity); } catch (_) {}
            }
          }
          streamState.textContent = 'Sincronizando…';
          break;
        case 'end':
          ended = true;
          endStream();
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
