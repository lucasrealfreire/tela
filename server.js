import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e7,
  pingTimeout: 60000,
  pingInterval: 25000
});

// Rota que fornece servidores ICE/TURN atualizados para evitar bloqueio de CGNAT em 2K 60fps
app.get('/api/ice', async (req, res) => {
  const defaultIce = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];
  res.json({ iceServers: defaultIce });
});

const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomName, nickname }) => {
    const cleanRoom = String(roomName || 'geral').trim().toLowerCase().slice(0, 40);
    const cleanNick = String(nickname || 'usuario').trim().slice(0, 24);

    currentRoom = cleanRoom;
    socket.join(cleanRoom);

    if (!rooms.has(cleanRoom)) {
      rooms.set(cleanRoom, new Map());
    }

    const roomUsers = rooms.get(cleanRoom);
    roomUsers.set(socket.id, {
      id: socket.id,
      nick: cleanNick,
      conn: 'Conectado'
    });

    io.to(cleanRoom).emit('room-users', Array.from(roomUsers.values()));

    socket.to(cleanRoom).emit('user-joined', {
      id: socket.id,
      nick: cleanNick
    });
  });

  socket.on('request-streams', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-joined', {
        id: socket.id,
        nick: 'Participante'
      });
    }
  });

  socket.on('webrtc-signal', ({ targetId, signal, streamMeta }) => {
    io.to(targetId).emit('webrtc-signal', {
      senderId: socket.id,
      signal,
      streamMeta
    });
  });

  socket.on('stream-meta-update', ({ streamId, res, fps }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('stream-meta-update', { streamId, res, fps });
    }
  });

  socket.on('relay-frame', (payload) => {
    if (currentRoom) {
      socket.volatile.to(currentRoom).emit('relay-frame', {
        senderId: socket.id,
        ...payload
      });
    }
  });

  socket.on('stop-stream', ({ streamId }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('peer-stopped-stream', {
        senderId: socket.id,
        streamId
      });
    }
  });

  socket.on('update-conn-type', ({ connType }) => {
    if (currentRoom && rooms.has(currentRoom)) {
      const roomUsers = rooms.get(currentRoom);
      const u = roomUsers.get(socket.id);
      if (u) {
        u.conn = String(connType).slice(0, 25);
        io.to(currentRoom).emit('room-users', Array.from(roomUsers.values()));
      }
    }
  });

  socket.on('chat-message', ({ text }) => {
    if (!currentRoom) return;
    const roomUsers = rooms.get(currentRoom);
    const sender = roomUsers?.get(socket.id);
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
      if (roomUsers.size === 0) {
        rooms.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('room-users', Array.from(roomUsers.values()));
        io.to(currentRoom).emit('user-left', { id: socket.id });
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
  console.log(`[TELINHA SERVER] Ativo na porta ${PORT}`);
});