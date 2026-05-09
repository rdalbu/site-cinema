const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Importamos createApp separado para não iniciar o servidor nos testes
const { createApp, UPLOAD_DIR } = require('../server');

describe('GET /', () => {
  it('responde 200 com HTML', async () => {
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});

describe('POST /api/upload', () => {
  it('retorna 400 se nenhum arquivo for enviado', async () => {
    const app = createApp();
    const res = await request(app).post('/api/upload');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('faz upload de um arquivo e retorna filename e url', async () => {
    const app = createApp();
    const tmpFile = path.join(__dirname, 'test-video.mp4');
    fs.writeFileSync(tmpFile, 'fake video content');

    const res = await request(app)
      .post('/api/upload')
      .attach('video', tmpFile);

    fs.unlinkSync(tmpFile);
    if (res.body.filename) {
      const uploaded = path.join(UPLOAD_DIR, res.body.filename);
      if (fs.existsSync(uploaded)) fs.unlinkSync(uploaded);
    }

    expect(res.status).toBe(200);
    expect(res.body.filename).toBeDefined();
    expect(res.body.url).toMatch(/\/video\//);
  });
});

describe('GET /video/:filename', () => {
  const testFile = 'test-stream.mp4';
  const testFilePath = path.join(UPLOAD_DIR, testFile);

  beforeEach(() => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(testFilePath, 'fake video bytes for streaming test');
  });

  afterEach(() => {
    if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath);
  });

  it('retorna 200 e o conteúdo do vídeo', async () => {
    const app = createApp();
    const res = await request(app).get(`/video/${testFile}`);
    expect(res.status).toBe(200);
  });

  it('retorna 404 para arquivo inexistente', async () => {
    const app = createApp();
    const res = await request(app).get('/video/nao-existe.mp4');
    expect(res.status).toBe(404);
  });
});
