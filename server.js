const express = require('express');
const path = require('path');
const fs = require('fs');

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const EXPIRE_HOURS = parseInt(process.env.EXPIRE_HOURS || '24', 10);

function createApp() {
  const app = express();

  // Garante que a pasta uploads existe
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }

  app.use(express.static(path.join(__dirname, 'public')));

  const multer = require('multer');

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
