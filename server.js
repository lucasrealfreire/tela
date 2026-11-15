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
  maxHttpBufferSize: 1e6
});

// Estado real das salas em memória
// Estrutura: rooms[roomName] = { users: { socketId: { id, nick, cheers, connType } } }
const rooms = new Map();
const rateLimitMap = new Map();

function checkRateLimit(socketId) {
  const now = Date.now();
  const history = rateLimitMap.get(socketId) || [];
  const recent = history.filter(t => now - t < 3000);
  if (recent.length >= 12) return false;
  recent.push(now);
  rateLimitMap.set(socketId, recent);
  return true;
}

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
      cheers: 0,
      conn: 'IPv6 / STUN'
    });

    // Envia lista atualizada de participantes para todos na sala
    io.to(cleanRoom).emit('room-users', Array.from(roomUsers.values()));

    // Avisa os demais membros que um novo participante entrou (para disparar ofertas WebRTC)
    socket.to(cleanRoom).emit('user-joined', {
      id: socket.id,
      nick: cleanNick
    });
  });

  // Sinalização WebRTC (Offer, Answer e Trickle ICE Candidates IPv6/IPv4/TURN)
  socket.on('webrtc-signal', ({ targetId, signal, streamMeta }) => {
    io.to(targetId).emit('webrtc-signal', {
      senderId: socket.id,
      signal,
      streamMeta
    });
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
    if (!currentRoom || !checkRateLimit(socket.id)) return;
    const roomUsers = rooms.get(currentRoom);
    const sender = roomUsers?.get(socket.id);
    if (!sender || !text || !String(text).trim()) return;

    const msgPayload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender: sender.nick,
      text: String(text).trim().slice(0, 500),
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };
    io.to(currentRoom).emit('chat-message', msgPayload);
  });

  socket.on('send-cheer', () => {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const roomUsers = rooms.get(currentRoom);
    const user = roomUsers.get(socket.id);
    if (user) {
      user.cheers += 1;
      io.to(currentRoom).emit('room-users', Array.from(roomUsers.values()));
    }
  });

  socket.on('disconnect', () => {
    rateLimitMap.delete(socket.id);
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

// Serve o frontend compilado em produção (Render)
const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '::', () => {
  console.log(`[TELINHA SERVER] Rodando em Dual-Stack IPv6/IPv4 na porta ${PORT}`);
});
