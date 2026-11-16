import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const MASTER_RENDER_URL = 'https://telinha-platform.onrender.com';

const RES_CONFIG = {
  '720p': { width: 1280, height: 720, label: '720p' },
  '1080p': { width: 1920, height: 1080, label: '1080p' },
  '1440p': { width: 2560, height: 1440, label: '2K (1440p)' }
};

function renderVogelsLogo(size = 'text-sm') {
  return (
    <span className={`inline-flex items-center gap-1.5 font-extrabold tracking-tight select-none ${size}`}>
      <img src="/favicon.svg" alt="VTV" className="w-5 h-5 rounded-sm" />
      <span>
        <span className="text-white">Vogels</span>
        <span className="text-red-500">TV</span>
      </span>
    </span>
  );
}

function parseRoomInput(rawRoom, rawPass) {
  let r = String(rawRoom || '').trim();
  let p = String(rawPass || '').trim();

  if (r.startsWith('http://') || r.startsWith('https://') || r.includes('?sala=')) {
    try {
      const u = new URL(r.startsWith('http') ? r : `https://vogelstv.local/${r}`);
      if (u.searchParams.get('sala')) r = u.searchParams.get('sala');
      if (u.searchParams.get('senha') && !p) p = u.searchParams.get('senha');
    } catch (e) {}
  }
  const cleanRoom = r.toLowerCase().replace(/\s+/g, '-').slice(0, 40);
  const cleanPass = p.toLowerCase().slice(0, 30);
  return {
    cleanRoom,
    cleanPass,
    fullRoomKey: cleanPass ? `${cleanRoom}::pass:${cleanPass}` : cleanRoom
  };
}

function packBinaryFrame(headerObj, payloadBuffer) {
  const headerBytes = new TextEncoder().encode(JSON.stringify(headerObj));
  const payloadBytes = new Uint8Array(payloadBuffer);
  const combined = new Uint8Array(4 + headerBytes.byteLength + payloadBytes.byteLength);
  new DataView(combined.buffer).setUint32(0, headerBytes.byteLength, false);
  combined.set(headerBytes, 4);
  combined.set(payloadBytes, 4 + headerBytes.byteLength);
  return combined.buffer;
}

function unpackBinaryFrame(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const headerLen = view.getUint32(0, false);
  const headerBytes = new Uint8Array(arrayBuffer, 4, headerLen);
  const headerObj = JSON.parse(new TextDecoder().decode(headerBytes));
  const payloadBuffer = arrayBuffer.slice(4 + headerLen);
  return { headerObj, payloadBuffer };
}

// Alinha dimensões em múltiplos de 16 (evita crash em placas AMD/NVIDIA/Intel) e tem fallback garantido para VP8 Software!
async function findSupportedVideoConfig(width, height, fps, bitrate, preferredCodec, forceSoftware = false) {
  const w = Math.max(64, Math.floor(width / 16) * 16);
  const h = Math.max(64, Math.floor(height / 16) * 16);

  if (forceSoftware) {
    return {
      codec: 'vp8',
      width: w,
      height: h,
      bitrate,
      framerate: fps,
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-software'
    };
  }

  const candidates = [
    preferredCodec === 'VP8' ? { codec: 'vp8' } : null,
    preferredCodec === 'H264' ? { codec: 'avc1.42e01f', avc: { format: 'annexb' } } : null,
    preferredCodec === 'H264' ? { codec: 'avc1.4d002a', avc: { format: 'annexb' } } : null,
    preferredCodec === 'VP9' ? { codec: 'vp09.00.10.08' } : null,
    { codec: 'vp8' }
  ].filter(Boolean);

  for (const cand of candidates) {
    for (const hw of ['no-preference', 'prefer-hardware', 'prefer-software']) {
      try {
        const cfg = {
          ...cand,
          width: w,
          height: h,
          bitrate,
          framerate: fps,
          latencyMode: 'realtime',
          hardwareAcceleration: hw
        };
        const res = await VideoEncoder.isConfigSupported(cfg);
        if (res.supported) return cfg;
      } catch (e) {}
    }
  }
  return { codec: 'vp8', width: w, height: h, bitrate, framerate: fps, latencyMode: 'realtime' };
}

function createZeroCpuChunkBuffer() {
  let chunks = [];

  return {
    pushChunk: (meta, buffer) => {
      const now = Date.now();
      const copy = new Uint8Array(buffer.byteLength);
      copy.set(new Uint8Array(buffer));
      chunks.push({
        t: meta.t,
        ts: meta.ts,
        c: meta.c || 'vp8',
        w: meta.w || 1920,
        h: meta.h || 1080,
        fps: meta.fps || 60,
        data: copy,
        arrivedAt: now
      });

      const cutoff = now - 31000;
      if (chunks.length > 180 && chunks[0].arrivedAt < cutoff) {
        let firstKeyIdx = 0;
        for (let i = 0; i < chunks.length; i++) {
          if (chunks[i].arrivedAt >= cutoff) break;
          if (chunks[i].t === 'key') firstKeyIdx = i;
        }
        if (firstKeyIdx > 0) {
          chunks = chunks.slice(firstKeyIdx);
        }
      }
    },
    getSnapshot: () => {
      const keyIdx = chunks.findIndex(c => c.t === 'key');
      if (keyIdx === -1) return [];
      return chunks.slice(keyIdx);
    },
    clear: () => {
      chunks = [];
    }
  };
}

export default function App() {
  const [inRoom, setInRoom] = useState(false);
  const [nickname, setNickname] = useState('');
  const [roomName, setRoomName] = useState('');
  const [roomPassword, setRoomPassword] = useState('');

  const [recentRooms, setRecentRooms] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('tv_recent_rooms') || '[]');
      return Array.isArray(saved) ? saved.slice(0, 3) : [];
    } catch (e) {
      return [];
    }
  });

  const [quality, setQuality] = useState('1080p');
  const [bitrateKbps, setBitrateKbps] = useState(4000);
  const [fps, setFps] = useState(60);
  const [gameMode, setGameMode] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showMixer, setShowMixer] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [replayModal, setReplayModal] = useState(null);

  const [outgoingVolume, setOutgoingVolume] = useState(() => {
    const saved = localStorage.getItem('tv_out_vol');
    return saved !== null ? Number(saved) : 70;
  });

  const [masterVolume, setMasterVolume] = useState(() => {
    const saved = localStorage.getItem('tv_master_vol');
    return saved !== null ? Number(saved) : 80;
  });

  const [excludeDiscordAudio, setExcludeDiscordAudio] = useState(() => {
    const saved = localStorage.getItem('tv_exclude_discord');
    return saved !== null ? saved === 'true' : true;
  });

  // VP8 como padrão: 100% compatível entre todas as placas de vídeo (NVIDIA, AMD e Intel) sem dar tela preta!
  const [codec, setCodec] = useState('VP8');

  const persistentClientIdRef = useRef('u_' + Math.random().toString(36).substring(2, 10));
  const [myId, setMyId] = useState(persistentClientIdRef.current);
  const myIdRef = useRef(persistentClientIdRef.current);
  const localStreamIdsRef = useRef(new Set());
  const activeLocalMetasRef = useRef(new Map());

  const [streams, setStreams] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([
    { id: 'sys-1', system: true, text: 'Sessão iniciada. Mande o link da sala para a galera!' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef(null);

  const canShareScreen = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);

  const transportRef = useRef({
    mode: 'none',
    sendControl: () => {},
    sendVideoChunk: () => {},
    sendAudioChunk: () => {},
    getBufferedAmount: () => 0
  });

  const activeEncodersRef = useRef({});
  const videoChunkHandlersRef = useRef({});
  const audioChunkHandlersRef = useRef({});
  const ramClipBuffersRef = useRef({});
  const stoppedWatchingSetRef = useRef(new Set());

  const qualityRef = useRef(quality);
  const bitrateKbpsRef = useRef(bitrateKbps);
  const fpsRef = useRef(fps);
  const codecRef = useRef(codec);
  const outgoingVolumeRef = useRef(outgoingVolume);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    localStorage.setItem('tv_exclude_discord', String(excludeDiscordAudio));
  }, [excludeDiscordAudio]);

  useEffect(() => {
    outgoingVolumeRef.current = outgoingVolume;
    localStorage.setItem('tv_out_vol', String(outgoingVolume));
  }, [outgoingVolume]);

  useEffect(() => {
    localStorage.setItem('tv_master_vol', String(masterVolume));
  }, [masterVolume]);

  useEffect(() => {
    qualityRef.current = quality;
    bitrateKbpsRef.current = bitrateKbps;
    fpsRef.current = fps;
    codecRef.current = codec;
    Object.values(activeEncodersRef.current).forEach(enc => enc.reconfigure?.());
  }, [quality, bitrateKbps, fps, codec]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sala')) setRoomName(params.get('sala'));
    if (params.get('senha')) setRoomPassword(params.get('senha'));
  }, []);

  const saveRoomToHistory = (cRoom, cPass, usedNick) => {
    try {
      const entry = {
        room: cRoom,
        pass: cPass || '',
        nick: usedNick,
        ts: Date.now()
      };
      const filtered = recentRooms.filter(item => item.room !== cRoom);
      const updated = [entry, ...filtered].slice(0, 3);
      setRecentRooms(updated);
      localStorage.setItem('tv_recent_rooms', JSON.stringify(updated));
      localStorage.setItem('tv_last_nick', usedNick);
    } catch (e) {}
  };

  const handleQuickJoinRecentRoom = (item) => {
    const chosenNick = nickname.trim() || item.nick || localStorage.getItem('tv_last_nick') || 'Visitante';
    setNickname(chosenNick);
    setRoomName(item.room);
    setRoomPassword(item.pass || '');
    saveRoomToHistory(item.room, item.pass || '', chosenNick);
    setInRoom(true);
  };

  useEffect(() => {
    if (!inRoom) return;

    const { cleanRoom, cleanPass, fullRoomKey } = parseRoomInput(roomName, roomPassword);
    const cid = persistentClientIdRef.current;
    setParticipants([{ id: cid, nick: nickname }]);

    let isUnmounted = false;
    let ws = null;
    let fallbackSocket = null;
    let heartbeatTimer = null;
    let reconnectTimer = null;

    const onRoomUsers = (list) => {
      if (isUnmounted) return;
      setParticipants(list && list.length ? list : [{ id: cid, nick: nickname }]);
    };

    // IMPORTANTE: Nunca apaga uma live que já está aberta na tela por oscilação momentânea da lista!
    const onActiveStreams = (list) => {
      if (isUnmounted || !Array.isArray(list)) return;
      setStreams(prev => {
        const nextList = [...prev];

        list.forEach(st => {
          if (!st || !st.streamId) return;
          if (
            st.senderId === myIdRef.current ||
            st.senderId === cid ||
            localStreamIdsRef.current.has(st.streamId)
          ) {
            return;
          }

          const existingIdx = nextList.findIndex(p => p.id === st.streamId);
          if (existingIdx !== -1) {
            nextList[existingIdx] = {
              ...nextList[existingIdx],
              senderId: st.senderId,
              owner: st.owner,
              res: st.res,
              fps: st.fps
            };
          } else {
            const isStopped = stoppedWatchingSetRef.current.has(st.streamId);
            nextList.push({
              id: st.streamId,
              senderId: st.senderId,
              owner: st.owner,
              type: st.type || 'Tela',
              res: st.res || '1080p',
              fps: st.fps || 60,
              volume: 75,
              muted: false,
              minimized: false,
              watching: !isStopped,
              watchSession: 1,
              isLocal: false
            });
          }
        });

        return nextList;
      });
    };

    const onStreamStarted = (st) => {
      if (isUnmounted || !st || !st.streamId) return;
      if (st.senderId === myIdRef.current || st.senderId === cid || localStreamIdsRef.current.has(st.streamId)) return;

      stoppedWatchingSetRef.current.delete(st.streamId);

      setStreams(prev => {
        if (prev.some(s => s.isLocal && s.id === st.streamId)) return prev;
        const exists = prev.find(s => !s.isLocal && s.id === st.streamId);
        if (exists) {
          return prev.map(s =>
            s.id === st.streamId
              ? { ...s, senderId: st.senderId, watching: true, minimized: false, watchSession: (s.watchSession || 0) + 1 }
              : s
          );
        }
        return [
          ...prev,
          {
            id: st.streamId,
            senderId: st.senderId,
            owner: st.owner,
            type: st.type || 'Tela',
            res: st.res || '1080p',
            fps: st.fps || 60,
            volume: 75,
            muted: false,
            minimized: false,
            watching: true,
            watchSession: 1,
            isLocal: false
          }
        ];
      });
      transportRef.current.sendControl('request-keyframe', { streamId: st.streamId });
    };

    const onVChunk = (meta, buffer) => {
      if (isUnmounted || !meta || !meta.id) return;
      if (meta.senderId === myIdRef.current || meta.senderId === cid || localStreamIdsRef.current.has(meta.id)) return;

      setStreams(prev => {
        if (prev.some(s => s.id === meta.id)) return prev;
        const isStopped = stoppedWatchingSetRef.current.has(meta.id);
        return [
          ...prev,
          {
            id: meta.id,
            senderId: meta.senderId,
            owner: meta.owner || 'Participante',
            type: 'Tela',
            res: `${meta.h || 1080}p`,
            fps: meta.fps || 60,
            volume: 75,
            muted: false,
            minimized: false,
            watching: !isStopped,
            watchSession: 1,
            isLocal: false
          }
        ];
      });

      if (stoppedWatchingSetRef.current.has(meta.id)) return;

      if (!ramClipBuffersRef.current[meta.id]) {
        ramClipBuffersRef.current[meta.id] = createZeroCpuChunkBuffer();
      }
      ramClipBuffersRef.current[meta.id].pushChunk(meta, buffer);

      const handler = videoChunkHandlersRef.current[meta.id];
      if (handler) handler(meta, buffer);
    };

    const onAChunk = (meta, buffer) => {
      if (isUnmounted || !meta || !meta.id) return;
      if (localStreamIdsRef.current.has(meta.id) || stoppedWatchingSetRef.current.has(meta.id)) return;
      const handler = audioChunkHandlersRef.current[meta.id];
      if (handler) handler(meta, buffer);
    };

    const onPeerStoppedStream = (streamId) => {
      if (isUnmounted) return;
      stoppedWatchingSetRef.current.delete(streamId);
      ramClipBuffersRef.current[streamId]?.clear?.();
      delete ramClipBuffersRef.current[streamId];
      setStreams(prev => prev.filter(s => s.id !== streamId));
      delete videoChunkHandlersRef.current[streamId];
      delete audioChunkHandlersRef.current[streamId];
    };

    const onChatMessage = (msgObj) => {
      if (isUnmounted || !msgObj || !msgObj.text) return;
      setMessages(prev => {
        if (msgObj.id && prev.some(m => m.id === msgObj.id)) return prev;
        return [...prev, msgObj];
      });
    };

    // TÚNEL WEBSOCKET ÚNICO UNIFICADO (Se o participante está na sala, o vídeo e o chat passam 100% pelo mesmo socket!)
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/ws?room=${encodeURIComponent(fullRoomKey)}&cid=${encodeURIComponent(cid)}`;

    let cfEverConnected = false;

    const connectUnifiedWs = () => {
      if (isUnmounted || fallbackSocket) return;
      try {
        if (ws) {
          ws.onclose = null;
          ws.onerror = null;
          try { ws.close(); } catch (e) {}
        }
        ws = new WebSocket(wsUrl);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
          if (isUnmounted) return;
          cfEverConnected = true;
          ws.send(JSON.stringify({
            type: 'join-room',
            clientId: cid,
            roomName: cleanRoom,
            roomPassword: cleanPass,
            nickname
          }));

          // Reanuncia todas as lives locais ativas e força envio de Keyframe imediato
          activeLocalMetasRef.current.forEach((meta) => {
            ws.send(JSON.stringify({ type: 'start-stream', meta }));
          });
          Object.values(activeEncodersRef.current).forEach(enc => enc.forceKey?.());
        };

        ws.onmessage = (event) => {
          if (isUnmounted) return;
          if (event.data instanceof ArrayBuffer) {
            try {
              const { headerObj, payloadBuffer } = unpackBinaryFrame(event.data);
              if (headerObj.k === 'v') onVChunk(headerObj, payloadBuffer);
              else if (headerObj.k === 'a') onAChunk(headerObj, payloadBuffer);
            } catch (e) {}
            return;
          }

          try {
            const data = JSON.parse(event.data);
            if (data.type === 'pong') return;
            if (data.type === 'welcome') {
              myIdRef.current = data.id;
              setMyId(data.id);
            } else if (data.type === 'room-users') {
              onRoomUsers(data.users);
            } else if (data.type === 'active-streams') {
              onActiveStreams(data.streams);
            } else if (data.type === 'stream-started') {
              onStreamStarted(data.stream);
            } else if (data.type === 'force-keyframe') {
              Object.values(activeEncodersRef.current).forEach(enc => enc.forceKey?.());
            } else if (data.type === 'peer-stopped-stream') {
              onPeerStoppedStream(data.streamId);
            } else if (data.type === 'chat-message') {
              onChatMessage(data.msg);
            }
          } catch (e) {}
        };

        ws.onclose = () => {
          if (isUnmounted) return;
          if (!cfEverConnected && !fallbackSocket) {
            startSocketIoFallback();
          } else if (cfEverConnected) {
            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connectUnifiedWs, 400);
          }
        };

        ws.onerror = () => {
          if (!cfEverConnected && !fallbackSocket && !isUnmounted) {
            startSocketIoFallback();
          }
        };
      } catch (e) {
        if (!cfEverConnected) startSocketIoFallback();
      }
    };

    transportRef.current = {
      mode: 'cf-ws',
      sendControl: (type, payload = {}) => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type, ...payload }));
        }
      },
      sendVideoChunk: (meta, buffer) => {
        // Keyframes têm prioridade total; frames normais respeitam limite de 512KB para não derrubar o socket
        if (ws && ws.readyState === 1 && (meta.t === 'key' || ws.bufferedAmount < 524288)) {
          ws.send(packBinaryFrame({ k: 'v', ...meta }, buffer));
        }
      },
      sendAudioChunk: (meta, buffer) => {
        if (ws && ws.readyState === 1 && ws.bufferedAmount < 524288) {
          ws.send(packBinaryFrame({ k: 'a', ...meta }, buffer));
        }
      },
      getBufferedAmount: () => (ws ? ws.bufferedAmount : 0)
    };

    connectUnifiedWs();

    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === 1) {
        try { ws.send('ping'); } catch (e) {}
      }
    }, 15000);

    function startSocketIoFallback() {
      if (isUnmounted || fallbackSocket) return;
      const targetServer = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? window.location.origin
        : MASTER_RENDER_URL;

      const socket = io(targetServer, {
        transports: ['websocket', 'polling'],
        reconnection: true
      });
      fallbackSocket = socket;

      transportRef.current = {
        mode: 'socketio',
        sendControl: (type, payload = {}) => {
          socket.emit(type, payload);
        },
        sendVideoChunk: (meta, buffer) => {
          socket.emit('v-chunk', meta, buffer);
        },
        sendAudioChunk: (meta, buffer) => {
          socket.emit('a-chunk', meta, buffer);
        },
        getBufferedAmount: () => socket.io?.engine?.transport?.ws?.bufferedAmount || 0
      };

      socket.on('connect', () => {
        myIdRef.current = socket.id;
        setMyId(socket.id);
        socket.emit('join-room', {
          roomName: cleanRoom,
          roomPassword: cleanPass,
          nickname
        });
        activeLocalMetasRef.current.forEach((meta) => {
          socket.emit('start-stream', meta);
        });
      });

      socket.on('room-users', (list) => onRoomUsers(list));
      socket.on('active-streams', (list) => onActiveStreams(list));
      socket.on('stream-started', (st) => onStreamStarted(st));
      socket.on('force-keyframe', () => {
        Object.values(activeEncodersRef.current).forEach(enc => enc.forceKey?.());
      });
      socket.on('v-chunk', (meta, buffer) => onVChunk(meta, buffer));
      socket.on('a-chunk', (meta, buffer) => onAChunk(meta, buffer));
      socket.on('peer-stopped-stream', ({ streamId }) => onPeerStoppedStream(streamId));
      socket.on('chat-message', (msg) => onChatMessage(msg));
    }

    return () => {
      isUnmounted = true;
      clearInterval(heartbeatTimer);
      clearTimeout(reconnectTimer);
      Object.values(activeEncodersRef.current).forEach(e => e.stop?.());
      Object.values(ramClipBuffersRef.current).forEach(b => b.clear?.());
      try { if (ws) { ws.onclose = null; ws.close(); } } catch (e) {}
      try { if (fallbackSocket) fallbackSocket.disconnect(); } catch (e) {}
    };
  }, [inRoom, roomName, roomPassword, nickname]);

  const setStreamVolume = (streamId, newVol) => {
    const clamped = Math.max(0, Math.min(100, Number(newVol)));
    setStreams(prev =>
      prev.map(s =>
        s.id === streamId ? { ...s, volume: clamped, muted: clamped === 0 } : s
      )
    );
  };

  const toggleStreamMute = (streamId) => {
    setStreams(prev =>
      prev.map(s => {
        if (s.id !== streamId) return s;
        const nextMuted = !s.muted;
        const restoredVol = !nextMuted && (s.volume === 0 || s.volume === undefined) ? 75 : (s.volume ?? 75);
        return { ...s, muted: nextMuted, volume: restoredVol };
      })
    );
  };

  const setWatchingStream = (streamId, shouldWatch) => {
    if (shouldWatch) {
      stoppedWatchingSetRef.current.delete(streamId);
    } else {
      stoppedWatchingSetRef.current.add(streamId);
      if (expandedId === streamId) setExpandedId(null);
      delete videoChunkHandlersRef.current[streamId];
      delete audioChunkHandlersRef.current[streamId];
    }

    setStreams(prev =>
      prev.map(s => {
        if (s.id !== streamId) return s;
        return {
          ...s,
          watching: shouldWatch,
          minimized: false,
          watchSession: (s.watchSession || 0) + 1
        };
      })
    );

    if (shouldWatch) {
      transportRef.current.sendControl('request-keyframe', { streamId });
    }
  };

  const handlePasteRoomLink = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const { cleanRoom, cleanPass } = parseRoomInput(text, roomPassword);
      if (cleanRoom) setRoomName(cleanRoom);
      if (cleanPass) setRoomPassword(cleanPass);
    } catch (e) {
      alert('Cole o link diretamente no campo da sala (Ctrl+V).');
    }
  };

  // Transmissor com Auto-Recuperação (Se o encoder de hardware da GPU falhar, recria em VP8 Software na mesma hora!)
  const startWebCodecsSender = async (streamId, mediaStream, isCamera = false) => {
    const vTrack = mediaStream.getVideoTracks()[0];
    if (!vTrack) return;

    let running = true;
    let forceKey = true;
    let lastKeyframeTs = 0;
    let frameCount = 0;
    let currentCodecStr = 'vp8';
    let targetW = RES_CONFIG[qualityRef.current]?.width || 1920;
    let targetH = RES_CONFIG[qualityRef.current]?.height || 1080;
    let videoEncoder = null;
    let usingSoftwareFallback = false;

    ramClipBuffersRef.current[streamId] = createZeroCpuChunkBuffer();

    const createAndConfigureEncoder = async (forceSw = false) => {
      try {
        if (videoEncoder && videoEncoder.state !== 'closed') {
          videoEncoder.close();
        }
      } catch (e) {}

      videoEncoder = new VideoEncoder({
        output: (chunk) => {
          if (!running) return;
          const buf = new Uint8Array(chunk.byteLength);
          chunk.copyTo(buf);

          const meta = {
            id: streamId,
            senderId: myIdRef.current,
            owner: nickname,
            c: currentCodecStr,
            t: chunk.type,
            ts: chunk.timestamp,
            w: targetW,
            h: targetH,
            fps: fpsRef.current
          };

          ramClipBuffersRef.current[streamId]?.pushChunk(meta, buf.buffer);
          transportRef.current.sendVideoChunk(meta, buf.buffer);
        },
        error: () => {
          // Se a placa de vídeo recusar codificar por hardware, muda automaticamente para VP8 Software sem cair a live!
          if (running && !usingSoftwareFallback) {
            usingSoftwareFallback = true;
            createAndConfigureEncoder(true);
          }
        }
      });

      const settings = vTrack.getSettings ? vTrack.getSettings() : {};
      const rawW = settings.width || 1920;
      const rawH = settings.height || 1080;
      const cfg = RES_CONFIG[qualityRef.current] || RES_CONFIG['1080p'];
      const targetFps = Number(fpsRef.current) || 60;
      const targetBitrateBps = (Number(bitrateKbpsRef.current) || 4000) * 1000;
      const ratio = rawW && rawH ? rawW / rawH : 16 / 9;
      targetH = Math.min(cfg.height, rawH || cfg.height);
      targetW = Math.round(targetH * ratio);

      const bestCfg = await findSupportedVideoConfig(
        targetW,
        targetH,
        targetFps,
        targetBitrateBps,
        forceSw ? 'VP8' : codecRef.current,
        forceSw
      );
      currentCodecStr = bestCfg.codec;
      targetW = bestCfg.width;
      targetH = bestCfg.height;

      try {
        videoEncoder.configure(bestCfg);
        forceKey = true;
      } catch (e) {
        if (!forceSw) {
          usingSoftwareFallback = true;
          await createAndConfigureEncoder(true);
        }
      }
    };

    await createAndConfigureEncoder(false);

    let audioEncoder = null;
    const aTrack = mediaStream.getAudioTracks()[0];
    if (!isCamera && aTrack && 'AudioEncoder' in window && 'MediaStreamTrackProcessor' in window) {
      try {
        audioEncoder = new AudioEncoder({
          output: (chunk) => {
            if (!running) return;
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            transportRef.current.sendAudioChunk({
              id: streamId,
              ts: chunk.timestamp,
              sr: 48000,
              ch: 2,
              gain: outgoingVolumeRef.current
            }, buf.buffer);
          },
          error: () => {}
        });
        audioEncoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 64000 });

        const aProc = new MediaStreamTrackProcessor({ track: aTrack });
        const aReader = aProc.readable.getReader();
        (async () => {
          while (running) {
            const { value: aData, done } = await aReader.read();
            if (done || !aData) break;
            if (audioEncoder.state === 'configured' && audioEncoder.encodeQueueSize < 3) {
              audioEncoder.encode(aData);
            }
            aData.close();
          }
        })().catch(() => {});
      } catch (e) {}
    }

    // Leitor de quadros com fallback universal (funciona em todos os navegadores)
    let fallbackInterval = null;
    let hiddenVideo = null;

    const encodeSingleFrame = (frame) => {
      const now = performance.now();
      const minInterval = 1000 / (Number(fpsRef.current) + 2);
      const netBusy = transportRef.current.getBufferedAmount() > 393216;

      if (!videoEncoder || videoEncoder.state !== 'configured' || videoEncoder.encodeQueueSize > 2 || netBusy) {
        frame.close();
        return;
      }

      try {
        // Envia Keyframe a cada 90 frames (1.5s) para entrada instantânea de quem clica em Assistir!
        const isKey = forceKey || (frameCount % 90 === 0);
        if (isKey) {
          forceKey = false;
          lastKeyframeTs = now;
        }
        videoEncoder.encode(frame, { keyFrame: isKey });
        frameCount++;
      } catch (e) {
        if (!usingSoftwareFallback) {
          usingSoftwareFallback = true;
          createAndConfigureEncoder(true);
        }
      } finally {
        frame.close();
      }
    };

    if ('MediaStreamTrackProcessor' in window) {
      const processor = new MediaStreamTrackProcessor({ track: vTrack });
      const reader = processor.readable.getReader();

      (async () => {
        let lastFrameTime = 0;
        while (running) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;
          const now = performance.now();
          const minInterval = 1000 / (Number(fpsRef.current) + 2);
          if (now - lastFrameTime < minInterval) {
            frame.close();
            continue;
          }
          lastFrameTime = now;
          encodeSingleFrame(frame);
        }
      })().catch(() => {});
    } else if ('VideoFrame' in window) {
      hiddenVideo = document.createElement('video');
      hiddenVideo.muted = true;
      hiddenVideo.playsInline = true;
      hiddenVideo.srcObject = new MediaStream([vTrack]);
      hiddenVideo.play().catch(() => {});
      fallbackInterval = setInterval(() => {
        if (!running || !hiddenVideo || hiddenVideo.readyState < 2) return;
        try {
          const vf = new VideoFrame(hiddenVideo, { timestamp: performance.now() * 1000 });
          encodeSingleFrame(vf);
        } catch (e) {}
      }, Math.round(1000 / (Number(fpsRef.current) || 30)));
    }

    activeEncodersRef.current[streamId] = {
      forceKey: () => {
        const now = performance.now();
        if (now - lastKeyframeTs > 250) {
          forceKey = true;
        }
      },
      reconfigure: () => {
        createAndConfigureEncoder(usingSoftwareFallback);
      },
      stop: () => {
        running = false;
        if (fallbackInterval) clearInterval(fallbackInterval);
        if (hiddenVideo) {
          try { hiddenVideo.srcObject = null; } catch (e) {}
        }
        try { if (videoEncoder && videoEncoder.state !== 'closed') videoEncoder.close(); } catch (e) {}
        try { if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close(); } catch (e) {}
      }
    };
  };

  const handleShareScreen = async () => {
    try {
      streams.filter(s => s.isLocal && s.type !== 'Câmera').forEach(s => stopStream(s.id));

      const cfg = RES_CONFIG[quality] || RES_CONFIG['1080p'];
      const targetFps = Number(fps);

      const mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: cfg.width, max: 2560 },
          height: { ideal: cfg.height, max: 1440 },
          frameRate: { ideal: targetFps, max: 60 },
          cursor: 'always'
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        },
        windowAudio: excludeDiscordAudio ? 'window' : 'system',
        systemAudio: 'include'
      });

      const vTrack = mediaStream.getVideoTracks()[0];
      if (vTrack && 'contentHint' in vTrack) {
        vTrack.contentHint = 'motion';
      }

      const newId = 'stream_' + Math.random().toString(36).substring(2, 9);
      localStreamIdsRef.current.add(newId);
      vTrack.onended = () => stopStream(newId);

      const newStreamObj = {
        id: newId,
        senderId: myIdRef.current,
        owner: nickname,
        type: gameMode ? 'Modo Jogo' : 'Tela',
        stream: mediaStream,
        res: cfg.label,
        fps: targetFps,
        volume: 100,
        muted: true,
        minimized: false,
        watching: true,
        watchSession: 1,
        isLocal: true
      };

      setStreams(prev => [...prev.filter(s => !(s.isLocal && s.type !== 'Câmera')), newStreamObj]);

      const meta = {
        streamId: newId,
        senderId: myIdRef.current,
        owner: nickname,
        type: newStreamObj.type,
        res: cfg.label,
        fps: targetFps
      };

      activeLocalMetasRef.current.set(newId, meta);
      transportRef.current.sendControl('start-stream', { meta, ...meta });
      await startWebCodecsSender(newId, mediaStream, false);
    } catch (err) {}
  };

  const handleShareCamera = async () => {
    try {
      streams.filter(s => s.isLocal && s.type === 'Câmera').forEach(s => stopStream(s.id));

      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: Number(fps) } },
        audio: false
      });
      const newId = 'cam_' + Math.random().toString(36).substring(2, 9);
      localStreamIdsRef.current.add(newId);
      const vTrack = mediaStream.getVideoTracks()[0];
      vTrack.onended = () => stopStream(newId);

      const newStreamObj = {
        id: newId,
        senderId: myIdRef.current,
        owner: nickname,
        type: 'Câmera',
        stream: mediaStream,
        res: '720p',
        fps: Number(fps),
        volume: 100,
        muted: true,
        minimized: false,
        watching: true,
        watchSession: 1,
        isLocal: true
      };

      setStreams(prev => [...prev.filter(s => !(s.isLocal && s.type === 'Câmera')), newStreamObj]);

      const meta = {
        streamId: newId,
        senderId: myIdRef.current,
        owner: nickname,
        type: 'Câmera',
        res: '720p',
        fps: Number(fps)
      };

      activeLocalMetasRef.current.set(newId, meta);
      transportRef.current.sendControl('start-stream', { meta, ...meta });
      await startWebCodecsSender(newId, mediaStream, true);
    } catch (err) {
      alert('Não foi possível acessar a câmera.');
    }
  };

  const stopStream = (streamId) => {
    localStreamIdsRef.current.delete(streamId);
    activeLocalMetasRef.current.delete(streamId);
    activeEncodersRef.current[streamId]?.stop?.();
    delete activeEncodersRef.current[streamId];
    ramClipBuffersRef.current[streamId]?.clear?.();
    delete ramClipBuffersRef.current[streamId];

    setStreams(prev => {
      const target = prev.find(s => s.id === streamId);
      if (target?.stream) target.stream.getTracks().forEach(t => t.stop());
      return prev.filter(s => s.id !== streamId);
    });

    transportRef.current.sendControl('stop-stream', { streamId });
    if (expandedId === streamId) setExpandedId(null);
  };

  const handleReplayOrClip = (targetStreamId) => {
    const targetStream = streams.find(s => s.id === targetStreamId) || streams.find(s => s.watching !== false);
    if (!targetStream) {
      alert('Nenhuma transmissão ativa para abrir o Replay de 30 segundos.');
      return;
    }

    const ramBuf = ramClipBuffersRef.current[targetStream.id];
    const snapshot = ramBuf ? ramBuf.getSnapshot() : [];
    if (!snapshot.length) {
      alert('Aguarde pelo menos 2 segundos de transmissão para acumular os quadros do Replay.');
      return;
    }

    setReplayModal({
      streamId: targetStream.id,
      owner: targetStream.owner,
      chunks: snapshot
    });
  };

  const sendChat = (e) => {
    e.preventDefault();
    const cleanText = chatInput.trim();
    if (!cleanText) return;

    const msgPayload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      sender: nickname,
      text: cleanText.slice(0, 500),
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, msgPayload]);
    transportRef.current.sendControl('chat-message', { text: cleanText, msg: msgPayload });
    setChatInput('');
  };

  const { cleanRoom, cleanPass } = parseRoomInput(roomName, roomPassword);
  const currentRoomUrl = `${window.location.origin}/?sala=${encodeURIComponent(cleanRoom)}${cleanPass ? `&senha=${encodeURIComponent(cleanPass)}` : ''}`;

  const copyRoomLink = () => {
    navigator.clipboard.writeText(currentRoomUrl);
    alert(`Link da sala copiado:\n${currentRoomUrl}`);
  };

  if (!inRoom) {
    return (
      <div className="min-h-[100dvh] w-screen bg-[#0D0F13] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#151922] border border-[#232936] rounded-xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            {renderVogelsLogo('text-2xl')}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const cleanNick = nickname.trim();
              if (!cleanNick || !cleanRoom) return;
              setNickname(cleanNick);
              setRoomName(cleanRoom);
              if (cleanPass) setRoomPassword(cleanPass);
              saveRoomToHistory(cleanRoom, cleanPass, cleanNick);
              setInRoom(true);
            }}
            className="space-y-4"
          >
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Seu nickname</label>
              <input
                type="text"
                required
                value={nickname}
                onChange={e => setNickname(e.target.value)}
                placeholder="Digite seu nome"
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white select-text focus:outline-none focus:border-red-500"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs text-gray-400 font-medium">Sala</label>
                <button
                  type="button"
                  onClick={handlePasteRoomLink}
                  className="text-[11px] text-red-400 hover:text-red-300 cursor-pointer"
                >
                  📋 Colar link
                </button>
              </div>
              <input
                type="text"
                required
                value={roomName}
                onChange={e => setRoomName(e.target.value)}
                placeholder="Digite a sala"
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white select-text focus:outline-none focus:border-red-500"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Senha (opcional)</label>
              <input
                type="password"
                value={roomPassword}
                onChange={e => setRoomPassword(e.target.value)}
                placeholder="Digitar senha"
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white select-text focus:outline-none focus:border-red-500"
              />
            </div>

            {recentRooms.length > 0 && (
              <div className="pt-1 space-y-1.5">
                <span className="block text-[11px] text-gray-400 font-medium">
                  Últimas salas:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {recentRooms.map((item) => (
                    <button
                      key={item.room}
                      type="button"
                      onClick={() => handleQuickJoinRecentRoom(item)}
                      className="flex items-center gap-1.5 bg-[#1B202B] hover:bg-[#252C3D] border border-[#2C3446] hover:border-red-500/50 text-xs text-gray-200 px-3 py-1.5 rounded-lg cursor-pointer transition"
                      title={`Entrar automaticamente na sala ${item.room}`}
                    >
                      <span>{item.pass ? '🔒' : '🚪'}</span>
                      <span className="font-mono font-medium truncate max-w-[120px]">{item.room}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-[#5865F2] hover:bg-[#4752C4] text-white font-semibold py-2.5 rounded-lg text-sm transition cursor-pointer mt-2"
            >
              ENTRAR NA SALA
            </button>
          </form>
        </div>
      </div>
    );
  }

  const watchingStreams = streams.filter(s => s.watching !== false && !s.minimized);
  const unwatchedStreams = streams.filter(s => !s.isLocal && s.watching === false);
  const minimizedStreams = streams.filter(s => s.watching !== false && s.minimized);
  const remoteStreams = streams.filter(s => !s.isLocal);

  return (
    <div className="h-[100dvh] w-screen bg-[#0D0F13] text-[#E2E8F0] flex flex-col overflow-hidden">
      <header className="min-h-12 bg-[#12151C] border-b border-[#1E232E] px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1.5 shrink-0 z-20 select-none">
        <div className="flex items-center gap-1.5 sm:gap-2">
          {renderVogelsLogo('text-sm sm:text-base')}
          <span className="text-amber-400 text-xs">🔒</span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[10px] sm:text-[11px] text-gray-200 px-2 py-0.5 rounded-full font-mono truncate max-w-[90px] sm:max-w-[160px]">
            {cleanRoom}
          </span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[10px] sm:text-[11px] text-emerald-400 px-2 py-0.5 rounded-full font-medium shrink-0">
            {participants.length} online
          </span>
        </div>

        <div className="flex items-center gap-1 sm:gap-1.5 flex-wrap">
          {canShareScreen && (
            <>
              <select value={quality} onChange={e => setQuality(e.target.value)} className="hidden md:inline-block bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2 py-1.5 cursor-pointer">
                <option value="720p">720p (HD)</option>
                <option value="1080p">1080p (Full HD)</option>
                <option value="1440p">2K (1440p)</option>
              </select>

              <select
                value={bitrateKbps}
                onChange={e => setBitrateKbps(Number(e.target.value))}
                className="hidden md:inline-block bg-[#171B24] border border-emerald-500/40 text-xs text-emerald-300 font-semibold rounded-md px-2 py-1.5 cursor-pointer"
                title="Taxa de Bits (Bitrate)"
              >
                <option value={2500}>2500 kbps</option>
                <option value={4000}>4000 kbps (Ideal)</option>
                <option value={6000}>6000 kbps</option>
                <option value={8000}>8000 kbps</option>
              </select>

              <select value={fps} onChange={e => setFps(Number(e.target.value))} className="hidden md:inline-block bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2 py-1.5 cursor-pointer">
                <option value={30}>30 fps</option>
                <option value={60}>60 fps</option>
              </select>
            </>
          )}

          <div className="relative">
            <button
              onClick={() => {
                setShowMixer(!showMixer);
                setShowSettings(false);
              }}
              className={`border text-[11px] sm:text-xs rounded-md px-2 sm:px-2.5 py-1.5 flex items-center gap-1 cursor-pointer ${
                showMixer ? 'bg-red-600/30 border-red-500 text-white' : 'bg-[#171B24] hover:bg-[#1E2330] border-[#282E3D] text-gray-200'
              }`}
            >
              <span>🎚️</span> <span className="hidden sm:inline">Mixer</span>
            </button>

            {showMixer && (
              <div className="fixed sm:absolute right-2 sm:right-0 top-13 sm:top-auto sm:mt-2 w-[calc(100vw-1rem)] max-w-xs bg-[#141820] border border-[#262C3A] rounded-xl shadow-2xl p-4 z-50 text-left space-y-4">
                <div className="flex items-center justify-between border-b border-[#222834] pb-2">
                  <span className="font-semibold text-sm text-white">🎚️ Mixer de Áudio (0% a 100%)</span>
                  <button onClick={() => setShowMixer(false)} className="text-gray-400 hover:text-white text-sm px-1.5 py-0.5 rounded bg-[#1C212C]">✕</button>
                </div>

                <div className="bg-[#1B202B] border border-[#2B3242] rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-white">🔊 Volume Geral (Pra Você)</span>
                    <span className="font-mono text-red-400 font-semibold">{masterVolume}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={masterVolume}
                    onChange={e => setMasterVolume(Number(e.target.value))}
                    className="w-full accent-red-500 cursor-pointer"
                  />
                </div>

                {canShareScreen && (
                  <div className="bg-[#1B202B] border border-[#2B3242] rounded-lg p-3 space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-white">🎙️ Volume da Sua Live (Envio)</span>
                      <span className="font-mono text-indigo-400 font-semibold">{outgoingVolume}%</span>
                    </div>
                    <input
                      type="range"
                      min="0"
                      max="100"
                      value={outgoingVolume}
                      onChange={e => setOutgoingVolume(Number(e.target.value))}
                      className="w-full accent-indigo-500 cursor-pointer"
                    />
                  </div>
                )}

                <div className="space-y-2">
                  <span className="block text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                    Transmissões na Sala
                  </span>
                  {remoteStreams.length === 0 ? (
                    <p className="text-xs text-gray-500 italic">Nenhum amigo transmitindo no momento.</p>
                  ) : (
                    remoteStreams.map(rs => (
                      <div key={rs.id} className="bg-[#0D1016] border border-[#1E232E] rounded-lg p-2.5 space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <span className="font-medium text-gray-200 truncate">{rs.owner}</span>
                          <span className="font-mono text-emerald-400">
                            {rs.muted ? '0% (Mudo)' : `${rs.volume ?? 75}%`}
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => toggleStreamMute(rs.id)}
                            className="text-xs px-1.5 py-0.5 rounded bg-[#1B202B] hover:bg-[#252C3D] cursor-pointer"
                          >
                            {rs.muted || (rs.volume ?? 75) === 0 ? '🔇' : '🔊'}
                          </button>
                          <input
                            type="range"
                            min="0"
                            max="100"
                            value={rs.muted ? 0 : (rs.volume ?? 75)}
                            onChange={e => setStreamVolume(rs.id, e.target.value)}
                            className="flex-1 accent-emerald-400 cursor-pointer"
                          />
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          <button onClick={handleShareCamera} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-[11px] sm:text-xs text-gray-200 rounded-md px-2 sm:px-2.5 py-1.5 flex items-center gap-1 cursor-pointer">
            <span>📷</span> <span className="hidden sm:inline">Câmera</span>
          </button>

          {watchingStreams.length > 0 && (
            <button
              onClick={() => handleReplayOrClip(watchingStreams[0].id)}
              className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-[11px] sm:text-xs text-gray-200 rounded-md px-2 sm:px-2.5 py-1.5 flex items-center gap-1 cursor-pointer"
              title="Voltar 30 segundos do compartilhamento"
            >
              <span>⏪</span> <span className="hidden sm:inline">Replay 30s</span>
            </button>
          )}

          {canShareScreen && (
            <>
              <button
                onClick={() => setGameMode(!gameMode)}
                className={`hidden md:flex border text-xs rounded-md px-2.5 py-1.5 items-center gap-1.5 cursor-pointer ${
                  gameMode ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200' : 'bg-[#171B24] border-[#282E3D] text-gray-200'
                }`}
              >
                <span>🎮</span> Modo jogo
              </button>

              <button onClick={handleShareScreen} className="bg-[#5865F2] hover:bg-[#4752C4] text-white font-medium text-[11px] sm:text-xs rounded-md px-2.5 sm:px-3 py-1.5 cursor-pointer">
                Compartilhar tela
              </button>
            </>
          )}

          <div className="relative">
            <button
              onClick={() => {
                setShowSettings(!showSettings);
                setShowMixer(false);
              }}
              className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2 py-1.5 cursor-pointer"
            >
              ⚙️
            </button>
            {showSettings && (
              <div className="fixed sm:absolute right-2 sm:right-0 top-13 sm:top-auto sm:mt-2 w-[calc(100vw-1rem)] max-w-xs bg-[#141820] border border-[#262C3A] rounded-xl shadow-2xl p-4 z-50 text-left space-y-3.5">
                <div className="flex items-center justify-between border-b border-[#222834] pb-2">
                  <span className="font-semibold text-sm text-white">Configurações</span>
                  <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white text-sm px-1.5 py-0.5 rounded bg-[#1C212C]">✕</button>
                </div>

                <div className="bg-[#1B202B] border border-[#2B3242] rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">Isolar áudio da janela (Anti-Eco)</span>
                    <input
                      type="checkbox"
                      checked={excludeDiscordAudio}
                      onChange={e => setExcludeDiscordAudio(e.target.checked)}
                      className="w-4 h-4 accent-red-500 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1 leading-snug">
                    Ao compartilhar uma janela ou aba específica, captura apenas o som dela sem transmitir vozes externas.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Codec de Vídeo</label>
                  <select value={codec} onChange={e => setCodec(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="VP8">VP8 Universal (Compatibilidade 100%)</option>
                    <option value="H264">H.264 Baseline (Hardware)</option>
                    <option value="VP9">VP9 Alta Nitidez</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <button onClick={copyRoomLink} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-[11px] sm:text-xs text-gray-200 rounded-md px-2 sm:px-2.5 py-1.5 cursor-pointer">
            🔗 <span className="hidden sm:inline">Link</span>
          </button>

          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className={`border text-[11px] sm:text-xs rounded-md px-2 sm:px-2.5 py-1.5 flex items-center gap-1 cursor-pointer transition ${
              sidebarCollapsed
                ? 'bg-red-600/25 border-red-500/60 text-red-200'
                : 'bg-[#171B24] hover:bg-[#1E2330] border-[#282E3D] text-gray-200'
            }`}
          >
            <span>💬</span> <span className="hidden sm:inline">{sidebarCollapsed ? 'Abrir Chat' : 'Ocultar Chat'}</span>
          </button>

          <button onClick={() => setInRoom(false)} className="bg-[#171B24] hover:bg-red-950/60 border border-red-800/60 text-[11px] sm:text-xs text-red-300 rounded-md px-2 sm:px-2.5 py-1.5 cursor-pointer">
            Sair
          </button>
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        <main
          className={`bg-[#0B0D11] relative flex flex-col p-2 sm:p-3 overflow-hidden select-none ${
            !sidebarCollapsed && watchingStreams.length > 0
              ? 'h-[45dvh] sm:h-[52dvh] lg:h-auto lg:flex-1 shrink-0'
              : 'flex-1'
          }`}
        >
          {watchingStreams.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3 p-4">
              {unwatchedStreams.length > 0 ? (
                <div className="space-y-3">
                  <p className="text-xs text-gray-300">
                    Há {unwatchedStreams.length} transmissão(ões) ativa(s) na sala que você parou de assistir.
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {unwatchedStreams.map(us => (
                      <button
                        key={us.id}
                        onClick={() => setWatchingStream(us.id, true)}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3.5 py-2 rounded-lg cursor-pointer shadow"
                      >
                        ▶️ Assistir {us.owner} ({us.res})
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-xs text-gray-400">Ninguém está compartilhando ainda.</p>
                  {canShareScreen ? (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Clique em <button onClick={handleShareScreen} className="text-gray-200 font-semibold hover:underline cursor-pointer">Compartilhar tela</button> para começar.
                    </p>
                  ) : (
                    <p className="text-[11px] text-gray-500 mt-1">
                      Assim que alguém iniciar uma live na sala, ela aparecerá aqui automaticamente.
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className={`flex-1 grid gap-2 sm:gap-3 overflow-hidden ${expandedId || watchingStreams.length === 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
              {watchingStreams
                .filter(s => !expandedId || s.id === expandedId)
                .map(streamObj =>
                  React.createElement(VideoTile, {
                    key: `${streamObj.id}_${streamObj.watchSession || 1}`,
                    streamObj,
                    masterVolume,
                    onRequestKeyframe: () => transportRef.current.sendControl('request-keyframe', { streamId: streamObj.id }),
                    videoChunkHandlersRef,
                    audioChunkHandlersRef,
                    onStop: () => stopStream(streamObj.id),
                    onStopWatching: () => setWatchingStream(streamObj.id, false),
                    onMute: () => toggleStreamMute(streamObj.id),
                    onVolumeChange: (val) => setStreamVolume(streamObj.id, val),
                    onMinimize: () => setStreams(prev => prev.map(s => s.id === streamObj.id ? { ...s, minimized: !s.minimized } : s)),
                    onExpand: () => setExpandedId(expandedId === streamObj.id ? null : streamObj.id),
                    isExpanded: expandedId === streamObj.id,
                    onClip: () => handleReplayOrClip(streamObj.id),
                    onReplay: () => handleReplayOrClip(streamObj.id)
                  })
                )}
            </div>
          )}

          {minimizedStreams.length > 0 && (
            <div className="mt-2 flex items-center gap-2 bg-[#141820] border border-[#232936] px-3 py-1.5 rounded-lg overflow-x-auto">
              <span className="text-[11px] text-gray-400 shrink-0">Minimizadas:</span>
              {minimizedStreams.map(s => (
                <button key={s.id} onClick={() => setStreams(prev => prev.map(x => x.id === s.id ? { ...x, minimized: false } : x))} className="text-xs bg-[#1E2433] text-indigo-300 px-2 py-0.5 rounded cursor-pointer shrink-0">
                  Restaurar: {s.owner}
                </button>
              ))}
            </div>
          )}

          <div className="hidden sm:block absolute bottom-1.5 left-3 text-[11px] opacity-60 pointer-events-none">
            {renderVogelsLogo('text-xs')}
          </div>
        </main>

        {!sidebarCollapsed && (
          <aside className="flex-1 lg:flex-none lg:w-72 bg-[#12151C] border-t lg:border-t-0 lg:border-l border-[#1E232E] flex flex-col min-h-0 shrink-0 transition-all">
            <div className="p-2.5 sm:p-3 border-b border-[#1E232E] select-none max-h-28 lg:max-h-48 overflow-y-auto">
              <div className="flex items-center justify-between mb-1.5">
                <h3 className="text-[10px] font-bold tracking-wider text-gray-400 uppercase">PARTICIPANTES</h3>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="text-[10px] text-gray-400 hover:text-white bg-[#1B202B] px-1.5 py-0.5 rounded cursor-pointer"
                >
                  ❯ Minimizar
                </button>
              </div>
              <div className="space-y-1">
                {participants.map(p => {
                  const isMe = p.id === myId || p.id === persistentClientIdRef.current;
                  const userStreams = isMe
                    ? streams.filter(s => s.isLocal)
                    : streams.filter(s => !s.isLocal && ((s.senderId && s.senderId === p.id) || (!s.senderId && s.owner === p.nick)));
                  const hasActiveStream = userStreams.length > 0;
                  const isCurrentlyWatching = userStreams.some(s => s.watching !== false);

                  return (
                    <div key={p.id} className="flex items-center justify-between text-xs gap-1 min-h-[22px]">
                      <div className="flex items-center gap-2 truncate">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${hasActiveStream ? 'bg-red-500 animate-pulse' : 'bg-emerald-400'}`}></span>
                        <span className="text-gray-200 font-medium truncate">
                          {p.nick} {isMe && <span className="text-gray-400">(você)</span>}
                        </span>
                      </div>

                      {isMe && hasActiveStream && (
                        <button
                          onClick={() => userStreams.forEach(s => stopStream(s.id))}
                          className="text-[10px] bg-red-950/70 hover:bg-red-900 border border-red-700/60 text-red-200 px-2 py-0.5 rounded cursor-pointer shrink-0 transition"
                        >
                          Parar live
                        </button>
                      )}

                      {!isMe && hasActiveStream && (
                        isCurrentlyWatching ? (
                          <button
                            onClick={() => userStreams.forEach(s => setWatchingStream(s.id, false))}
                            className="text-[10px] bg-red-600/25 hover:bg-red-600/40 border border-red-500/50 text-red-300 font-medium px-2 py-0.5 rounded cursor-pointer shrink-0 transition"
                          >
                            Parar de assistir
                          </button>
                        ) : (
                          <button
                            onClick={() => userStreams.forEach(s => setWatchingStream(s.id, true))}
                            className="text-[10px] bg-emerald-600/30 hover:bg-emerald-600/50 border border-emerald-500/60 text-emerald-300 font-semibold px-2.5 py-0.5 rounded cursor-pointer shrink-0 transition"
                          >
                            Assistir
                          </button>
                        )
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex-1 flex flex-col p-2.5 sm:p-3 min-h-0 overflow-hidden select-text">
              <h3 className="text-[10px] font-bold tracking-wider text-gray-400 uppercase mb-1.5 select-none">CHAT</h3>
              <div className="flex-1 bg-[#0D1016] border border-[#1E232E] rounded-lg p-2.5 overflow-y-auto space-y-2 text-xs min-h-0">
                {messages.map(m =>
                  m.system ? (
                    <p key={m.id} className="text-gray-400 italic text-[11px]">{m.text}</p>
                  ) : (
                    <div key={m.id} className="leading-relaxed">
                      <span className="font-semibold text-red-400">{m.sender}: </span>
                      <span className="text-gray-200 break-words">{m.text}</span>
                      {m.time && <span className="text-[9px] text-gray-500 ml-1.5">{m.time}</span>}
                    </div>
                  )
                )}
                <div ref={chatEndRef} />
              </div>
              <form onSubmit={sendChat} className="mt-2 flex gap-1.5 shrink-0">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.stopPropagation()}
                  placeholder="Digite sua mensagem..."
                  autoComplete="off"
                  className="flex-1 bg-[#0D1016] border border-[#242A38] rounded-md px-2.5 py-2 sm:py-1.5 text-xs text-white select-text cursor-text focus:outline-none focus:border-red-500"
                />
                <button
                  type="submit"
                  className="bg-[#5865F2] hover:bg-[#4752C4] text-xs font-medium text-white px-3.5 py-2 sm:py-1.5 rounded-md cursor-pointer transition shrink-0"
                >
                  Enviar
                </button>
              </form>
            </div>
          </aside>
        )}
      </div>

      {replayModal &&
        React.createElement(ReplayPlayerModal, {
          replayModal,
          watchingStreams,
          onSelectStream: (sId) => handleReplayOrClip(sId),
          onClose: () => setReplayModal(null)
        })}
    </div>
  );
}

function ReplayPlayerModal({ replayModal, watchingStreams, onSelectStream, onClose }) {
  const canvasRef = useRef(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    const chunks = replayModal?.chunks || [];
    const canvas = canvasRef.current;
    if (!chunks.length || !canvas) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    let active = true;
    let decoder = null;
    let timerIds = [];

    const playLoop = () => {
      if (!active) return;
      try {
        if (decoder && decoder.state !== 'closed') decoder.close();
      } catch (e) {}

      const firstCodec = chunks[0].c || 'vp8';
      decoder = new VideoDecoder({
        output: (frame) => {
          if (!active) { frame.close(); return; }
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          ctx.drawImage(frame, 0, 0);
          frame.close();
        },
        error: () => {}
      });

      const cfg = firstCodec.startsWith('avc1')
        ? { codec: firstCodec, avc: { format: 'annexb' }, optimizeForLatency: true }
        : { codec: firstCodec, optimizeForLatency: true };

      try {
        decoder.configure(cfg);
      } catch (e) { return; }

      const t0 = chunks[0].arrivedAt;
      const totalDurationMs = Math.max(1000, chunks[chunks.length - 1].arrivedAt - t0);

      chunks.forEach((ch) => {
        const delay = Math.max(0, ch.arrivedAt - t0);
        const tid = setTimeout(() => {
          if (!active || !decoder || decoder.state !== 'configured') return;
          try {
            decoder.decode(new EncodedVideoChunk({
              type: ch.t,
              timestamp: ch.ts,
              data: ch.data
            }));
          } catch (e) {}
        }, delay);
        timerIds.push(tid);
      });

      const loopTid = setTimeout(() => {
        timerIds = [];
        playLoop();
      }, totalDurationMs + 400);
      timerIds.push(loopTid);
    };

    playLoop();

    return () => {
      active = false;
      timerIds.forEach(clearTimeout);
      try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (e) {}
    };
  }, [replayModal]);

  const handleDownloadClip = () => {
    const canvas = canvasRef.current;
    const chunks = replayModal?.chunks || [];
    if (!canvas || !chunks.length || exporting) return;

    setExporting(true);
    const durationMs = Math.min(30000, Math.max(2000, chunks[chunks.length - 1].arrivedAt - chunks[0].arrivedAt));
    const stream = canvas.captureStream(30);
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 5000000 });
    const parts = [];

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) parts.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(parts, { type: mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `VogelsTV_Clip_${replayModal.owner}_${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setExporting(false);
    };

    rec.start(200);
    setTimeout(() => {
      if (rec.state !== 'inactive') rec.stop();
    }, durationMs);
  };

  return (
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-3 sm:p-4 z-50 select-none">
      <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-3xl p-3 sm:p-4 space-y-3 shadow-2xl">
        <div className="flex items-center justify-between flex-wrap gap-2 border-b border-[#222834] pb-2.5">
          <h4 className="text-xs sm:text-sm font-bold text-white">
            ⏪ Replay Instantâneo (Últimos 30s) — <span className="text-red-400">{replayModal.owner}</span>
          </h4>

          <div className="flex items-center gap-2 flex-wrap">
            {watchingStreams.length > 1 && (
              <select
                value={replayModal.streamId}
                onChange={(e) => onSelectStream(e.target.value)}
                className="bg-[#1B202B] border border-[#2C3446] text-xs text-white rounded px-2.5 py-1 cursor-pointer"
              >
                {watchingStreams.map(ws => (
                  <option key={ws.id} value={ws.id}>
                    Tela de: {ws.owner} ({ws.res})
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={handleDownloadClip}
              disabled={exporting}
              className="bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-medium px-3 py-1 rounded cursor-pointer"
            >
              {exporting ? '⏳ Salvando...' : '💾 Baixar Clipe'}
            </button>
            <button
              onClick={onClose}
              className="text-xs text-gray-400 hover:text-white bg-[#1C212C] px-2.5 py-1 rounded cursor-pointer"
            >
              ✕ Fechar
            </button>
          </div>
        </div>

        <canvas
          ref={canvasRef}
          className="w-full rounded-lg bg-black max-h-[68vh] object-contain"
        />
      </div>
    </div>
  );
}

function VideoTile({
  streamObj,
  masterVolume,
  onRequestKeyframe,
  videoChunkHandlersRef,
  audioChunkHandlersRef,
  onStop,
  onStopWatching,
  onMute,
  onVolumeChange,
  onMinimize,
  onExpand,
  isExpanded,
  onClip,
  onReplay
}) {
  const tileRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteCanvasRef = useRef(null);
  const gainNodeRef = useRef(null);
  const [stats, setStats] = useState({ w: 0, h: 0, fps: 0, kbps: 0 });
  const [hasFirstFrame, setHasFirstFrame] = useState(Boolean(streamObj.isLocal));
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef(null);

  const scheduleAutoHide = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 2500);
  };

  const handleMouseMoveTile = () => {
    setControlsVisible(true);
    scheduleAutoHide();
  };

  const handleMouseLeaveTile = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setControlsVisible(false);
  };

  const handleToggleControlsOnTap = () => {
    setControlsVisible(prev => {
      const next = !prev;
      if (next) {
        scheduleAutoHide();
      } else if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
      }
      return next;
    });
  };

  const handleToggleFullscreen = async () => {
    try {
      const el = tileRef.current;
      if (!el) return;
      if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (el.requestFullscreen) {
          await el.requestFullscreen();
        } else if (el.webkitRequestFullscreen) {
          el.webkitRequestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    } catch (e) {}
  };

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement || document.webkitFullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    scheduleAutoHide();
    return () => {
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, []);

  const mutedRef = useRef(streamObj.muted);
  const volumeRef = useRef(streamObj.volume ?? 75);
  const masterVolRef = useRef(masterVolume ?? 80);

  useEffect(() => {
    mutedRef.current = streamObj.muted;
    volumeRef.current = streamObj.volume ?? 75;
    masterVolRef.current = masterVolume ?? 80;

    if (gainNodeRef.current) {
      const effectiveGain = streamObj.muted
        ? 0
        : ((streamObj.volume ?? 75) / 100) * ((masterVolume ?? 80) / 100);
      gainNodeRef.current.gain.value = effectiveGain;
    }
  }, [streamObj.muted, streamObj.volume, masterVolume]);

  useEffect(() => {
    if (!streamObj.isLocal || !localVideoRef.current || !streamObj.stream) return;
    localVideoRef.current.srcObject = streamObj.stream;
    localVideoRef.current.play().catch(() => {});
  }, [streamObj.isLocal, streamObj.stream]);

  // Decodificador Remoto com Fallback Automático (Se hardware falhar na GPU do amigo, muda para software sem tela preta!)
  useEffect(() => {
    if (streamObj.isLocal) return;

    const canvas = remoteCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });

    let decoder = null;
    let configuredCodec = null;
    let waitingForKey = true;
    let useSoftwareDecoder = false;
    let lastKeyReqTime = 0;
    let framesRendered = 0;
    let bytesCount = 0;
    let currentW = 1920;
    let currentH = 1080;

    const requestKeyThrottled = () => {
      const now = Date.now();
      if (now - lastKeyReqTime > 350) {
        lastKeyReqTime = now;
        onRequestKeyframe?.();
      }
    };

    const initDecoder = (codecStr, forceSoft = false) => {
      try {
        if (decoder && decoder.state !== 'closed') decoder.close();
      } catch (e) {}

      decoder = new VideoDecoder({
        output: (frame) => {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          currentW = frame.displayWidth;
          currentH = frame.displayHeight;
          ctx.drawImage(frame, 0, 0);
          frame.close();
          if (framesRendered === 0) setHasFirstFrame(true);
          framesRendered++;
        },
        error: () => {
          // Se o decodificador de hardware da GPU do espectador falhar, ativa o decodificador de software automaticamente!
          useSoftwareDecoder = true;
          waitingForKey = true;
          requestKeyThrottled();
        }
      });

      const hwMode = forceSoft || useSoftwareDecoder ? 'prefer-software' : 'no-preference';
      const cfg = codecStr.startsWith('avc1')
        ? { codec: codecStr, avc: { format: 'annexb' }, optimizeForLatency: true, hardwareAcceleration: hwMode }
        : { codec: codecStr, optimizeForLatency: true, hardwareAcceleration: hwMode };

      try {
        decoder.configure(cfg);
      } catch (e) {
        try {
          decoder.configure({ codec: codecStr, optimizeForLatency: true });
        } catch (e2) {}
      }
      configuredCodec = codecStr;
      waitingForKey = true;
    };

    videoChunkHandlersRef.current[streamObj.id] = (meta, buffer) => {
      try {
        if (!decoder || decoder.state === 'closed' || configuredCodec !== meta.c) {
          initDecoder(meta.c || 'vp8', useSoftwareDecoder);
        }
        if (waitingForKey) {
          if (meta.t !== 'key') {
            requestKeyThrottled();
            return;
          }
          waitingForKey = false;
        }
        const uint8 = new Uint8Array(buffer);
        bytesCount += uint8.byteLength;
        const chunk = new EncodedVideoChunk({
          type: meta.t,
          timestamp: meta.ts || performance.now() * 1000,
          data: uint8
        });
        decoder.decode(chunk);
      } catch (err) {
        useSoftwareDecoder = true;
        waitingForKey = true;
        requestKeyThrottled();
      }
    };

    let audioCtx = null;
    let audioDecoder = null;
    let nextPlayTime = 0;
    let senderGainFactor = 0.7;

    if ('AudioDecoder' in window) {
      try {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
        const gainNode = audioCtx.createGain();
        gainNode.gain.value = mutedRef.current ? 0 : (volumeRef.current / 100) * (masterVolRef.current / 100);

        const compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -12;
        compressor.knee.value = 18;
        compressor.ratio.value = 8;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.15;

        gainNode.connect(compressor);
        compressor.connect(audioCtx.destination);
        gainNodeRef.current = gainNode;

        audioDecoder = new AudioDecoder({
          output: (audioData) => {
            try {
              if (!mutedRef.current && audioCtx && volumeRef.current > 0) {
                if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
                const numFrames = audioData.numberOfFrames;
                const numCh = audioData.numberOfChannels || 2;
                const audioBuffer = audioCtx.createBuffer(numCh, numFrames, audioData.sampleRate || 48000);

                const fmt = audioData.format || 'f32-planar';
                if (fmt.includes('planar')) {
                  for (let c = 0; c < numCh; c++) {
                    const chData = new Float32Array(numFrames);
                    audioData.copyTo(chData, { planeIndex: c, format: 'f32-planar' });
                    for (let i = 0; i < numFrames; i++) {
                      chData[i] = Math.max(-1, Math.min(1, chData[i] * senderGainFactor));
                    }
                    audioBuffer.copyToChannel(chData, c);
                  }
                } else {
                  const interleaved = new Float32Array(numFrames * numCh);
                  audioData.copyTo(interleaved, { planeIndex: 0 });
                  for (let c = 0; c < numCh; c++) {
                    const chData = audioBuffer.getChannelData(c);
                    for (let i = 0; i < numFrames; i++) {
                      chData[i] = Math.max(-1, Math.min(1, interleaved[i * numCh + c] * senderGainFactor));
                    }
                  }
                }

                const source = audioCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(gainNode);
                const now = audioCtx.currentTime;
                if (nextPlayTime < now || nextPlayTime - now > 0.2) {
                  nextPlayTime = now + 0.02;
                }
                source.start(nextPlayTime);
                nextPlayTime += audioBuffer.duration;
              }
            } catch (e) {
            } finally {
              audioData.close();
            }
          },
          error: () => {}
        });
        audioDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });

        audioChunkHandlersRef.current[streamObj.id] = (meta, buffer) => {
          if (meta && typeof meta.gain === 'number') {
            senderGainFactor = Math.max(0, Math.min(1, meta.gain / 100));
          }
          if (audioDecoder.state === 'configured' && audioDecoder.decodeQueueSize < 5) {
            try {
              audioDecoder.decode(new EncodedAudioChunk({
                type: 'key',
                timestamp: meta.ts || performance.now() * 1000,
                data: new Uint8Array(buffer)
              }));
            } catch (e) {}
          }
        };
      } catch (e) {}
    }

    onRequestKeyframe?.();
    const keyframeRetryTimer = setInterval(() => {
      if (waitingForKey) {
        requestKeyThrottled();
      }
    }, 450);

    const statTimer = setInterval(() => {
      const kbps = Math.round((bytesCount * 8) / 1000);
      setStats({ w: currentW, h: currentH, fps: framesRendered, kbps });
      framesRendered = 0;
      bytesCount = 0;
    }, 1000);

    return () => {
      clearInterval(keyframeRetryTimer);
      clearInterval(statTimer);
      delete videoChunkHandlersRef.current[streamObj.id];
      delete audioChunkHandlersRef.current[streamObj.id];
      try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (e) {}
      try { if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close(); } catch (e) {}
      try { if (audioCtx && audioCtx.state !== 'closed') audioCtx.close(); } catch (e) {}
    };
  }, [streamObj.id, streamObj.isLocal]);

  const currentVol = streamObj.muted ? 0 : (streamObj.volume ?? 75);

  return (
    <div
      ref={tileRef}
      onMouseMove={handleMouseMoveTile}
      onMouseEnter={handleMouseMoveTile}
      onMouseLeave={handleMouseLeaveTile}
      onClick={handleToggleControlsOnTap}
      onDoubleClick={handleToggleFullscreen}
      className={`relative bg-[#12151C] border border-[#222836] rounded-xl overflow-hidden flex items-center justify-center ${
        controlsVisible ? 'cursor-default' : 'cursor-none'
      }`}
    >
      {streamObj.isLocal ? (
        <video
          ref={localVideoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain bg-black"
        />
      ) : (
        <>
          <canvas
            ref={remoteCanvasRef}
            className="w-full h-full object-contain bg-black"
          />
          {!hasFirstFrame && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 pointer-events-none">
              <span className="text-xs text-gray-300 animate-pulse">Sincronizando vídeo de {streamObj.owner}...</span>
            </div>
          )}
        </>
      )}

      <div
        onClick={e => e.stopPropagation()}
        className={`absolute top-2.5 left-2.5 z-30 flex items-center gap-2 bg-black/80 px-2.5 py-1 rounded-md border border-white/10 text-[11px] sm:text-xs transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
        <span className="font-semibold text-white">{streamObj.owner} {streamObj.isLocal && '(Você)'}</span>
        <span className="text-emerald-300 font-mono text-[10px] sm:text-[11px]">
          {streamObj.isLocal
            ? `· ${streamObj.res} · ${streamObj.fps} FPS · Local`
            : `· ${stats.h ? stats.h + 'p' : streamObj.res} · ${stats.fps} FPS · ${stats.kbps} kbps`}
        </span>
      </div>

      <div
        onClick={e => e.stopPropagation()}
        className={`absolute bottom-2 right-2 left-2 sm:left-auto z-30 flex flex-wrap items-center justify-end gap-1.5 bg-black/85 px-2 py-1.5 rounded-lg border border-white/10 transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {!streamObj.isLocal && (
          <div className="flex items-center gap-1.5 bg-[#1B202B] border border-[#2C3446] px-2 py-0.5 rounded">
            <button
              onClick={onMute}
              className="text-white text-xs cursor-pointer"
              title={streamObj.muted ? 'Desmutar' : 'Mutar'}
            >
              {currentVol === 0 ? '🔇' : currentVol < 50 ? '🔉' : '🔊'}
            </button>
            <input
              type="range"
              min="0"
              max="100"
              value={currentVol}
              onChange={(e) => onVolumeChange(e.target.value)}
              className="w-16 sm:w-20 h-1.5 accent-red-500 cursor-pointer"
              title={`Volume: ${currentVol}%`}
            />
            <span className="text-[10px] font-mono text-gray-200 w-7 text-right">
              {currentVol}%
            </span>
          </div>
        )}
        <button onClick={onClip} className="bg-[#1E2433] hover:bg-indigo-600 text-white text-[10px] sm:text-[11px] px-2 py-1 rounded cursor-pointer">🎬 Clipe</button>
        <button onClick={onReplay} className="bg-[#1E2433] hover:bg-indigo-600 text-white text-[10px] sm:text-[11px] px-2 py-1 rounded cursor-pointer">⏪ Replay</button>
        <button onClick={onMinimize} className="hidden sm:inline-block bg-[#1E2433] hover:bg-[#2A3246] text-white text-[11px] px-2 py-1 rounded cursor-pointer">_ Minimizar</button>
        <button onClick={onExpand} className="hidden sm:inline-block bg-[#1E2433] hover:bg-[#2A3246] text-white text-[11px] px-2 py-1 rounded cursor-pointer">
          {isExpanded ? '🗗 Restaurar' : '🗖 Expandir'}
        </button>
        <button
          onClick={handleToggleFullscreen}
          className="bg-[#1E2433] hover:bg-[#2A3246] text-white text-[10px] sm:text-[11px] px-2 py-1 rounded cursor-pointer font-medium"
          title="Tela Cheia (ou dê duplo clique no vídeo)"
        >
          {isFullscreen ? '🗗 Sair Tela Cheia' : '⛶ Tela Cheia'}
        </button>
        {!streamObj.isLocal && (
          <button onClick={onStopWatching} className="bg-red-600/80 hover:bg-red-600 text-white text-[10px] sm:text-[11px] px-2 py-1 rounded cursor-pointer">
            Parar
          </button>
        )}
        {streamObj.isLocal && (
          <button onClick={onStop} className="bg-red-600/80 hover:bg-red-600 text-white text-[10px] sm:text-[11px] px-2.5 py-1 rounded cursor-pointer">
            Parar
          </button>
        )}
      </div>
    </div>
  );
}