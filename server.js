const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');


// ── Room management (pure, testable) ─────────────────────────────────────────

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function createRoom(mimeType) {
  return {
    mimeType,
    broadcaster: null,
    viewers: new Set(),   // WebSocket viewers (control only)
    httpViewers: new Set(), // HTTP response objects for /stream/:roomId
    buffer: [],           // accumulated Buffer chunks from host
  };
}

function addChunk(room, chunk) {
  room.buffer.push(chunk);
}

// Send a chunk to all active HTTP stream viewers
function pushChunkToHttpViewers(room, chunk) {
  room.httpViewers.forEach(res => {
    try { res.write(chunk); } catch (_) {}
  });
}

function broadcastToViewers(room, data) {
  room.viewers.forEach(v => {
    if (v.readyState === WebSocket.OPEN) v.send(data);
  });
}

function notifyViewerCount(room) {
  const count = room.viewers.size + room.httpViewers.size;
  const msg = JSON.stringify({ type: 'viewers', count });
  if (room.broadcaster && room.broadcaster.readyState === WebSocket.OPEN) {
    room.broadcaster.send(msg);
  }
  broadcastToViewers(room, msg);
}

function cleanupRoom(roomId, rooms) {
  const room = rooms.get(roomId);
  if (!room) return;
  // Close all WS control viewers
  room.viewers.forEach(v => { if (v.readyState === WebSocket.OPEN) v.close(); });
  // End all HTTP stream responses
  room.httpViewers.forEach(res => { try { res.end(); } catch (_) {} });
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
          // Signal HTTP viewers to reconnect (they'll re-request /stream/:roomId)
          room.httpViewers.forEach(res => { try { res.end(); } catch (_) {} });
          room.httpViewers.clear();
        }
      } else if (msg.type === 'end') {
        const room = rooms.get(roomId);
        if (room) {
          broadcastToViewers(room, JSON.stringify({ type: 'end' }));
          // End HTTP streams gracefully
          room.httpViewers.forEach(res => { try { res.end(); } catch (_) {} });
          room.httpViewers.clear();
        }
        cleanupRoom(roomId, rooms);
        roomId = null;
      }
    } else {
      // Binary chunk from host
      const room = rooms.get(roomId);
      if (!room) return;
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      addChunk(room, chunk);
      pushChunkToHttpViewers(room, chunk);
      ws.send(JSON.stringify({ type: 'ack' }));
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (room) {
      broadcastToViewers(room, JSON.stringify({ type: 'end' }));
      room.httpViewers.forEach(res => { try { res.end(); } catch (_) {} });
      room.httpViewers.clear();
    }
    cleanupRoom(roomId, rooms);
  });
}

// Viewer WebSocket — control messages only (no binary data)
function handleViewer(ws, roomId, rooms) {
  const room = rooms.get(roomId);
  if (!room) {
    ws.send(JSON.stringify({ type: 'error', message: 'Sala não encontrada.' }));
    ws.close();
    return;
  }

  // Send init so the client knows the room exists and can set player.src
  ws.send(JSON.stringify({ type: 'init', mimeType: room.mimeType }));

  room.viewers.add(ws);
  notifyViewerCount(room);

  ws.on('close', () => {
    room.viewers.delete(ws);
    if (rooms.has(roomId)) notifyViewerCount(room);
  });
}

// ── Express app ───────────────────────────────────────────────────────────────

function createApp(rooms) {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  // Serve the watch page for any room URL
  app.get('/watch/:roomId', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
  });

  // HTTP progressive stream endpoint — viewer points <video src> here
  app.get('/stream/:roomId', (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) {
      res.status(404).send('Sala não encontrada.');
      return;
    }

    const base = room.mimeType.split(';')[0].trim();
    const contentType = base === 'video/mp4'
      ? 'video/mp4; codecs="avc1.640028, mp4a.40.2"'
      : base === 'video/webm'
        ? 'video/webm; codecs="vp9, opus"'
        : room.mimeType;

    // Se for range request, serve do buffer acumulado
    const rangeHeader = req.headers['range'];
    if (rangeHeader && room.buffer.length > 0) {
      const full = Buffer.concat(room.buffer);
      const total = full.length;
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      const start = match ? parseInt(match[1]) : 0;
      const end = (match && match[2]) ? parseInt(match[2]) : total - 1;
      const chunkLen = end - start + 1;
      res.writeHead(206, {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunkLen,
        'Cache-Control': 'no-cache, no-store',
      });
      res.end(full.slice(start, end + 1));
      return;
    }

    // Stream progressivo — mantém conexão aberta enquanto host transmite
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    for (const chunk of room.buffer) {
      try { res.write(chunk); } catch (_) { return; }
    }

    room.httpViewers.add(res);
    notifyViewerCount(room);

    req.on('close', () => {
      room.httpViewers.delete(res);
      if (rooms.has(req.params.roomId)) notifyViewerCount(room);
    });
  });

  return app;
}

// ── HTTP + WebSocket server ───────────────────────────────────────────────────

function createServer(app, rooms) {
  const httpServer = http.createServer(app);
  const wss = new WebSocket.Server({ server: httpServer, path: '/ws' });

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
  const rooms = new Map();
  const app = createApp(rooms);
  const server = createServer(app, rooms);
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
};
