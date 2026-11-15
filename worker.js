export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();
    this.activeStreams = new Map();
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const socketId = crypto.randomUUID();
    this.sessions.set(server, { id: socketId, nick: 'Conectando...' });

    const broadcastJson = (obj, excludeWs = null) => {
      const str = JSON.stringify(obj);
      for (const [ws] of this.sessions.entries()) {
        if (ws !== excludeWs && ws.readyState === 1) {
          try { ws.send(str); } catch (e) {}
        }
      }
    };

    const broadcastUsers = () => {
      const list = Array.from(this.sessions.values());
      broadcastJson({ type: 'room-users', users: list });
    };

    server.addEventListener('message', (event) => {
      try {
        if (event.data instanceof ArrayBuffer) {
          for (const [ws] of this.sessions.entries()) {
            if (ws !== server && ws.readyState === 1) {
              try { ws.send(event.data); } catch (e) {}
            }
          }
          return;
        }

        const data = JSON.parse(event.data);

        if (data.type === 'join-room') {
          const cleanNick = String(data.nickname || 'usuario').trim().slice(0, 24);
          this.sessions.set(server, { id: socketId, nick: cleanNick });
          server.send(JSON.stringify({ type: 'welcome', id: socketId }));
          broadcastUsers();

          const currentStreams = Array.from(this.activeStreams.values());
          server.send(JSON.stringify({ type: 'active-streams', streams: currentStreams }));
          if (currentStreams.length > 0) {
            broadcastJson({ type: 'force-keyframe' }, server);
          }
        } else if (data.type === 'start-stream') {
          // Remove qualquer stream anterior do mesmo remetente para nunca duplicar
          for (const [sId, sMeta] of this.activeStreams.entries()) {
            if (sMeta.senderId === socketId) {
              this.activeStreams.delete(sId);
            }
          }
          const streamData = { ...data.meta, senderId: socketId };
          this.activeStreams.set(data.meta.streamId, streamData);
          broadcastJson({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
          broadcastJson({ type: 'stream-started', stream: streamData }, server);
        } else if (data.type === 'stop-stream') {
          this.activeStreams.delete(data.streamId);
          broadcastJson({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
          broadcastJson({ type: 'peer-stopped-stream', streamId: data.streamId }, server);
        } else if (data.type === 'request-keyframe') {
          broadcastJson({ type: 'force-keyframe', streamId: data.streamId }, server);
        } else if (data.type === 'chat-message') {
          const sender = this.sessions.get(server);
          if (!sender || !data.text || !String(data.text).trim()) return;
          broadcastJson({
            type: 'chat-message',
            msg: {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              sender: sender.nick,
              text: String(data.text).trim().slice(0, 500),
              time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
            }
          });
        }
      } catch (e) {}
    });

    const cleanup = () => {
      this.sessions.delete(server);
      for (const [sId, sMeta] of this.activeStreams.entries()) {
        if (sMeta.senderId === socketId) {
          this.activeStreams.delete(sId);
          broadcastJson({ type: 'peer-stopped-stream', streamId: sId });
        }
      }
      broadcastJson({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
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