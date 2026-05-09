const WebSocket = require('ws');
const http = require('http');
const request = require('supertest');
const { createApp, createServer, createRoom, addChunk, generateRoomId } = require('../server');

jest.setTimeout(15000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRooms() {
  return new Map();
}

function startServer() {
  return new Promise(resolve => {
    const rooms = makeRooms();
    const app = createApp(rooms);
    const server = createServer(app, rooms);
    server._rooms = rooms;

    server._drainHttpViewers = () => {
      for (const room of rooms.values()) {
        room.httpViewers.forEach(res => { try { res.end(); } catch (_) {} });
        room.httpViewers.clear();
      }
    };

    server.listen(0, () => resolve(server));
  });
}

function closeServer(server) {
  server._drainHttpViewers();
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}

function wsConnect(server, params) {
  const port = server.address().port;
  const qs = new URLSearchParams(params).toString();
  const ws = new WebSocket(`ws://localhost:${port}/ws?${qs}`);
  ws.binaryType = 'arraybuffer';
  return ws;
}

/**
 * Attach a message queue to ws immediately after creation.
 * Use nextMsg() to await the next JSON message in order.
 * Binary messages are stored separately in ws._binary[].
 */
function attachQueue(ws) {
  ws._jsonQueue = [];
  ws._jsonWaiters = [];
  ws._binary = [];
  ws._binaryWaiters = [];

  ws.on('message', data => {
    const str = Buffer.isBuffer(data) ? data.toString() : (typeof data === 'string' ? data : null);
    if (str) {
      let parsed;
      try { parsed = JSON.parse(str); } catch { return; }
      if (ws._jsonWaiters.length) {
        ws._jsonWaiters.shift()(parsed);
      } else {
        ws._jsonQueue.push(parsed);
      }
    } else {
      if (ws._binaryWaiters.length) {
        ws._binaryWaiters.shift()(data);
      } else {
        ws._binary.push(data);
      }
    }
  });
}

function nextMsg(ws) {
  if (ws._jsonQueue.length) return Promise.resolve(ws._jsonQueue.shift());
  return new Promise((resolve, reject) => {
    const onError = err => { ws._jsonWaiters = ws._jsonWaiters.filter(r => r !== resolve); reject(err); };
    const resolver = msg => { ws.removeListener('error', onError); resolve(msg); };
    ws._jsonWaiters.push(resolver);
    ws.once('error', onError);
  });
}

function nextBin(ws) {
  if (ws._binary.length) return Promise.resolve(ws._binary.shift());
  return new Promise((resolve, reject) => {
    const onError = err => { ws._binaryWaiters = ws._binaryWaiters.filter(r => r !== resolve); reject(err); };
    const resolver = data => { ws.removeListener('error', onError); resolve(data); };
    ws._binaryWaiters.push(resolver);
    ws.once('error', onError);
  });
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function collectAllMessages(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    ws.on('message', data => {
      const str = Buffer.isBuffer(data) ? data.toString() : (typeof data === 'string' ? data : null);
      if (str) {
        try { msgs.push(JSON.parse(str)); } catch {}
      }
    });
    ws.on('close', () => { clearTimeout(timer); resolve(msgs); });
    ws.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ── Unit tests — room management ─────────────────────────────────────────────

describe('generateRoomId', () => {
  it('gera ID de 6 caracteres alfanuméricos maiúsculos', () => {
    const id = generateRoomId();
    expect(id).toHaveLength(6);
    expect(id).toMatch(/^[A-Z0-9]{6}$/);
  });

  it('gera IDs únicos em chamadas sucessivas', () => {
    const ids = new Set(Array.from({ length: 100 }, generateRoomId));
    expect(ids.size).toBeGreaterThan(90);
  });
});

describe('createRoom', () => {
  it('retorna estrutura correta', () => {
    const room = createRoom('video/webm');
    expect(room.mimeType).toBe('video/webm');
    expect(room.broadcaster).toBeNull();
    expect(room.viewers).toBeInstanceOf(Set);
    expect(room.httpViewers).toBeInstanceOf(Set);
    expect(room.buffer).toEqual([]);
  });
});

describe('addChunk', () => {
  it('adiciona chunk ao buffer', () => {
    const room = createRoom('video/webm');
    addChunk(room, Buffer.from('a'));
    expect(room.buffer).toHaveLength(1);
  });

  it('acumula múltiplos chunks', () => {
    const room = createRoom('video/webm');
    addChunk(room, Buffer.from('a'));
    addChunk(room, Buffer.from('b'));
    addChunk(room, Buffer.from('c'));
    expect(room.buffer).toHaveLength(3);
  });
});

// ── Integration tests — WebSocket ─────────────────────────────────────────────

describe('WebSocket — host cria sala', () => {
  let server;
  beforeEach(async () => { server = await startServer(); });
  afterEach(() => closeServer(server));

  it('recebe roomId após enviar create', async () => {
    const ws = wsConnect(server, { role: 'host' });
    attachQueue(ws);
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: 'create', mimeType: 'video/webm' }));
    const msg = await nextMsg(ws);
    expect(msg.type).toBe('room');
    expect(msg.roomId).toMatch(/^[A-Z0-9]{6}$/);
    ws.close();
  });
});

describe('WebSocket — viewer conecta em sala inexistente', () => {
  let server;
  beforeEach(async () => { server = await startServer(); });
  afterEach(() => closeServer(server));

  it('recebe erro e conexão é fechada', async () => {
    const ws = wsConnect(server, { role: 'viewer', room: 'NAOEXISTE' });
    const msgs = await collectAllMessages(ws, 5000);
    expect(msgs.some(m => m.type === 'error')).toBe(true);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('WebSocket — viewer recebe init e mensagens de controle', () => {
  let server;
  let openSockets;

  beforeEach(async () => {
    server = await startServer();
    openSockets = [];
  });

  afterEach(async () => {
    // Close all sockets explicitly before closing the server
    openSockets.forEach(ws => { try { ws.terminate(); } catch (_) {} });
    await closeServer(server);
  });

  function track(ws) { openSockets.push(ws); return ws; }

  it('viewer recebe init com mimeType correto', async () => {
    const host = track(wsConnect(server, { role: 'host' }));
    attachQueue(host);
    await waitOpen(host);
    host.send(JSON.stringify({ type: 'create', mimeType: 'video/mp4' }));
    const roomMsg = await nextMsg(host);
    const { roomId } = roomMsg;

    // Attach queue BEFORE connecting so no messages are missed
    const viewer = track(wsConnect(server, { role: 'viewer', room: roomId }));
    attachQueue(viewer);
    await waitOpen(viewer);

    // Drain messages until we see 'init' (skip 'viewers' count if it arrives first)
    let initMsg = null;
    for (let i = 0; i < 5; i++) {
      const m = await nextMsg(viewer);
      if (m.type === 'init') { initMsg = m; break; }
    }
    expect(initMsg).not.toBeNull();
    expect(initMsg.mimeType).toBe('video/mp4');
  });

  it('host envia pause e viewer recebe evento de controle', async () => {
    const host = track(wsConnect(server, { role: 'host' }));
    attachQueue(host);
    await waitOpen(host);
    host.send(JSON.stringify({ type: 'create', mimeType: 'video/mp4' }));
    const { roomId } = await nextMsg(host);

    const viewer = track(wsConnect(server, { role: 'viewer', room: roomId }));
    attachQueue(viewer);
    await waitOpen(viewer);

    // Drain init + any viewers messages
    let seenInit = false;
    while (!seenInit) {
      const m = await nextMsg(viewer);
      if (m.type === 'init') seenInit = true;
    }
    // Consume any pending viewers-count messages
    await new Promise(r => setTimeout(r, 50));

    host.send(JSON.stringify({ type: 'pause' }));

    // Wait for pause message (skip any viewers count messages)
    let pauseMsg = null;
    for (let i = 0; i < 5; i++) {
      const m = await nextMsg(viewer);
      if (m.type === 'pause') { pauseMsg = m; break; }
    }
    expect(pauseMsg).not.toBeNull();
  });

  it('host envia chunk binário — viewer NÃO recebe binário (só controle via WS)', async () => {
    const host = track(wsConnect(server, { role: 'host' }));
    attachQueue(host);
    await waitOpen(host);
    host.send(JSON.stringify({ type: 'create', mimeType: 'video/mp4' }));
    const { roomId } = await nextMsg(host);

    const viewer = track(wsConnect(server, { role: 'viewer', room: roomId }));
    attachQueue(viewer);
    await waitOpen(viewer);

    // Drain init
    let seenInit = false;
    while (!seenInit) {
      const m = await nextMsg(viewer);
      if (m.type === 'init') seenInit = true;
    }

    host.send(Buffer.from('fake video chunk'));
    // Wait for ack
    let seenAck = false;
    while (!seenAck) {
      const m = await nextMsg(host);
      if (m.type === 'ack') seenAck = true;
    }

    // Give a moment for any binary relay to arrive
    await new Promise(r => setTimeout(r, 200));
    expect(viewer._binary).toHaveLength(0);
  });
});

describe('WebSocket — host chunks acumulados no buffer da sala', () => {
  let server;
  beforeEach(async () => { server = await startServer(); });
  afterEach(() => closeServer(server));

  it('dois chunks enviados pelo host ficam no buffer da sala', async () => {
    const host = wsConnect(server, { role: 'host' });
    attachQueue(host);
    await waitOpen(host);
    host.send(JSON.stringify({ type: 'create', mimeType: 'video/mp4' }));
    const { roomId } = await nextMsg(host);

    host.send(Buffer.from('chunk1'));
    let ack1 = false;
    while (!ack1) { const m = await nextMsg(host); if (m.type === 'ack') ack1 = true; }

    host.send(Buffer.from('chunk2'));
    let ack2 = false;
    while (!ack2) { const m = await nextMsg(host); if (m.type === 'ack') ack2 = true; }

    const room = server._rooms.get(roomId);
    expect(room).toBeDefined();
    expect(room.buffer).toHaveLength(2);

    host.terminate();
  });
});

// ── HTTP ──────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('serve index.html com status 200', async () => {
    const rooms = makeRooms();
    const app = createApp(rooms);
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });
});

describe('GET /stream/:roomId', () => {
  it('retorna 404 para sala inexistente', async () => {
    const rooms = makeRooms();
    const app = createApp(rooms);
    const res = await request(app).get('/stream/NAOEXISTE');
    expect(res.status).toBe(404);
  });

  it('retorna Content-Type correto e buffer acumulado para sala existente', done => {
    const rooms = makeRooms();
    const app = createApp(rooms);

    const roomId = 'TEST01';
    const room = createRoom('video/mp4');
    addChunk(room, Buffer.from('fakechunk1'));
    addChunk(room, Buffer.from('fakechunk2'));
    rooms.set(roomId, room);

    const srv = http.createServer(app);
    srv.listen(0, () => {
      const port = srv.address().port;
      const chunks = [];

      const req = http.get(`http://localhost:${port}/stream/${roomId}`, res => {
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toMatch('video/mp4');

        res.on('data', d => chunks.push(d));

        setTimeout(() => {
          req.destroy();
          // Close open HTTP viewers so srv.close() can resolve
          room.httpViewers.forEach(r => { try { r.end(); } catch (_) {} });
          room.httpViewers.clear();
          srv.closeAllConnections();
          srv.close(() => {
            const body = Buffer.concat(chunks).toString();
            expect(body).toContain('fakechunk1');
            expect(body).toContain('fakechunk2');
            done();
          });
        }, 300);
      });

      req.on('error', err => {
        if (err.code !== 'ECONNRESET') done(err);
        else done();
      });
    });
  });
});
