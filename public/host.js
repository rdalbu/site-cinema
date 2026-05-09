const CHUNK_SIZE = 256 * 1024; // 256KB

// ── State ─────────────────────────────────────────────────────────────────────
let ws = null;
let file = null;
let offset = 0;
let paused = false;
let waitingAck = false;
let streamEnded = false;
let roomReady = false;

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
const btnStop      = document.getElementById('btn-stop');
const btnRestart   = document.getElementById('btn-restart');
const hostPlayer   = document.getElementById('host-player');
const toast        = document.getElementById('toast');

// ── Helpers ───────────────────────────────────────────────────────────────────
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

function formatTime(s) {
  const sec = Math.floor(s) || 0;
  const m = Math.floor(sec / 60);
  return `${m}:${String(sec % 60).padStart(2, '0')}`;
}

// ── Local player events (registered once) ─────────────────────────────────────
hostPlayer.addEventListener('loadedmetadata', () => {
  progressText.textContent = `0:00 / ${formatTime(hostPlayer.duration)}`;
});

hostPlayer.addEventListener('timeupdate', () => {
  if (!file) return;
  progressText.textContent = `${formatTime(hostPlayer.currentTime)} / ${formatTime(hostPlayer.duration || 0)}`;
});

hostPlayer.addEventListener('seeked', () => {
  if (!file || !ws || ws.readyState !== WebSocket.OPEN || streamEnded || paused) return;
  const ratio = hostPlayer.currentTime / (hostPlayer.duration || 1);
  offset = Math.floor(ratio * file.size);
  waitingAck = false;
  ws.send(JSON.stringify({ type: 'seek', time: hostPlayer.currentTime }));
  sendNextChunk();
});

// ── File selection ────────────────────────────────────────────────────────────
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const f = e.dataTransfer.files[0];
  if (f) startStream(f);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) startStream(fileInput.files[0]);
});

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

  const mimeType = file.type || 'video/mp4';
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?role=host`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'create', mimeType }));
  };

  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'room') {
      roomReady = true;
      const url = `${location.origin}/watch/${msg.roomId}`;
      shareUrl.textContent = url;
      fileName.textContent = file.name;
      hostPlayer.src = URL.createObjectURL(file);
      stepSelect.classList.add('hidden');
      stepLive.classList.remove('hidden');
      sendNextChunk();
    } else if (msg.type === 'ack') {
      waitingAck = false;
      if (!paused && !streamEnded) sendNextChunk();
    } else if (msg.type === 'viewers') {
      viewerCount.textContent = msg.count;
    }
  };

  ws.onclose = () => {
    if (streamEnded) return;
    if (roomReady) {
      showDone();
    } else {
      showToast('Falha ao conectar com o servidor.');
    }
  };

  ws.onerror = () => showToast('Erro de conexão WebSocket.');
}

function sendNextChunk() {
  if (!file || offset >= file.size || paused || waitingAck || streamEnded) return;

  const slice = file.slice(offset, offset + CHUNK_SIZE);
  const reader = new FileReader();
  reader.onload = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || paused || streamEnded) return;
    ws.send(e.target.result);
    waitingAck = true;
    offset += e.target.result.byteLength;

    const pct = Math.min(100, Math.round((offset / file.size) * 100));
    progressBar.style.width = pct + '%';

    if (offset >= file.size) {
      streamEnded = true;
      ws.send(JSON.stringify({ type: 'end' }));
      showDone();
    }
  };
  reader.onerror = () => {
    showToast('Erro ao ler o arquivo. Tente novamente.');
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

btnStop.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  streamEnded = true;
  ws.send(JSON.stringify({ type: 'end' }));
  ws.close();
  showDone();
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
  progressText.textContent = '0:00 / 0:00';
  viewerCount.textContent = '0';
  hostPlayer.src = '';
  file = null;
  ws = null;
  roomReady = false;
  streamEnded = false;
});

function showDone() {
  stepLive.classList.add('hidden');
  stepDone.classList.remove('hidden');
}
