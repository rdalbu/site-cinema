const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const MAX_BUFFER_CHUNKS = parseInt(process.env.MAX_BUFFER_CHUNKS || '30', 10);

// ── Room management (pure, testable) ─────────────────────────────────────────

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createRoom(mimeType) {
  return { mimeType, broadcaster: null, viewers: new Set(), buffer: [] };
}

function addChunk(room, chunk) {
  room.buffer.push(chunk);
  if (room.buffer.length > MAX_BUFFER_CHUNKS) room.buffer.shift();
}

function broadcastToViewers(room, data) {
  room.viewers.forEach(v => {
    if (v.readyState === WebSocket.OPEN) v.send(data);
  });
}

function notifyViewerCount(room) {
  const msg = JSON.stringify({ type: 'viewers', count: room.viewers.size });
  if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
    room.broadcaster.send(msg);
  }
  broadcastToViewers(room, msg);
}

function cleanupRoom(roomId, rooms) {
  const room = rooms.get(roomId);
  if (!room) return;
  room.viewers.forEach(v => { if (v.readyState === WebSocket.OPEN) v.close(); });
  rooms.delete(roomId);
}

// ── WebSocket handlers ────────────────────────────────────────────────────────

function handleHost(ws, rooms) {
  let roomId = null;

  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === 'create') {
        roomId = generateRoomId();
        const room = createRoom(msg.mimeType || 'video/mp4');
        room.broadcaster = ws;
        rooms.set(roomId, room);
        ws.send(JSON.stringify({ type: 'room', roomId }));
      } else if (msg.type === 'pause' || msg.type === 'resume') {
        const room = rooms.get(roomId);
        if (room) broadcastToViewers(room, JSON.stringify({ type: msg.type }));
      } else if (msg.type === 'seek') {
        const room = rooms.get(roomId);
        if (room) {
          room.buffer = []; // stale data irrelevant after seek
          broadcastToViewers(room, JSON.stringify({ type: 'seek' }));
        }
      } else if (msg.type === 'end') {
        const room = rooms.get(roomId);
        if (room) broadcastToViewers(room, JSON.stringify({ type: 'end' }));
        cleanupRoom(roomId, rooms);
        roomId = null;
      }
    } else {
      const room = rooms.get(roomId);
      if (!room) return;
      addChunk(room, data);
      broadcastToViewers(room, data);
      ws.send(JSON.stringify({ type: 'ack' }));
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) broadcastToViewers(room, JSON.stringify({ type: 'end' }));
    cleanupRoom(roomId, rooms);
  });
}

function handleViewer(ws, roomId, rooms) {
  const room = rooms.get(roomId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Sala não encontrada.' }));
    ws.close();
    return;
  }

  ws.send(JSON.stringify({ type: 'init', mimeType: room.mimeType }));

  if (room.buffer.length > 0) {
    ws.send(JSON.stringify({ type: 'buffer', chunks: room.buffer.length }));
    room.buffer.forEach(chunk => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
  }

  room.viewers.add(ws);
  notifyViewerCount(room);

  ws.on('close', () => {
    room.viewers.delete(ws);
    if (rooms.has(roomId)) notifyViewerCount(room);
  });
}

// ── Express app ───────────────────────────────────────────────────────────────

function createApp() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/watch/:roomId', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
  });
  return app;
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

function createServer(app) {
  const httpServer = http.createServer(app);
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });
  const rooms = new Map();

  wss.on('connection', (ws, req) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch {
      ws.close(1008, 'Bad URL');
      return;
    }
    const role = url.searchParams.get('role');
    const roomId = url.searchParams.get('room');

    if (role === 'host') {
      handleHost(ws, rooms);
    } else if (role === 'viewer' && roomId) {
      handleViewer(ws, roomId, rooms);
    } else {
      ws.close(1008, 'Missing role or room');
    }
  });

  return httpServer;
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (require.main === module) {
  const app = createApp();
  const server = createServer(app);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Cinema Drive-in na porta ${PORT}`);
  });
}

module.exports = {
  createApp,
  createServer,
  createRoom,
  addChunk,
  generateRoomId,
  MAX_BUFFER_CHUNKS
};
