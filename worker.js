export class RoomDO {
  constructor(state, env) {
    this.state = state;
    this.controlSessions = new Map(); // ws -> { id, nick }
    this.mediaSessions = new Set();   // ws exclusivos de vídeo/áudio
    this.activeStreams = new Map();   // streamId -> meta
    this.disconnectTimers = new Map(); // clientId -> timeoutId
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

    // Canal de mídia binária com suporte a keep-alive
    if (role === 'media') {
      this.mediaSessions.add(server);
      server.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          for (const ws of this.mediaSessions) {
            if (ws !== server && ws.readyState === 1) {
              try { ws.send(event.data); } catch (e) {}
            }
          }
        } else if (event.data === 'ping') {
          try { server.send('pong'); } catch (e) {}
        }
      });
      const cleanMedia = () => this.mediaSessions.delete(server);
      server.addEventListener('close', cleanMedia);
      server.addEventListener('error', cleanMedia);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Canal de Controle e Chat com ID persistente (não derruba na reconexão!)
    let clientId = url.searchParams.get('cid') || crypto.randomUUID();
    this.controlSessions.set(server, { id: clientId, nick: 'Conectando...' });

    const broadcastControl = (obj, excludeWs = null) => {
      const str = JSON.stringify(obj);
      for (const [ws] of this.controlSessions.entries()) {
        if (ws !== excludeWs && ws.readyState === 1) {
          try { ws.send(str); } catch (e) {}
        }
      }
    };

    const getUniqueUsers = () => {
      const map = new Map();
      for (const u of this.controlSessions.values()) {
        if (u && u.id && u.nick !== 'Conectando...') {
          map.set(u.id, u);
        }
      }
      return Array.from(map.values());
    };

    const broadcastUsers = () => {
      broadcastControl({ type: 'room-users', users: getUniqueUsers() });
    };

    server.addEventListener('message', (event) => {
      try {
        if (event.data instanceof ArrayBuffer) return;
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
          // Cancela qualquer timer de desconexão pendente deste usuário (reconexão transparente!)
          if (this.disconnectTimers.has(clientId)) {
            clearTimeout(this.disconnectTimers.get(clientId));
            this.disconnectTimers.delete(clientId);
          }

          const cleanNick = String(data.nickname || 'usuario').trim().slice(0, 24);
          this.controlSessions.set(server, { id: clientId, nick: cleanNick });
          server.send(JSON.stringify({ type: 'welcome', id: clientId }));
          broadcastUsers();

          const currentStreams = Array.from(this.activeStreams.values());
          server.send(JSON.stringify({ type: 'active-streams', streams: currentStreams }));
          if (currentStreams.length > 0) {
            broadcastControl({ type: 'force-keyframe' }, server);
          }
        } else if (data.type === 'start-stream') {
          const metaObj = data.meta || data;
          for (const [sId, sMeta] of this.activeStreams.entries()) {
            if (sMeta.senderId === clientId && sId !== metaObj.streamId) {
              this.activeStreams.delete(sId);
            }
          }
          const streamData = { ...metaObj, senderId: clientId };
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
          if (!String(rawText).trim()) return;
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
      // Verifica se o mesmo usuário já não está conectado em outro socket ativo
      let stillConnected = false;
      for (const u of this.controlSessions.values()) {
        if (u.id === clientId) {
          stillConnected = true;
          break;
        }
      }
      if (stillConnected) return;

      // Aguarda 6 segundos antes de remover o usuário/stream (permite reconexão automática sem kickar ninguém!)
      const timer = setTimeout(() => {
        this.disconnectTimers.delete(clientId);
        let reconnected = false;
        for (const u of this.controlSessions.values()) {
          if (u.id === clientId) { reconnected = true; break; }
        }
        if (reconnected) return;

        for (const [sId, sMeta] of this.activeStreams.entries()) {
          if (sMeta.senderId === clientId) {
            this.activeStreams.delete(sId);
            broadcastControl({ type: 'peer-stopped-stream', streamId: sId });
          }
        }
        broadcastControl({ type: 'active-streams', streams: Array.from(this.activeStreams.values()) });
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