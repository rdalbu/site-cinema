const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const progressContainer = document.getElementById('progress-container');
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const videoList = document.getElementById('video-list');
const playerSection = document.getElementById('player-section');
const player = document.getElementById('player');
const playerTitle = document.getElementById('player-title');
const playerUrl = document.getElementById('player-url');
const toast = document.getElementById('toast');

// --- Toast ---
function showToast(msg, duration = 2500) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), duration);
}

// --- Drag & Drop ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) uploadFile(fileInput.files[0]);
});

// --- Upload ---
function uploadFile(file) {
  const formData = new FormData();
  formData.append('video', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');

  progressContainer.style.display = 'block';
  progressBar.style.width = '0';
  progressLabel.textContent = '0%';

  xhr.upload.addEventListener('progress', e => {
    if (e.lengthComputable) {
      const pct = Math.round((e.loaded / e.total) * 100);
      progressBar.style.width = pct + '%';
      progressLabel.textContent = pct + '%';
    }
  });

  xhr.addEventListener('load', () => {
    progressContainer.style.display = 'none';
    fileInput.value = '';
    if (xhr.status === 200) {
      showToast('Vídeo enviado!');
      loadVideos();
    } else {
      showToast('Erro no upload. Tente novamente.');
    }
  });

  xhr.addEventListener('error', () => {
    progressContainer.style.display = 'none';
    showToast('Erro de conexão.');
  });

  xhr.send(formData);
}

// --- Biblioteca ---
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function timeUntil(dateStr) {
  const diff = new Date(dateStr) - Date.now();
  if (diff <= 0) return 'expirando...';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `expira em ${h}h ${m}m`;
  return `expira em ${m}m`;
}

async function loadVideos() {
  const res = await fetch('/api/videos');
  const videos = await res.json();

  if (videos.length === 0) {
    videoList.innerHTML = '<li class="empty-state">Nenhum vídeo na biblioteca.</li>';
    return;
  }

  videoList.innerHTML = '';
  videos.forEach(v => {
    const li = document.createElement('li');
    li.className = 'video-item';
    li.dataset.filename = v.filename;

    const displayName = v.filename.replace(/^\d+-/, '');
    const fullUrl = window.location.origin + v.url;

    li.innerHTML = `
      <div class="info">
        <div class="name" title="${displayName}">${displayName}</div>
        <div class="meta">${formatBytes(v.size)} · ${timeUntil(v.expiresAt)}</div>
      </div>
      <div class="actions">
        <button class="btn-play" onclick="playVideo('${v.url}', '${displayName}', '${fullUrl}')">▶ Play</button>
        <button class="btn-copy" onclick="copyUrl('${fullUrl}')">Copiar URL</button>
        <button class="btn-delete" onclick="deleteVideo('${v.filename}', this)">Apagar</button>
      </div>
    `;
    videoList.appendChild(li);
  });
}

// --- Player ---
function playVideo(url, name, fullUrl) {
  player.src = url;
  player.play();
  playerTitle.textContent = name;
  playerUrl.textContent = fullUrl;
  playerSection.style.display = 'block';
  playerSection.scrollIntoView({ behavior: 'smooth' });
}

// --- Copy URL ---
function copyUrl(url) {
  navigator.clipboard.writeText(url).then(() => showToast('URL copiada!')).catch(() => {
    // fallback para navegadores sem clipboard API
    const ta = document.createElement('textarea');
    ta.value = url;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('URL copiada!');
  });
}

// --- Delete ---
async function deleteVideo(filename, btn) {
  if (!confirm('Apagar este vídeo?')) return;
  btn.disabled = true;

  const res = await fetch(`/api/videos/${encodeURIComponent(filename)}`, { method: 'DELETE' });

  if (res.ok) {
    showToast('Vídeo apagado.');
    if (player.src.includes(filename)) {
      player.pause();
      player.src = '';
      playerSection.style.display = 'none';
    }
    loadVideos();
  } else {
    showToast('Erro ao apagar.');
    btn.disabled = false;
  }
}

// Carrega a biblioteca ao iniciar
loadVideos();
