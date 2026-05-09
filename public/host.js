const CHUNK_SIZE = 256 * 1024; // 256KB
const BUFFER_AHEAD_SEC = 30;   // segundos à frente do tempo real permitidos

// ── State ─────────────────────────────────────────────────────────────────────
let ws = null;
let file = null;
let offset = 0;
let paused = false;
let waitingAck = false;
let streamEnded = false;
let roomReady = false;
let streamStartTime = null; // relógio real de quando o primeiro chunk foi enviado

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const stepSelect   = document.getElementById('step-select');
const stepLive     = document.getElementById('step-live');
const stepDone     = document.getElementById('step-done');
const fileName     = document.getElementById('file-name');
const viewerCount  = document.getElementById('viewer-count');
const progressText = document.getElementById('progress-text');
const progressBar  = document.getElementById('progress-bar');
const shareUrl     = document.getElementById('share-url');
const btnCopy      = document.getElementById('btn-copy');
const btnPause     = document.getElementById('btn-pause');
const btnRestart   = document.getElementById('btn-restart');
const toast        = document.getElementById('toast');

// ── Helpers ───────────────────────────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// Quantos ms esperar: compara posição estimada no vídeo vs tempo real decorrido
function throttleDelayMs() {
  if (!streamStartTime || !file || !file._duration) return 0;
  const elapsed = (Date.now() - streamStartTime) / 1000;
  const streamPosSec = (offset / file.size) * file._duration;
  const ahead = streamPosSec - elapsed;
  return ahead > BUFFER_AHEAD_SEC ? (ahead - BUFFER_AHEAD_SEC) * 1000 : 0;
}

// ── File selection ────────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) loadAndStream(f);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadAndStream(fileInput.files[0]);
});

// Lê a duração do vídeo via elemento oculto antes de iniciar o stream
function loadAndStream(selectedFile) {
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.src = URL.createObjectURL(selectedFile);
  probe.onloadedmetadata = () => {
    selectedFile._duration = probe.duration || 0;
    URL.revokeObjectURL(probe.src);
    startStream(selectedFile);
  };
  probe.onerror = () => {
    selectedFile._duration = 0;
    startStream(selectedFile);
  };
}

// ── Stream ────────────────────────────────────────────────────────────────────
function startStream(selectedFile) {
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.close();
  }

  file = selectedFile;
  offset = 0;
  paused = false;
  waitingAck = false;
  streamEnded = false;
  roomReady = false;
  streamStartTime = null;

  const mimeType = file.type || 'video/mp4';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?role=host`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => ws.send(JSON.stringify({ type: 'create', mimeType }));

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'room') {
      roomReady = true;
      shareUrl.textContent = `${location.origin}/watch/${msg.roomId}`;
      fileName.textContent = file.name;
      stepSelect.classList.add('hidden');
      stepLive.classList.remove('hidden');
      sendNextChunk();
    } else if (msg.type === 'ack') {
      waitingAck = false;
      if (!paused && !streamEnded) {
        const delay = throttleDelayMs();
        delay > 0 ? setTimeout(sendNextChunk, delay) : sendNextChunk();
      }
    } else if (msg.type === 'viewers') {
      viewerCount.textContent = msg.count;
    }
  };

  ws.onclose = () => {
    if (streamEnded) return;
    if (roomReady) showDone();
    else showToast('Falha ao conectar com o servidor.');
  };

  ws.onerror = () => showToast('Erro de conexão WebSocket.');
}

function sendNextChunk() {
  if (!file || offset >= file.size || paused || waitingAck || streamEnded) return;

  const delay = throttleDelayMs();
  if (delay > 0) { setTimeout(sendNextChunk, delay); return; }

  const slice = file.slice(offset, offset + CHUNK_SIZE);
  const reader = new FileReader();
  reader.onload = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || paused || streamEnded) return;
    if (!streamStartTime) streamStartTime = Date.now();
    ws.send(e.target.result);
    waitingAck = true;
    offset += e.target.result.byteLength;

    const pct = Math.min(100, Math.round((offset / file.size) * 100));
    progressBar.style.width = pct + '%';
    progressText.textContent = pct + '%';

    if (offset >= file.size) {
      streamEnded = true;
      ws.send(JSON.stringify({ type: 'end' }));
      showDone();
    }
  };
  reader.onerror = () => {
    showToast('Erro ao ler o arquivo.');
    streamEnded = true;
  };
  reader.readAsArrayBuffer(slice);
}

// ── Controls ──────────────────────────────────────────────────────────────────
btnPause.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  paused = !paused;
  ws.send(JSON.stringify({ type: paused ? 'pause' : 'resume' }));
  btnPause.textContent = paused ? '▶ Retomar' : '⏸ Pausar';
  if (!paused) sendNextChunk();
});

btnCopy.addEventListener('click', () => {
  const url = shareUrl.textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).catch(() => copyFallback(url));
  } else {
    copyFallback(url);
  }
  showToast('Link copiado!');
});

function copyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

btnRestart.addEventListener('click', () => {
  stepDone.classList.add('hidden');
  stepSelect.classList.remove('hidden');
  fileInput.value = '';
  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  viewerCount.textContent = '0';
  file = null;
  ws = null;
  roomReady = false;
  streamEnded = false;
  streamStartTime = null;
});

function showDone() {
  stepLive.classList.add('hidden');
  stepDone.classList.remove('hidden');
}
