const request = require('supertest');

// Importamos createApp separado para não iniciar o servidor nos testes
const { createApp } = require('../server');

describe('GET /', () => {
  it('responde 200 com HTML', async () => {
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
  });
});
