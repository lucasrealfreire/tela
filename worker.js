function unpackHeaderFromBinary(arrayBuffer) {
  try {
    const view = new DataView(arrayBuffer);
    const headerLen = view.getUint32(0, false);
    if (headerLen <= 0 || headerLen > 4096) return null;
    const headerBytes = new Uint8Array(arrayBuffer, 4, headerLen);
    return JSON.parse(new TextDecoder().decode(headerBytes));
  } catch (e) {
    return null;
  }
}

export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map();         // ws -> { id, nick }
    this.activeStreams = new Map();    // streamId -> meta
    this.disconnectTimers = new Map(); // clientId -> timeoutId
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const url = new URL(request.url);
    let clientId = url.searchParams.get('cid') || crypto.randomUUID();

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    this.sessions.set(server, { id: clientId, nick: 'Conectando...' });

    const broadcastJson = (obj, excludeWs = null) => {
      const str = JSON.stringify(obj);
      for (const [ws] of this.sessions.entries()) {
        if (ws !== excludeWs && ws.readyState === 1) {
          try { ws.send(str); } catch (e) {}
        }
      }
    };

    const getUniqueUsers = () => {
      const map = new Map();
      for (const u of this.sessions.values()) {
        if (u && u.id && u.nick !== 'Conectando...') {
          map.set(u.id, u);
        }
      }
      return Array.from(map.values());
    };

    const broadcastUsers = () => {
      broadcastJson({ type: 'room-users', users: getUniqueUsers() });
    };

    server.addEventListener('message', (event) => {
      try {
        // Pacotes binários de Vídeo e Áudio no MESMO túnel WebSocket (Garante 100% de entrega!)
        if (event.data instanceof ArrayBuffer) {
          const hdr = unpackHeaderFromBinary(event.data);
          // Se o pacote de vídeo chegou e a stream ainda não constava na lista da sala, registra na hora!
          if (hdr && hdr.k === 'v' && hdr.id && !this.activeStreams.has(hdr.id)) {
            const sender = this.sessions.get(server);
            const autoMeta = {
              streamId: hdr.id,
              senderId: clientId,
              owner: hdr.owner || sender?.nick || 'Participante',
              type: 'Tela',
              res: `${hdr.h || 1080}p`,
              fps: hdr.fps || 60
            };
            this.activeStreams.set(hdr.id, autoMeta);
            broadcastJson({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
          }

          for (const [ws] of this.sessions.entries()) {
            if (ws !== server && ws.readyState === 1) {
              try { ws.send(event.data); } catch (e) {}
            }
          }
          return;
        }

        if (event.data === 'ping') {
          server.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        const data = JSON.parse(event.data);
        if (data.type === 'ping') {
          server.send(JSON.stringify({ type: 'pong' }));
          return;
        }

        if (data.type === 'join-room') {
          if (data.clientId) clientId = String(data.clientId).slice(0, 40);
          if (this.disconnectTimers.has(clientId)) {
            clearTimeout(this.disconnectTimers.get(clientId));
            this.disconnectTimers.delete(clientId);
          }

          // Fecha sessões zumbis antigas do mesmo clientId para não duplicar socket
          for (const [oldWs, oldUser] of this.sessions.entries()) {
            if (oldWs !== server && oldUser.id === clientId) {
              this.sessions.delete(oldWs);
              try { oldWs.close(); } catch (e) {}
            }
          }

          const cleanNick = String(data.nickname || 'usuario').trim().slice(0, 24);
          this.sessions.set(server, { id: clientId, nick: cleanNick });
          server.send(JSON.stringify({ type: 'welcome', id: clientId }));
          broadcastUsers();

          const currentStreams = Array.from(this.activeStreams.values());
          server.send(JSON.stringify({ type: 'active-streams', streams: currentStreams }));
          if (currentStreams.length > 0) {
            broadcastJson({ type: 'force-keyframe' }, server);
          }
        } else if (data.type === 'start-stream') {
          const metaObj = data.meta || data;
          for (const [sId, sMeta] of this.activeStreams.entries()) {
            if (sMeta.senderId === clientId && sId !== metaObj.streamId) {
              this.activeStreams.delete(sId);
              broadcastJson({ type: 'peer-stopped-stream', streamId: sId }, server);
            }
          }
          const streamData = { ...metaObj, senderId: clientId };
          this.activeStreams.set(streamData.streamId, streamData);
          broadcastJson({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
          broadcastJson({ type: 'stream-started', stream: streamData }, server);
        } else if (data.type === 'stop-stream') {
          this.activeStreams.delete(data.streamId);
          broadcastJson({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
          broadcastJson({ type: 'peer-stopped-stream', streamId: data.streamId });
        } else if (data.type === 'request-keyframe') {
          broadcastJson({ type: 'force-keyframe', streamId: data.streamId }, server);
        } else if (data.type === 'chat-message') {
          const sender = this.sessions.get(server);
          const rawText = data.msg?.text || data.text || '';
          if (!String(rawText).trim()) return;
          const msgPayload = {
            id: data.msg?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            sender: sender?.nick || data.msg?.sender || 'Participante',
            text: String(rawText).trim().slice(0, 500),
            time: data.msg?.time || new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
          };
          broadcastJson({ type: 'chat-message', msg: msgPayload });
        }
      } catch (e) {}
    });

    const cleanup = () => {
      this.sessions.delete(server);
      let stillConnected = false;
      for (const u of this.sessions.values()) {
        if (u.id === clientId) {
          stillConnected = true;
          break;
        }
      }
      if (stillConnected) return;

      const timer = setTimeout(() => {
        this.disconnectTimers.delete(clientId);
        let reconnected = false;
        for (const u of this.sessions.values()) {
          if (u.id === clientId) { reconnected = true; break; }
        }
        if (reconnected) return;

        for (const [sId, sMeta] of this.activeStreams.entries()) {
          if (sMeta.senderId === clientId) {
            this.activeStreams.delete(sId);
            broadcastJson({ type: 'peer-stopped-stream', streamId: sId });
          }
        }
        broadcastJson({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
        broadcastUsers();
      }, 6000);

      this.disconnectTimers.set(clientId, timer);
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
      const roomKey = (url.searchParams.get('room') || 'geral').toLowerCase().slice(0, 60);
      const id = env.ROOMS.idFromName(roomKey);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};