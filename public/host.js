const CHUNK_SIZE = 256 * 1024; // 256KB

// ── State ─────────────────────────────────────────────────────────────────────
let ws = null;
let file = null;
let offset = 0;
let paused = false;
let waitingAck = false;
let streamEnded = false;
let fileFullySent = false;
let roomReady = false;
let timerInterval = null;
let streamStartTime = null;
let totalPausedMs = 0;
let pausedAt = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const stepSelect   = document.getElementById('step-select');
const stepLive     = document.getElementById('step-live');
const stepDone     = document.getElementById('step-done');
const fileName     = document.getElementById('file-name');
const viewerCount  = document.getElementById('viewer-count');
const progressText = document.getElementById('progress-text');
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

function formatTime(totalSec) {
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function startTimer() {
  stopTimer();
  timerInterval = setInterval(() => {
    if (!streamStartTime || paused) return;
    const elapsed = (Date.now() - streamStartTime - totalPausedMs) / 1000;
    progressText.textContent = formatTime(elapsed);
  }, 500);
}

function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
}

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
  if (ws) { ws.onclose = null; ws.onerror = null; ws.close(); }
  stopTimer();

  file = selectedFile;
  offset = 0;
  paused = false;
  waitingAck = false;
  streamEnded = false;
  fileFullySent = false;
  roomReady = false;
  streamStartTime = null;
  totalPausedMs = 0;
  pausedAt = null;

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
      if (!paused && !streamEnded) sendNextChunk();
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

  const slice = file.slice(offset, offset + CHUNK_SIZE);
  const reader = new FileReader();
  reader.onload = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN || paused || streamEnded) return;

    if (!streamStartTime) {
      streamStartTime = Date.now();
      startTimer();
    }

    ws.send(e.target.result);
    waitingAck = true;
    offset += e.target.result.byteLength;

    if (offset >= file.size) {
      fileFullySent = true;
      btnPause.textContent = '■ Encerrar';
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

  if (fileFullySent) {
    streamEnded = true;
    ws.send(JSON.stringify({ type: 'end' }));
    showDone();
    return;
  }

  paused = !paused;

  if (paused) {
    pausedAt = Date.now();
  } else {
    if (pausedAt) { totalPausedMs += Date.now() - pausedAt; pausedAt = null; }
    sendNextChunk();
  }

  ws.send(JSON.stringify({ type: paused ? 'pause' : 'resume' }));
  btnPause.textContent = paused ? '▶ Retomar' : '⏸ Pausar';
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
  stopTimer();
  stepDone.classList.add('hidden');
  stepSelect.classList.remove('hidden');
  fileInput.value = '';
  progressText.textContent = '0:00';
  viewerCount.textContent = '0';
  file = null;
  ws = null;
  roomReady = false;
  streamEnded = false;
  fileFullySent = false;
  streamStartTime = null;
  totalPausedMs = 0;
  pausedAt = null;
});

function showDone() {
  stopTimer();
  stepLive.classList.add('hidden');
  stepDone.classList.remove('hidden');
}
