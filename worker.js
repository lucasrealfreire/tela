export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.controlSessions = new Map(); // ws -> { id, nick }
    this.mediaSessions = new Set();   // ws exclusivos de vídeo/áudio
    this.activeStreams = new Map();   // streamId -> meta
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url = new URL(request.url);
    const role = url.searchParams.get('role') || 'control';

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    // Canal separado exclusivo para mídia binária (não bloqueia o chat nem atrasa pacotes)
    if (role === 'media') {
      this.mediaSessions.add(server);
      server.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          for (const ws of this.mediaSessions) {
            if (ws !== server && ws.readyState === 1) {
              try { ws.send(event.data); } catch (e) {}
            }
          }
        }
      });
      const cleanMedia = () => this.mediaSessions.delete(server);
      server.addEventListener('close', cleanMedia);
      server.addEventListener('error', cleanMedia);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Canal exclusivo de Controle e Chat (0ms de fila)
    const socketId = crypto.randomUUID();
    this.controlSessions.set(server, { id: socketId, nick: 'Conectando...' });

    const broadcastControl = (obj, excludeWs = null) => {
      const str = JSON.stringify(obj);
      for (const [ws] of this.controlSessions.entries()) {
        if (ws !== excludeWs && ws.readyState === 1) {
          try { ws.send(str); } catch (e) {}
        }
      }
    };

    const broadcastUsers = () => {
      const list = Array.from(this.controlSessions.values());
      broadcastControl({ type: 'room-users', users: list });
    };

    server.addEventListener('message', (event) => {
      try {
        if (event.data instanceof ArrayBuffer) return;
        const data = JSON.parse(event.data);

        if (data.type === 'join-room') {
          const cleanNick = String(data.nickname || 'usuario').trim().slice(0, 24);
          this.controlSessions.set(server, { id: socketId, nick: cleanNick });
          server.send(JSON.stringify({ type: 'welcome', id: socketId }));
          broadcastUsers();

          const currentStreams = Array.from(this.activeStreams.values());
          server.send(JSON.stringify({ type: 'active-streams', streams: currentStreams }));
          if (currentStreams.length > 0) {
            broadcastControl({ type: 'force-keyframe' }, server);
          }
        } else if (data.type === 'start-stream') {
          for (const [sId, sMeta] of this.activeStreams.entries()) {
            if (sMeta.senderId === socketId) this.activeStreams.delete(sId);
          }
          const metaObj = data.meta || data;
          const streamData = { ...metaObj, senderId: socketId };
          this.activeStreams.set(streamData.streamId, streamData);
          broadcastControl({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
          broadcastControl({ type: 'stream-started', stream: streamData }, server);
        } else if (data.type === 'stop-stream') {
          this.activeStreams.delete(data.streamId);
          broadcastControl({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
          broadcastControl({ type: 'peer-stopped-stream', streamId: data.streamId }, server);
        } else if (data.type === 'request-keyframe') {
          broadcastControl({ type: 'force-keyframe', streamId: data.streamId }, server);
        } else if (data.type === 'chat-message') {
          const sender = this.controlSessions.get(server);
          const rawText = data.msg?.text || data.text || '';
          if (! String(rawText).trim()) return;
          const msgPayload = {
            id: data.msg?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            sender: sender?.nick || data.msg?.sender || 'Participante',
            text: String(rawText).trim().slice(0, 500),
            time: data.msg?.time || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
          };
          broadcastControl({ type: 'chat-message', msg: msgPayload });
        }
      } catch (e) {}
    });

    const cleanup = () => {
      this.controlSessions.delete(server);
      for (const [sId, sMeta] of this.activeStreams.entries()) {
        if (sMeta.senderId === socketId) {
          this.activeStreams.delete(sId);
          broadcastControl({ type: 'peer-stopped-stream', streamId: sId });
        }
      }
      broadcastControl({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
      broadcastUsers();
    };

    server.addEventListener('close', cleanup);
    server.addEventListener('error', cleanup);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const roomKey = (url.searchParams.get('room') || 'squad-brasil').toLowerCase().slice(0, 60);
      const id = env.ROOMS.idFromName(roomKey);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    if (url.pathname === '/VogelsTV.exe' || url.pathname === '/api/download-app') {
      const assetReq = new Request(new URL('/VogelsTV.exe', request.url), request);
      const res = await env.ASSETS.fetch(assetReq);
      const headers = new Headers(res.headers);
      headers.set('Content-Type', 'application/octet-stream');
      headers.set('Content-Disposition', 'attachment; filename="VogelsTV.exe"');
      return new Response(res.body, { status: res.status, headers });
    }

    return env.ASSETS.fetch(request);
  }
};