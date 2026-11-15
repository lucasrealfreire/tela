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
  const cleanRoom = r.toLowerCase().replace(/\s+/g, '-').slice(0, 40) || 'squad-brasil';
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

// Configura High Profile com VBR (Variable Bitrate) para manter imagem limpa sem estourar o limite de tráfego da Cloudflare!
async function findSupportedVideoConfig(width, height, fps, bitrate, preferredCodec) {
  const w = Math.max(2, Math.floor(width / 2) * 2);
  const h = Math.max(2, Math.floor(height / 2) * 2);

  const candidates = [
    preferredCodec === 'H264' ? { codec: 'avc1.64002a', avc: { format: 'annexb' } } : null,
    preferredCodec === 'H264' ? { codec: 'avc1.4d002a', avc: { format: 'annexb' } } : null,
    preferredCodec === 'VP9' ? { codec: 'vp09.00.10.08' } : null,
    { codec: 'vp8' },
    { codec: 'avc1.42e01f', avc: { format: 'annexb' } }
  ].filter(Boolean);

  for (const hw of ['prefer-hardware', 'no-preference']) {
    for (const cand of candidates) {
      try {
        const cfg = {
          ...cand,
          width: w,
          height: h,
          bitrate,
          bitrateMode: 'variable',
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
  const [nickname, setNickname] = useState(() => localStorage.getItem('tv_nick') || 'gosadinhas');
  const [roomName, setRoomName] = useState('squad-brasil');
  const [roomPassword, setRoomPassword] = useState('');

  const [quality, setQuality] = useState('1080p');
  // 4000 kbps VBR High Profile por padrão: imagem limpa a 60fps sem derrubar a instância da Cloudflare!
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
  const [desktopBridgeActive, setDesktopBridgeActive] = useState(false);
  const [discordIsolatedActive, setDiscordIsolatedActive] = useState(false);

  const [codec, setCodec] = useState('H264');

  // ID único persistente desta aba (garante que reconexões automáticas nunca dupliquem nem derrubem o usuário!)
  const persistentClientIdRef = useRef('u_' + Math.random().toString(36).substring(2, 10));
  const [myId, setMyId] = useState(persistentClientIdRef.current);
  const myIdRef = useRef(persistentClientIdRef.current);
  const localStreamIdsRef = useRef(new Set());
  const activeLocalMetasRef = useRef(new Map()); // streamId -> meta (para reanunciar automaticamente após reconexão!)

  const [streams, setStreams] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([
    { id: 'sys-1', system: true, text: 'Sessão iniciada com proteção Anti-Queda ativa. Mande o link para a galera!' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef(null);

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
  const excludeDiscordRef = useRef(excludeDiscordAudio);
  const outgoingVolumeRef = useRef(outgoingVolume);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    const checkBridge = async () => {
      try {
        const res = await fetch('http://127.0.0.1:19876/ping', { method: 'GET', mode: 'cors' });
        const data = await res.json();
        if (data?.ok) setDesktopBridgeActive(true);
      } catch (e) {}
    };
    checkBridge();
    const timer = setInterval(checkBridge, 4000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    excludeDiscordRef.current = excludeDiscordAudio;
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

  useEffect(() => {
    localStorage.setItem('tv_nick', nickname);
  }, [nickname]);

  useEffect(() => {
    if (!inRoom) return;

    const { cleanRoom, cleanPass, fullRoomKey } = parseRoomInput(roomName, roomPassword);
    const cid = persistentClientIdRef.current;
    setParticipants([{ id: cid, nick: nickname }]);

    let isUnmounted = false;
    let controlWs = null;
    let mediaWs = null;
    let fallbackSocket = null;
    let heartbeatTimer = null;
    let controlReconnectTimer = null;
    let mediaReconnectTimer = null;

    const onRoomUsers = (list) => {
      if (isUnmounted) return;
      setParticipants(list && list.length ? list : [{ id: cid, nick: nickname }]);
    };

    const onActiveStreams = (list) => {
      if (isUnmounted || !Array.isArray(list)) return;
      setStreams(prev => {
        const localOnes = prev.filter(s => s.isLocal);
        const remoteOnes = prev.filter(s => !s.isLocal);
        const updatedRemotes = [];

        list.forEach(st => {
          if (!st || !st.streamId) return;
          if (
            st.senderId === myIdRef.current ||
            st.senderId === cid ||
            localStreamIdsRef.current.has(st.streamId) ||
            localOnes.some(l => l.id === st.streamId)
          ) {
            return;
          }

          const existing = remoteOnes.find(p => p.id === st.streamId);
          if (existing) {
            updatedRemotes.push({
              ...existing,
              senderId: st.senderId,
              owner: st.owner,
              res: st.res,
              fps: st.fps
            });
          } else {
            const isStopped = stoppedWatchingSetRef.current.has(st.streamId);
            updatedRemotes.push({
              id: st.streamId,
              senderId: st.senderId,
              owner: st.owner,
              type: st.type,
              res: st.res,
              fps: st.fps,
              volume: 75,
              muted: false,
              minimized: false,
              watching: !isStopped,
              watchSession: 1,
              isLocal: false
            });
          }
        });

        return [...localOnes, ...updatedRemotes];
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
            type: st.type,
            res: st.res,
            fps: st.fps,
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
            res: `${meta.h}p`,
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

    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const controlUrl = `${wsProto}//${window.location.host}/ws?room=${encodeURIComponent(fullRoomKey)}&role=control&cid=${encodeURIComponent(cid)}`;
    const mediaUrl = `${wsProto}//${window.location.host}/ws?room=${encodeURIComponent(fullRoomKey)}&role=media&cid=${encodeURIComponent(cid)}`;

    let cfEverConnected = false;

    const connectControlWs = () => {
      if (isUnmounted || fallbackSocket) return;
      try {
        if (controlWs) {
          controlWs.onclose = null;
          controlWs.onerror = null;
          try { controlWs.close(); } catch (e) {}
        }
        controlWs = new WebSocket(controlUrl);

        controlWs.onopen = () => {
          if (isUnmounted) return;
          cfEverConnected = true;
          controlWs.send(JSON.stringify({
            type: 'join-room',
            clientId: cid,
            roomName: cleanRoom,
            roomPassword: cleanPass,
            nickname
          }));

          // Se já estávamos transmitindo antes da reconexão, reanuncia nossa live automaticamente sem interromper!
          activeLocalMetasRef.current.forEach((meta) => {
            controlWs.send(JSON.stringify({ type: 'start-stream', meta }));
          });
        };

        controlWs.onmessage = (event) => {
          if (isUnmounted || event.data instanceof ArrayBuffer) return;
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

        controlWs.onclose = () => {
          if (isUnmounted) return;
          if (!cfEverConnected && !fallbackSocket) {
            startSocketIoFallback();
          } else if (cfEverConnected) {
            // RECONEXÃO AUTOMÁTICA EM 400ms (Nunca derruba o usuário da sala!)
            clearTimeout(controlReconnectTimer);
            controlReconnectTimer = setTimeout(connectControlWs, 400);
          }
        };

        controlWs.onerror = () => {
          if (!cfEverConnected && !fallbackSocket && !isUnmounted) {
            startSocketIoFallback();
          }
        };
      } catch (e) {
        if (!cfEverConnected) startSocketIoFallback();
      }
    };

    const connectMediaWs = () => {
      if (isUnmounted || fallbackSocket) return;
      try {
        if (mediaWs) {
          mediaWs.onclose = null;
          mediaWs.onerror = null;
          try { mediaWs.close(); } catch (e) {}
        }
        mediaWs = new WebSocket(mediaUrl);
        mediaWs.binaryType = 'arraybuffer';

        mediaWs.onopen = () => {
          if (isUnmounted) return;
          cfEverConnected = true;
          Object.values(activeEncodersRef.current).forEach(enc => enc.forceKey?.());
        };

        mediaWs.onmessage = (event) => {
          if (isUnmounted || !(event.data instanceof ArrayBuffer)) return;
          try {
            const { headerObj, payloadBuffer } = unpackBinaryFrame(event.data);
            if (headerObj.k === 'v') onVChunk(headerObj, payloadBuffer);
            else if (headerObj.k === 'a') onAChunk(headerObj, payloadBuffer);
          } catch (e) {}
        };

        mediaWs.onclose = () => {
          if (isUnmounted) return;
          if (cfEverConnected) {
            clearTimeout(mediaReconnectTimer);
            mediaReconnectTimer = setTimeout(connectMediaWs, 400);
          }
        };
      } catch (e) {}
    };

    transportRef.current = {
      mode: 'cf-ws',
      sendControl: (type, payload = {}) => {
        if (controlWs && controlWs.readyState === 1) {
          controlWs.send(JSON.stringify({ type, ...payload }));
        }
      },
      sendVideoChunk: (meta, buffer) => {
        if (mediaWs && mediaWs.readyState === 1) {
          mediaWs.send(packBinaryFrame({ k: 'v', ...meta }, buffer));
        }
      },
      sendAudioChunk: (meta, buffer) => {
        if (mediaWs && mediaWs.readyState === 1 && mediaWs.bufferedAmount < 524288) {
          mediaWs.send(packBinaryFrame({ k: 'a', ...meta }, buffer));
        }
      },
      getBufferedAmount: () => (mediaWs ? mediaWs.bufferedAmount : 0)
    };

    connectControlWs();
    connectMediaWs();

    // Heartbeat a cada 15 segundos nos DOIS sockets: impede o timeout de 100s/5min da Cloudflare!
    heartbeatTimer = setInterval(() => {
      if (controlWs && controlWs.readyState === 1) {
        try { controlWs.send('ping'); } catch (e) {}
      }
      if (mediaWs && mediaWs.readyState === 1) {
        try { mediaWs.send('ping'); } catch (e) {}
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
      clearTimeout(controlReconnectTimer);
      clearTimeout(mediaReconnectTimer);
      Object.values(activeEncodersRef.current).forEach(e => e.stop?.());
      Object.values(ramClipBuffersRef.current).forEach(b => b.clear?.());
      try { if (controlWs) { controlWs.onclose = null; controlWs.close(); } } catch (e) {}
      try { if (mediaWs) { mediaWs.onclose = null; mediaWs.close(); } } catch (e) {}
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
      setRoomName(cleanRoom);
      if (cleanPass) setRoomPassword(cleanPass);
    } catch (e) {
      alert('Cole o link diretamente no campo "Nome da sala" (Ctrl+V).');
    }
  };

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
    const abortCtrl = new AbortController();

    ramClipBuffersRef.current[streamId] = createZeroCpuChunkBuffer();

    const videoEncoder = new VideoEncoder({
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
      error: () => {}
    });

    const configureEncoderNow = async (rawW, rawH) => {
      const cfg = RES_CONFIG[qualityRef.current] || RES_CONFIG['1080p'];
      const targetFps = Number(fpsRef.current) || 60;
      const targetBitrateBps = (Number(bitrateKbpsRef.current) || 4000) * 1000;
      const ratio = rawW && rawH ? rawW / rawH : 16 / 9;
      targetH = Math.min(cfg.height, rawH || cfg.height);
      targetW = Math.round(targetH * ratio);

      const bestCfg = await findSupportedVideoConfig(targetW, targetH, targetFps, targetBitrateBps, codecRef.current);
      currentCodecStr = bestCfg.codec;
      targetW = bestCfg.width;
      targetH = bestCfg.height;

      if (videoEncoder.state !== 'closed') {
        videoEncoder.configure(bestCfg);
        forceKey = true;
      }
    };

    const settings = vTrack.getSettings ? vTrack.getSettings() : {};
    await configureEncoderNow(settings.width || 1920, settings.height || 1080);

    let audioEncoder = null;
    if (!isCamera && 'AudioEncoder' in window) {
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

        let usingDesktopWasapi = false;
        try {
          const excludeFlag = excludeDiscordRef.current ? 1 : 0;
          const response = await fetch(`http://127.0.0.1:19876/clean-audio?exclude=${excludeFlag}`, {
            signal: abortCtrl.signal
          });
          if (response.ok && response.body) {
            usingDesktopWasapi = true;
            setDesktopBridgeActive(true);
            setDiscordIsolatedActive(excludeDiscordRef.current);

            mediaStream.getAudioTracks().forEach(t => {
              t.enabled = false;
              t.stop();
            });

            const reader = response.body.getReader();
            let leftover = new Uint8Array(0);
            const frameBytes = 1920 * 4;
            let timestampUs = 0;

            (async () => {
              while (running) {
                const { value, done } = await reader.read();
                if (done || !value) break;

                const combined = new Uint8Array(leftover.length + value.length);
                combined.set(leftover, 0);
                combined.set(value, leftover.length);

                let offset = 0;
                while (offset + frameBytes <= combined.length) {
                  const slice = combined.subarray(offset, offset + frameBytes);
                  offset += frameBytes;

                  if (audioEncoder.state === 'configured' && audioEncoder.encodeQueueSize < 3) {
                    const ad = new AudioData({
                      format: 's16',
                      sampleRate: 48000,
                      numberOfFrames: 1920,
                      numberOfChannels: 2,
                      timestamp: timestampUs,
                      data: slice
                    });
                    audioEncoder.encode(ad);
                    ad.close();
                    timestampUs += 40000;
                  }
                }
                leftover = combined.slice(offset);
              }
            })().catch(() => {});
          }
        } catch (e) {}

        if (!usingDesktopWasapi) {
          const aTrack = mediaStream.getAudioTracks()[0];
          if (aTrack && 'MediaStreamTrackProcessor' in window) {
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
          }
        }
      } catch (e) {}
    }

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
          const netBusy = transportRef.current.getBufferedAmount() > 524288;

          if (now - lastFrameTime < minInterval || videoEncoder.encodeQueueSize > 2 || netBusy) {
            frame.close();
            continue;
          }
          lastFrameTime = now;

          try {
            if (videoEncoder.state === 'configured') {
              // Keyframe a cada 240 frames (4s) para evitar picos de tráfego na Cloudflare
              const isKey = forceKey || (frameCount % 240 === 0);
              if (isKey) {
                forceKey = false;
                lastKeyframeTs = now;
              }
              videoEncoder.encode(frame, { keyFrame: isKey });
              frameCount++;
            }
          } catch (e) {
          } finally {
            frame.close();
          }
        }
      })().catch(() => {});
    }

    activeEncodersRef.current[streamId] = {
      forceKey: () => {
        const now = performance.now();
        if (now - lastKeyframeTs > 1500) {
          forceKey = true;
        }
      },
      reconfigure: () => {
        const st = vTrack.getSettings ? vTrack.getSettings() : {};
        configureEncoderNow(st.width || 1920, st.height || 1080);
      },
      stop: () => {
        running = false;
        abortCtrl.abort();
        setDiscordIsolatedActive(false);
        try { if (videoEncoder.state !== 'closed') videoEncoder.close(); } catch (e) {}
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
      alert('Não foi possível acessar a webcam.');
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
      <div className="h-screen w-screen bg-[#0D0F13] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#151922] border border-[#232936] rounded-xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            {renderVogelsLogo('text-2xl')}
            {desktopBridgeActive && (
              <span className="text-[11px] bg-emerald-950/60 border border-emerald-700/50 text-emerald-300 px-2 py-0.5 rounded font-medium">
                App Windows Ativo
              </span>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setRoomName(cleanRoom);
              if (cleanPass) setRoomPassword(cleanPass);
              if (nickname.trim() && cleanRoom) setInRoom(true);
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
                placeholder="Ex: gosadinhas"
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white select-text focus:outline-none focus:border-red-500"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs text-gray-400 font-medium">Nome da sala (ou cole o link)</label>
                <button
                  type="button"
                  onClick={handlePasteRoomLink}
                  className="text-[11px] text-red-400 hover:text-red-300 cursor-pointer"
                >
                  📋 Colar link da sala
                </button>
              </div>
              <input
                type="text"
                required
                value={roomName}
                onChange={e => setRoomName(e.target.value)}
                placeholder="Ex: squad-brasil"
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white select-text focus:outline-none focus:border-red-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Senha da sala (opcional)</label>
              <input
                type="text"
                value={roomPassword}
                onChange={e => setRoomPassword(e.target.value)}
                placeholder="Deixe vazio se a sala não tiver senha"
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white select-text focus:outline-none focus:border-red-500"
              />
            </div>
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
    <div className="h-screen w-screen bg-[#0D0F13] text-[#E2E8F0] flex flex-col overflow-hidden">
      <header className="h-12 bg-[#12151C] border-b border-[#1E232E] px-3 flex items-center justify-between gap-2 shrink-0 z-20 select-none">
        <div className="flex items-center gap-2">
          {renderVogelsLogo('text-base')}
          <span className="text-amber-400 text-xs">🔒</span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[11px] text-gray-200 px-2 py-0.5 rounded-full font-mono">
            {cleanRoom}
          </span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[11px] text-emerald-400 px-2 py-0.5 rounded-full font-medium">
            {participants.length} online
          </span>
          {discordIsolatedActive && (
            <span className="bg-emerald-950/70 border border-emerald-700/60 text-[11px] text-emerald-300 px-2 py-0.5 rounded-full">
              🛡️ Discord Isolado na Live
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <select value={quality} onChange={e => setQuality(e.target.value)} className="bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            <option value="720p">720p (HD)</option>
            <option value="1080p">1080p (Full HD)</option>
            <option value="1440p">2K (1440p)</option>
          </select>

          <select
            value={bitrateKbps}
            onChange={e => setBitrateKbps(Number(e.target.value))}
            className="bg-[#171B24] border border-emerald-500/40 text-xs text-emerald-300 font-semibold rounded-md px-2.5 py-1.5 cursor-pointer"
            title="Taxa de Bits Inteligente (VBR)"
          >
            <option value={2500}>2500 kbps (Econômico)</option>
            <option value={4000}>4000 kbps (VBR HD · Estável)</option>
            <option value={6000}>6000 kbps (VBR Ultra)</option>
            <option value={8000}>8000 kbps (8K Máximo)</option>
          </select>

          <select value={fps} onChange={e => setFps(Number(e.target.value))} className="bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>

          <div className="relative">
            <button
              onClick={() => {
                setShowMixer(!showMixer);
                setShowSettings(false);
              }}
              className={`border text-xs rounded-md px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer ${
                showMixer ? 'bg-red-600/30 border-red-500 text-white' : 'bg-[#171B24] hover:bg-[#1E2330] border-[#282E3D] text-gray-200'
              }`}
            >
              <span>🎚️</span> Mixer
            </button>

            {showMixer && (
              <div className="absolute right-0 mt-2 w-80 bg-[#141820] border border-[#262C3A] rounded-xl shadow-2xl p-4 z-50 text-left space-y-4">
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

          <button onClick={handleShareCamera} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer">
            <span>📷</span> Câmera
          </button>

          {watchingStreams.length > 0 && (
            <button
              onClick={() => handleReplayOrClip(watchingStreams[0].id)}
              className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer"
              title="Voltar 30 segundos do compartilhamento"
            >
              <span>⏪</span> Replay 30s
            </button>
          )}

          <button
            onClick={() => setGameMode(!gameMode)}
            className={`border text-xs rounded-md px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer ${
              gameMode ? 'bg-indigo-600/30 border-indigo-500 text-indigo-200' : 'bg-[#171B24] border-[#282E3D] text-gray-200'
            }`}
          >
            <span>🎮</span> Modo jogo
          </button>

          <button onClick={handleShareScreen} className="bg-[#5865F2] hover:bg-[#4752C4] text-white font-medium text-xs rounded-md px-3 py-1.5 cursor-pointer">
            Compartilhar tela
          </button>

          <div className="relative">
            <button
              onClick={() => {
                setShowSettings(!showSettings);
                setShowMixer(false);
              }}
              className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer"
            >
              ⚙️
            </button>
            {showSettings && (
              <div className="absolute right-0 mt-2 w-80 bg-[#141820] border border-[#262C3A] rounded-xl shadow-2xl p-4 z-50 text-left space-y-3.5">
                <div className="flex items-center justify-between border-b border-[#222834] pb-2">
                  <span className="font-semibold text-sm text-white">Configurações</span>
                  <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white text-sm px-1.5 py-0.5 rounded bg-[#1C212C]">✕</button>
                </div>

                <div className="bg-[#1B202B] border border-[#2B3242] rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">Mutar Discord na stream (Anti-Eco)</span>
                    <input
                      type="checkbox"
                      checked={excludeDiscordAudio}
                      onChange={e => setExcludeDiscordAudio(e.target.checked)}
                      className="w-4 h-4 accent-red-500 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1 leading-snug">
                    Vem ativado por padrão no App Baixável: quem assiste à sua live não escuta o seu Discord (evita vozes duplicadas), mas você continua ouvindo seus amigos normalmente.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Codec de Hardware (Placa de Vídeo)</label>
                  <select value={codec} onChange={e => setCodec(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="H264">H.264 High Profile VBR (NVENC)</option>
                    <option value="VP9">VP9 Alta Nitidez</option>
                    <option value="VP8">VP8 Rápido</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <a
            href="/VogelsTV.exe"
            download="VogelsTV.exe"
            onClick={() => {
              try { navigator.clipboard.writeText(currentRoomUrl); } catch (e) {}
            }}
            className="bg-[#2B82F6] hover:bg-[#1D6FE0] text-white font-medium text-xs rounded-md px-3 py-1.5 cursor-pointer inline-flex items-center"
            title="Baixar aplicativo VogelsTV.exe com isolamento de voz do Discord por padrão"
          >
            Baixar app
          </a>

          <button onClick={copyRoomLink} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            🔗 Link
          </button>

          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className={`border text-xs rounded-md px-2.5 py-1.5 flex items-center gap-1 cursor-pointer transition ${
              sidebarCollapsed
                ? 'bg-red-600/25 border-red-500/60 text-red-200'
                : 'bg-[#171B24] hover:bg-[#1E2330] border-[#282E3D] text-gray-200'
            }`}
          >
            <span>💬</span> {sidebarCollapsed ? 'Abrir Chat' : 'Ocultar Chat'}
          </button>

          <button onClick={() => setInRoom(false)} className="bg-[#171B24] hover:bg-red-950/60 border border-red-800/60 text-xs text-red-300 rounded-md px-2.5 py-1.5 cursor-pointer">
            Sair
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        <main className="flex-1 bg-[#0B0D11] relative flex flex-col p-3 overflow-hidden select-none">
          {watchingStreams.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3">
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
                  <p className="text-xs text-gray-400 mt-0.5">
                    Clique em <button onClick={handleShareScreen} className="text-gray-200 font-semibold hover:underline cursor-pointer">Compartilhar tela</button> para começar.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className={`flex-1 grid gap-3 overflow-hidden ${expandedId || watchingStreams.length === 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
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
            <div className="mt-2 flex items-center gap-2 bg-[#141820] border border-[#232936] px-3 py-1.5 rounded-lg">
              <span className="text-[11px] text-gray-400">Minimizadas:</span>
              {minimizedStreams.map(s => (
                <button key={s.id} onClick={() => setStreams(prev => prev.map(x => x.id === s.id ? { ...x, minimized: false } : x))} className="text-xs bg-[#1E2433] text-indigo-300 px-2 py-0.5 rounded cursor-pointer">
                  Restaurar: {s.owner}
                </button>
              ))}
            </div>
          )}

          <div className="absolute bottom-1.5 left-3 text-[11px] opacity-60 pointer-events-none">
            {renderVogelsLogo('text-xs')}
          </div>
        </main>

        {!sidebarCollapsed && (
          <aside className="w-72 bg-[#12151C] border-l border-[#1E232E] flex flex-col shrink-0 transition-all">
            <div className="p-3 border-b border-[#1E232E] select-none">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] font-bold tracking-wider text-gray-400 uppercase">PARTICIPANTES</h3>
                <button
                  onClick={() => setSidebarCollapsed(true)}
                  className="text-[10px] text-gray-400 hover:text-white bg-[#1B202B] px-1.5 py-0.5 rounded cursor-pointer"
                >
                  ❯ Minimizar
                </button>
              </div>
              <div className="space-y-1.5">
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

            <div className="flex-1 flex flex-col p-3 overflow-hidden select-text">
              <h3 className="text-[10px] font-bold tracking-wider text-gray-400 uppercase mb-2 select-none">CHAT</h3>
              <div className="flex-1 bg-[#0D1016] border border-[#1E232E] rounded-lg p-2.5 overflow-y-auto space-y-2 text-xs">
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
              <form onSubmit={sendChat} className="mt-2 flex gap-1.5">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.stopPropagation()}
                  placeholder="Digite sua mensagem..."
                  autoComplete="off"
                  className="flex-1 bg-[#0D1016] border border-[#242A38] rounded-md px-2.5 py-1.5 text-xs text-white select-text cursor-text focus:outline-none focus:border-red-500"
                />
                <button
                  type="submit"
                  className="bg-[#5865F2] hover:bg-[#4752C4] text-xs font-medium text-white px-3 py-1.5 rounded-md cursor-pointer transition"
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
    <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50 select-none">
      <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-3xl p-4 space-y-3 shadow-2xl">
        <div className="flex items-center justify-between flex-wrap gap-2 border-b border-[#222834] pb-2.5">
          <h4 className="text-sm font-bold text-white">
            ⏪ Replay Instantâneo (Últimos 30s) — <span className="text-red-400">{replayModal.owner}</span>
          </h4>

          <div className="flex items-center gap-2">
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
          className="w-full rounded-lg bg-black max-h-[72vh] object-contain"
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
  const localVideoRef = useRef(null);
  const remoteCanvasRef = useRef(null);
  const gainNodeRef = useRef(null);
  const [stats, setStats] = useState({ w: 0, h: 0, fps: 0, kbps: 0 });

  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef(null);

  const handleMouseMoveTile = () => {
    setControlsVisible(true);
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      setControlsVisible(false);
    }, 2500);
  };

  const handleMouseLeaveTile = () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    setControlsVisible(false);
  };

  useEffect(() => {
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 3000);
    return () => {
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

  useEffect(() => {
    if (streamObj.isLocal) return;

    const canvas = remoteCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    let decoder = null;
    let configuredCodec = null;
    let waitingForKey = true;
    let lastKeyReqTime = 0;
    let framesRendered = 0;
    let bytesCount = 0;
    let currentW = 1920;
    let currentH = 1080;

    const requestKeyThrottled = () => {
      const now = Date.now();
      if (now - lastKeyReqTime > 1500) {
        lastKeyReqTime = now;
        onRequestKeyframe?.();
      }
    };

    const initDecoder = (codecStr) => {
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
          framesRendered++;
        },
        error: () => {
          waitingForKey = true;
          requestKeyThrottled();
        }
      });

      const cfg = codecStr.startsWith('avc1')
        ? { codec: codecStr, avc: { format: 'annexb' }, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' }
        : { codec: codecStr, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' };

      decoder.configure(cfg);
      configuredCodec = codecStr;
      waitingForKey = true;
    };

    videoChunkHandlersRef.current[streamObj.id] = (meta, buffer) => {
      try {
        if (!decoder || decoder.state === 'closed' || configuredCodec !== meta.c) {
          initDecoder(meta.c || 'vp8');
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
    }, 800);

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
      onMouseMove={handleMouseMoveTile}
      onMouseEnter={handleMouseMoveTile}
      onMouseLeave={handleMouseLeaveTile}
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
        <canvas
          ref={remoteCanvasRef}
          className="w-full h-full object-contain bg-black"
        />
      )}

      <div
        className={`absolute top-2.5 left-2.5 z-30 flex items-center gap-2 bg-black/80 px-2.5 py-1 rounded-md border border-white/10 text-xs transition-opacity duration-300 ${
          controlsVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
        <span className="font-semibold text-white">{streamObj.owner} {streamObj.isLocal && '(Você)'}</span>
        <span className="text-emerald-300 font-mono text-[11px]">
          {streamObj.isLocal
            ? `· ${streamObj.res} · ${streamObj.fps} FPS · Local`
            : `· ${stats.h ? stats.h + 'p' : streamObj.res} · ${stats.fps} FPS · ${stats.kbps} kbps`}
        </span>
      </div>

      <div
        className={`absolute bottom-2.5 right-2.5 z-30 flex items-center gap-2 bg-black/85 px-2.5 py-1.5 rounded-lg border border-white/10 transition-opacity duration-300 ${
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
              className="w-20 h-1.5 accent-red-500 cursor-pointer"
              title={`Volume: ${currentVol}%`}
            />
            <span className="text-[10px] font-mono text-gray-200 w-7 text-right">
              {currentVol}%
            </span>
          </div>
        )}
        <button onClick={onClip} className="bg-[#1E2433] hover:bg-indigo-600 text-white text-[11px] px-2.5 py-1 rounded cursor-pointer">🎬 Clipe 30s</button>
        <button onClick={onReplay} className="bg-[#1E2433] hover:bg-indigo-600 text-white text-[11px] px-2 py-1 rounded cursor-pointer">⏪ Replay</button>
        <button onClick={onMinimize} className="bg-[#1E2433] hover:bg-[#2A3246] text-white text-[11px] px-2 py-1 rounded cursor-pointer">_ Minimizar</button>
        <button onClick={onExpand} className="bg-[#1E2433] hover:bg-[#2A3246] text-white text-[11px] px-2 py-1 rounded cursor-pointer">
          {isExpanded ? '🗗 Restaurar' : '⛶ Expandir'}
        </button>
        {!streamObj.isLocal && (
          <button onClick={onStopWatching} className="bg-red-600/80 hover:bg-red-600 text-white text-[11px] px-2.5 py-1 rounded cursor-pointer">
            Parar de assistir
          </button>
        )}
        {streamObj.isLocal && (
          <button onClick={onStop} className="bg-red-600/80 hover:bg-red-600 text-white text-[11px] px-2.5 py-1 rounded cursor-pointer">
            Parar
          </button>
        )}
      </div>
    </div>
  );
}