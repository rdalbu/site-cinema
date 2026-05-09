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

  it('retorna 206 com Content-Range para Range header válido', async () => {
    const app = createApp();
    const res = await request(app)
      .get(`/video/${testFile}`)
      .set('Range', 'bytes=0-9');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toMatch(/^bytes 0-9\//);
    expect(res.headers['content-type']).toBe('video/mp4');
  });
});

describe('GET /api/videos', () => {
  const testFile = 'test-list.mp4';

  beforeEach(() => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, testFile), 'fake');
  });

  afterEach(() => {
    const p = path.join(UPLOAD_DIR, testFile);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  it('retorna lista de vídeos com filename e expiresAt', async () => {
    const app = createApp();
    const res = await request(app).get('/api/videos');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const video = res.body.find(v => v.filename === testFile);
    expect(video).toBeDefined();
    expect(video.expiresAt).toBeDefined();
    expect(video.url).toMatch(/\/video\//);
  });
});

describe('DELETE /api/videos/:filename', () => {
  const testFile = 'test-delete.mp4';

  beforeEach(() => {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOAD_DIR, testFile), 'fake');
  });

  afterEach(() => {
    const p = path.join(UPLOAD_DIR, testFile);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });

  it('apaga o arquivo e retorna 200', async () => {
    const app = createApp();
    const res = await request(app).delete(`/api/videos/${testFile}`);
    expect(res.status).toBe(200);
    expect(fs.existsSync(path.join(UPLOAD_DIR, testFile))).toBe(false);
  });

  it('retorna 404 para arquivo inexistente', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/videos/nao-existe.mp4');
    expect(res.status).toBe(404);
  });
});
