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
  afterEach(() => {
    // Limpa uploads de teste
    if (fs.existsSync(UPLOAD_DIR)) {
      fs.readdirSync(UPLOAD_DIR).forEach(f => {
        if (f.startsWith('test-')) fs.unlinkSync(path.join(UPLOAD_DIR, f));
      });
    }
  });

  it('retorna 400 se nenhum arquivo for enviado', async () => {
    const app = createApp();
    const res = await request(app).post('/api/upload');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
  });

  it('faz upload de um arquivo e retorna filename e url', async () => {
    const app = createApp();
    // Cria um arquivo temporário de teste
    const tmpFile = path.join(__dirname, 'test-video.mp4');
    fs.writeFileSync(tmpFile, 'fake video content');

    const res = await request(app)
      .post('/api/upload')
      .attach('video', tmpFile);

    fs.unlinkSync(tmpFile);

    expect(res.status).toBe(200);
    expect(res.body.filename).toBeDefined();
    expect(res.body.url).toMatch(/\/video\//);
  });
});
