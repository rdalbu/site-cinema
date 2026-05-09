const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const EXPIRE_HOURS = parseInt(process.env.EXPIRE_HOURS || '24', 10);

function createApp() {
  const app = express();

  // Garante que a pasta uploads existe
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  app.use(express.static(path.join(__dirname, 'public')));

  const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const timestamp = Date.now();
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${timestamp}-${safe}`);
    }
  });

  const upload = multer({ storage });

  app.post('/api/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
    }
    res.json({
      filename: req.file.filename,
      url: `/video/${req.file.filename}`
    });
  });

  app.get('/video/:filename', (req, res) => {
    const filename = path.basename(req.params.filename); // evita path traversal
    const filePath = path.join(UPLOAD_DIR, filename);

    fs.stat(filePath, (err, stat) => {
      if (err) return res.status(404).json({ error: 'Vídeo não encontrado.' });

      const fileSize = stat.size;
      const range = req.headers.range;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        if (isNaN(start) || isNaN(end) || start > end || start >= fileSize) {
          return res.status(416).set('Content-Range', `bytes */${fileSize}`).end();
        }

        const chunkSize = end - start + 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4'
        });
        fs.createReadStream(filePath, { start, end })
          .on('error', () => res.destroy())
          .pipe(res);
      } else {
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(filePath)
          .on('error', () => res.destroy())
          .pipe(res);
      }
    });
  });

  return app;
}

// Só inicia o servidor se executado diretamente (não nos testes)
if (require.main === module) {
  const app = createApp();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Cinema Drive-in rodando na porta ${PORT}`);
  });
}

module.exports = { createApp, UPLOAD_DIR, EXPIRE_HOURS };
