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
  maxHttpBufferSize: 2e7,
  pingTimeout: 60000,
  pingInterval: 15000,
  perMessageDeflate: false // Zero compressão extra de CPU para pacotes binários de vídeo
});

const rooms = new Map();
const activeStreams = new Map(); // roomName -> Map(streamId -> meta)

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomName, nickname }) => {
    const cleanRoom = String(roomName || 'geral').trim().toLowerCase().slice(0, 40);
    const cleanNick = String(nickname || 'usuario').trim().slice(0, 24);

    currentRoom = cleanRoom;
    socket.join(cleanRoom);

    if (!rooms.has(cleanRoom)) rooms.set(cleanRoom, new Map());
    if (!activeStreams.has(cleanRoom)) activeStreams.set(cleanRoom, new Map());

    const roomUsers = rooms.get(cleanRoom);
    roomUsers.set(socket.id, {
      id: socket.id,
      nick: cleanNick,
      conn: 'GPU Stream'
    });

    io.to(cleanRoom).emit('room-users', Array.from(roomUsers.values()));

    // Envia imediatamente a lista de lives ativas na sala para quem acabou de entrar
    const currentStreams = Array.from(activeStreams.get(cleanRoom).values());
    if (currentStreams.length > 0) {
      socket.emit('active-streams', currentStreams);
      // Pede um Keyframe imediato aos transmissores para a tela abrir em < 100ms
      socket.to(cleanRoom).emit('force-keyframe');
    }
  });

  socket.on('start-stream', (meta) => {
    if (!currentRoom || !activeStreams.has(currentRoom)) return;
    const streamData = { ...meta, senderId: socket.id };
    activeStreams.get(currentRoom).set(meta.streamId, streamData);
    socket.to(currentRoom).emit('stream-started', streamData);
  });

  // Retransmissão de pacotes de vídeo H.264/VP8/VP9 codificados na GPU (WebCodecs Binary Chunk)
  socket.on('v-chunk', (meta, buffer) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('v-chunk', meta, buffer);
    }
  });

  // Retransmissão de pacotes de áudio Opus (WebCodecs Binary Audio)
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
    if (currentRoom) {
      activeStreams.get(currentRoom)?.delete(streamId);
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
  console.log(`[TELINHA WEBCODECS SFU] Rodando na porta ${PORT}`);
});