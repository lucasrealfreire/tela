import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

function normalizeRoomKey(rawRoom, rawPassword) {
  let r = String(rawRoom || 'squad-brasil').trim();
  let p = String(rawPassword || '').trim();

  if (r.startsWith('http://') || r.startsWith('https://') || r.includes('?sala=')) {
    try {
      const urlObj = new URL(r.startsWith('http') ? r : `https://vogelstv.local/${r}`);
      if (urlObj.searchParams.get('sala')) r = urlObj.searchParams.get('sala');
      if (urlObj.searchParams.get('senha') && !p) p = urlObj.searchParams.get('senha');
    } catch (e) {}
  }

  const cleanRoom = r.toLowerCase().replace(/\s+/g, '-').slice(0, 40) || 'squad-brasil';
  const cleanPass = p.toLowerCase().slice(0, 30);
  return cleanPass ? `${cleanRoom}::pass:${cleanPass}` : cleanRoom;
}

// Entrega diretamente o arquivo executável único VogelsTV.exe já configurado para a sala atual
app.get('/api/download-app', (req, res) => {
  const rawProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0].trim();
  const host = req.get('host') || 'telinha-platform.onrender.com';
  const baseUrl = `${rawProto}://${host}`;

  const salaParam = req.query.sala ? `&sala=${encodeURIComponent(String(req.query.sala))}` : '';
  const senhaParam = req.query.senha ? `&senha=${encodeURIComponent(String(req.query.senha))}` : '';
  const targetUrl = `${baseUrl}/?desktop=1${salaParam}${senhaParam}`;

  const exePaths = [
    path.join(__dirname, 'dist', 'VogelsTV.exe'),
    path.join(__dirname, 'public', 'VogelsTV.exe')
  ];
  const exePath = exePaths.find(p => fs.existsSync(p));

  if (!exePath) {
    return res.status(404).send('Executável não encontrado.');
  }

  const exeBuffer = Buffer.from(fs.readFileSync(exePath));
  const placeholderStr = 'VOGELSTV_TARGET_URL_PLACEHOLDER_' + 'X'.repeat(128);
  const searchBuf = Buffer.from(placeholderStr, 'utf16le');
  const idx = exeBuffer.indexOf(searchBuf);

  if (idx !== -1 && targetUrl.length <= placeholderStr.length) {
    const paddedUrl = targetUrl.padEnd(placeholderStr.length, ' ');
    const replaceBuf = Buffer.from(paddedUrl, 'utf16le');
    replaceBuf.copy(exeBuffer, idx);
  }

  res.setHeader('Content-Type', 'application/vnd.microsoft.portable-executable');
  res.setHeader('Content-Disposition', 'attachment; filename="VogelsTV.exe"');
  res.setHeader('Content-Length', exeBuffer.length);
  res.send(exeBuffer);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 2e7,
  pingTimeout: 60000,
  pingInterval: 15000,
  perMessageDeflate: false
});

const rooms = new Map();
const activeStreams = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomName, roomPassword, nickname }) => {
    const cleanRoom = normalizeRoomKey(roomName, roomPassword);
    const cleanNick = String(nickname || 'usuario').trim().slice(0, 24);

    if (currentRoom && currentRoom !== cleanRoom) {
      socket.leave(currentRoom);
    }

    currentRoom = cleanRoom;
    socket.join(cleanRoom);

    if (!rooms.has(cleanRoom)) rooms.set(cleanRoom, new Map());
    if (!activeStreams.has(cleanRoom)) activeStreams.set(cleanRoom, new Map());

    const roomUsers = rooms.get(cleanRoom);
    roomUsers.set(socket.id, {
      id: socket.id,
      nick: cleanNick
    });

    io.to(cleanRoom).emit('room-users', Array.from(roomUsers.values()));

    const currentStreams = Array.from(activeStreams.get(cleanRoom).values());
    socket.emit('active-streams', currentStreams);
    if (currentStreams.length > 0) {
      socket.to(cleanRoom).emit('force-keyframe');
    }
  });

  socket.on('request-active-streams', () => {
    if (!currentRoom || !activeStreams.has(currentRoom)) return;
    const currentStreams = Array.from(activeStreams.get(currentRoom).values());
    socket.emit('active-streams', currentStreams);
    socket.to(currentRoom).emit('force-keyframe');
  });

  socket.on('start-stream', (meta) => {
    if (!currentRoom || !activeStreams.has(currentRoom)) return;
    const streamData = { ...meta, senderId: socket.id };
    activeStreams.get(currentRoom).set(meta.streamId, streamData);
    io.to(currentRoom).emit('active-streams', Array.from(activeStreams.get(currentRoom).values()));
    socket.to(currentRoom).emit('stream-started', streamData);
  });

  socket.on('v-chunk', (meta, buffer) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('v-chunk', { ...meta, senderId: socket.id }, buffer);
    }
  });

  socket.on('a-chunk', (meta, buffer) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('a-chunk', meta, buffer);
    }
  });

  socket.on('request-keyframe', ({ streamId }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('force-keyframe', { streamId });
    }
  });

  socket.on('stop-stream', ({ streamId }) => {
    if (currentRoom && activeStreams.has(currentRoom)) {
      activeStreams.get(currentRoom).delete(streamId);
      io.to(currentRoom).emit('active-streams', Array.from(activeStreams.get(currentRoom).values()));
      socket.to(currentRoom).emit('peer-stopped-stream', { streamId });
    }
  });

  socket.on('chat-message', ({ text }) => {
    if (!currentRoom) return;
    const sender = rooms.get(currentRoom)?.get(socket.id);
    if (!sender || !text || !String(text).trim()) return;

    io.to(currentRoom).emit('chat-message', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender: sender.nick,
      text: String(text).trim().slice(0, 500),
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const roomUsers = rooms.get(currentRoom);
      roomUsers.delete(socket.id);

      const roomStreams = activeStreams.get(currentRoom);
      if (roomStreams) {
        for (const [sId, sMeta] of roomStreams.entries()) {
          if (sMeta.senderId === socket.id) {
            roomStreams.delete(sId);
            socket.to(currentRoom).emit('peer-stopped-stream', { streamId: sId });
          }
        }
        io.to(currentRoom).emit('active-streams', Array.from(roomStreams.values()));
      }

      if (roomUsers.size === 0) {
        rooms.delete(currentRoom);
        activeStreams.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('room-users', Array.from(roomUsers.values()));
      }
    }
  });
});

const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[VogelsTV] Rodando na porta ${PORT}`);
});