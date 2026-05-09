const WebSocket = require('ws');
const request = require('supertest');
const { createApp, createServer, createRoom, addChunk, generateRoomId, MAX_BUFFER_CHUNKS } = require('../server');

jest.setTimeout(10000);

// ── Helpers ───────────────────────────────────────────────────────────────────

function startServer() {
  return new Promise(resolve => {
    const app = createApp();
    const server = createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function wsConnect(server, params) {
  const port = server.address().port;
  const qs = new URLSearchParams(params).toString();
  const ws = new WebSocket(`ws://localhost:${port}/ws?${qs}`);
  ws.binaryType = 'arraybuffer';
  return ws;
}

function waitMessage(ws) {
  return new Promise((resolve, reject) => {
    ws.once('message', data => {
      const str = Buffer.isBuffer(data) ? data.toString() : (typeof data === 'string' ? data : null);
      if (str) {
        try { return resolve(JSON.parse(str)); } catch {}
      }
      resolve(data);
    });
    ws.once('error', reject);
  });
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

/**
 * Collect all JSON messages until the socket closes (or timeout).
 * Resolves with an array of parsed JSON objects.
 */
function collectMessages(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const msgs = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);

    ws.on('message', data => {
      const str = Buffer.isBuffer(data) ? data.toString() : (typeof data === 'string' ? data : null);
      if (str) {
        try { msgs.push(JSON.parse(str)); } catch {}
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      resolve(msgs);
    });

    ws.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
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
    expect(room.buffer).toEqual([]);
  });
});

describe('addChunk', () => {
  it('adiciona chunk ao buffer', () => {
    const room = createRoom('video/webm');
    addChunk(room, Buffer.from('a'));
    expect(room.buffer).toHaveLength(1);
  });

  it('respeita MAX_BUFFER_CHUNKS removendo o mais antigo', () => {
    const room = createRoom('video/webm');
    for (let i = 0; i <= MAX_BUFFER_CHUNKS; i++) {
      addChunk(room, Buffer.from(`chunk${i}`));
    }
    expect(room.buffer).toHaveLength(MAX_BUFFER_CHUNKS);
    expect(room.buffer[0].toString()).toBe('chunk1');
  });
});

// ── Integration tests — WebSocket ─────────────────────────────────────────────

describe('WebSocket — host cria sala', () => {
  let server;
  beforeEach(async () => { server = await startServer(); });
  afterEach(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });

  it('recebe roomId após enviar create', async () => {
    const ws = wsConnect(server, { role: 'host' });
    await waitOpen(ws);
    ws.send(JSON.stringify({ type: 'create', mimeType: 'video/webm' }));
    const msg = await waitMessage(ws);
    expect(msg.type).toBe('room');
    expect(msg.roomId).toMatch(/^[A-Z0-9]{6}$/);
    ws.close();
  });
});

describe('WebSocket — viewer conecta em sala inexistente', () => {
  let server;
  beforeEach(async () => { server = await startServer(); });
  afterEach(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });

  it('recebe erro e conexão é fechada', async () => {
    const ws = wsConnect(server, { role: 'viewer', room: 'NAOEXISTE' });
    // Use collectMessages which handles open/message/close in any order
    const msgs = await collectMessages(ws, 5000);
    expect(msgs.some(m => m.type === 'error')).toBe(true);
    // Socket must be closed (readyState CLOSED = 3)
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('WebSocket — relay host → viewer', () => {
  let server;
  beforeEach(async () => { server = await startServer(); });
  afterEach(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });

  it('chunk binário enviado pelo host chega ao viewer', async () => {
    const host = wsConnect(server, { role: 'host' });
    await waitOpen(host);
    host.send(JSON.stringify({ type: 'create', mimeType: 'video/webm' }));
    const roomMsg = await waitMessage(host);
    const { roomId } = roomMsg;

    // Set up viewer message collector BEFORE connecting so no messages are missed
    const viewer = wsConnect(server, { role: 'viewer', room: roomId });
    const viewerMsgs = []; // collected JSON messages
    const viewerBinary = []; // collected binary messages
    let viewerMsgResolvers = [];
    let viewerBinResolvers = [];

    viewer.on('message', data => {
      const str = Buffer.isBuffer(data) ? data.toString() : (typeof data === 'string' ? data : null);
      if (str) {
        try {
          const msg = JSON.parse(str);
          viewerMsgs.push(msg);
          if (viewerMsgResolvers.length) viewerMsgResolvers.shift()(msg);
          return;
        } catch {}
      }
      viewerBinary.push(data);
      if (viewerBinResolvers.length) viewerBinResolvers.shift()(data);
    });

    const nextViewerMsg = () => viewerMsgs.length
      ? Promise.resolve(viewerMsgs.shift())
      : new Promise(r => viewerMsgResolvers.push(r));
    const nextViewerBin = () => viewerBinary.length
      ? Promise.resolve(viewerBinary.shift())
      : new Promise(r => viewerBinResolvers.push(r));

    await waitOpen(viewer);

    const initMsg = await nextViewerMsg();
    expect(initMsg.type).toBe('init');
    expect(initMsg.mimeType).toBe('video/webm');

    const chunk = Buffer.from('fake video chunk data');
    host.send(chunk);

    const received = await nextViewerBin();
    expect(Buffer.isBuffer(received) || received instanceof ArrayBuffer).toBe(true);

    host.close();
    viewer.close();
  });

  it('viewer que entra depois recebe buffer acumulado', async () => {
    const host = wsConnect(server, { role: 'host' });
    await waitOpen(host);
    host.send(JSON.stringify({ type: 'create', mimeType: 'video/webm' }));
    const { roomId } = await waitMessage(host);

    host.send(Buffer.from('chunk1'));
    await waitMessage(host); // ack
    host.send(Buffer.from('chunk2'));
    await waitMessage(host); // ack

    // Collect ALL messages from viewer before and after open to avoid race
    const viewer = wsConnect(server, { role: 'viewer', room: roomId });
    const allMsgs = await new Promise((resolve, reject) => {
      const collected = [];
      const timer = setTimeout(() => resolve(collected), 3000);
      viewer.on('message', data => {
        const str = Buffer.isBuffer(data) ? data.toString() : (typeof data === 'string' ? data : null);
        if (!str) return;
        try {
          const msg = JSON.parse(str);
          collected.push(msg);
          if (msg.type === 'buffer') {
            clearTimeout(timer);
            // Wait a tiny bit for any remaining messages then resolve
            setTimeout(() => resolve(collected), 100);
          }
        } catch {}
      });
      viewer.on('error', reject);
    });

    const bufferMsg = allMsgs.find(m => m.type === 'buffer');
    expect(bufferMsg).toBeDefined();
    expect(bufferMsg.chunks).toBe(2);

    host.close();
    viewer.close();
  });
});

// ── HTTP ──────────────────────────────────────────────────────────────────────

describe('GET /', () => {
  it('serve index.html com status 200', async () => {
    const app = createApp();
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
  });
});
