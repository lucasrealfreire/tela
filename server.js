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
  maxHttpBufferSize: 5e6,
  pingTimeout: 60000,
  pingInterval: 25000
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
      cheers: 0,
      conn: 'Conectado'
    });

    io.to(cleanRoom).emit('room-users', Array.from(roomUsers.values()));

    // Notifica quem já estava na sala para enviar suas telas para quem acabou de entrar
    socket.to(cleanRoom).emit('user-joined', {
      id: socket.id,
      nick: cleanNick
    });
  });

  // Permite que qualquer cliente peça novamente as ofertas de quem está transmitindo
  socket.on('request-streams', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-joined', {
        id: socket.id,
        nick: 'Participante'
      });
    }
  });

  // Sinalização WebRTC P2P / TURN
  socket.on('webrtc-signal', ({ targetId, signal, streamMeta }) => {
    io.to(targetId).emit('webrtc-signal', {
      senderId: socket.id,
      signal,
      streamMeta
    });
  });

  // PLANO B GARANTIDO: Retransmissão de quadros em baixa latência via WebSocket caso o CGNAT bloqueie o UDP/WebRTC
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