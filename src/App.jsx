import React, { useState, useEffect, useRef } from 'react';

const ICE_SERVERS = [
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

const RES_CONFIG = {
  '720p': { width: 1280, height: 720, bitrate: 2200000, label: '720p' },
  '1080p': { width: 1920, height: 1080, bitrate: 4000000, label: '1080p' },
  '1440p': { width: 2560, height: 1440, bitrate: 6500000, label: '2K (1440p)' }
};

function VogelsLogo({ size = 'text-sm' }) {
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
  const cleanRoom = r.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 32) || 'squad-brasil';
  const cleanPass = p.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20);
  return {
    cleanRoom,
    cleanPass,
    hostPeerId: `vtv-room-${cleanRoom}${cleanPass ? '-' + cleanPass : ''}`
  };
}

async function findSupportedVideoConfig(width, height, fps, bitrate, preferredCodec) {
  const w = Math.max(2, Math.floor(width / 2) * 2);
  const h = Math.max(2, Math.floor(height / 2) * 2);

  const candidates = [
    preferredCodec === 'H264' ? { codec: 'avc1.640033', avc: { format: 'annexb' } } : null,
    preferredCodec === 'VP9' ? { codec: 'vp09.00.10.08' } : null,
    { codec: 'vp8' },
    { codec: 'avc1.42002a', avc: { format: 'annexb' } }
  ].filter(Boolean);

  for (const cand of candidates) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
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

function createRolling30sBuffer(getStreamFn) {
  let slots = [];
  let active = true;

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
    ? 'video/webm;codecs=vp8'
    : MediaRecorder.isTypeSupported('video/mp4')
    ? 'video/mp4'
    : 'video/webm';

  const spawnRecorderSlot = () => {
    if (!active) return;
    try {
      const s = getStreamFn();
      if (!s || !s.getVideoTracks().length) return;
      const videoOnly = new MediaStream([s.getVideoTracks()[0]]);
      const rec = new MediaRecorder(videoOnly, { mimeType, videoBitsPerSecond: 3000000 });
      const slot = { rec, chunks: [], startTime: Date.now(), mimeType };

      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) slot.chunks.push(e.data);
      };
      rec.start(250);
      slots.push(slot);

      while (slots.length > 7) {
        const old = slots.shift();
        try { if (old.rec.state !== 'inactive') old.rec.stop(); } catch (e) {}
      }
    } catch (e) {}
  };

  spawnRecorderSlot();
  const interval = setInterval(spawnRecorderSlot, 5000);

  return {
    captureLast30s: () => {
      return new Promise((resolve) => {
        const validSlots = slots.filter(sl => sl.chunks.length > 0);
        if (!validSlots.length) return resolve(null);

        const now = Date.now();
        let chosen = validSlots[0];
        for (const sl of validSlots) {
          const age = (now - sl.startTime) / 1000;
          if (age >= 25 && age <= 34) {
            chosen = sl;
            break;
          }
        }

        const finish = () => {
          const blob = new Blob(chosen.chunks, { type: chosen.mimeType });
          const durationSec = Math.min(30, Math.round((Date.now() - chosen.startTime) / 1000));
          resolve({
            blob,
            url: URL.createObjectURL(blob),
            mimeType: chosen.mimeType,
            durationSec
          });
        };

        slots = slots.filter(s => s !== chosen);
        spawnRecorderSlot();

        if (chosen.rec.state !== 'inactive') {
          chosen.rec.onstop = finish;
          try { chosen.rec.stop(); } catch (e) { finish(); }
        } else {
          finish();
        }
      });
    },
    destroy: () => {
      active = false;
      clearInterval(interval);
      slots.forEach(sl => {
        try { if (sl.rec.state !== 'inactive') sl.rec.stop(); } catch (e) {}
      });
      slots = [];
    }
  };
}

export default function App() {
  const [inRoom, setInRoom] = useState(false);
  const [nickname, setNickname] = useState(() => localStorage.getItem('tv_nick') || 'gosadinhas');
  const [roomName, setRoomName] = useState('squad-brasil');
  const [roomPassword, setRoomPassword] = useState('');

  const [quality, setQuality] = useState('1080p');
  const [sharpness, setSharpness] = useState('motion');
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

  const [codec, setCodec] = useState('VP8');
  const [clipConfig, setClipConfig] = useState('720p');

  const [myPeerId, setMyPeerId] = useState('');
  const [streams, setStreams] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([
    { id: 'sys-1', system: true, text: 'Sessão criada com senha. Mande o link para a galera!' }
  ]);
  const [chatInput, setChatInput] = useState('');

  // Refs do Motor Serverless P2P Mesh (Funciona em .workers.dev, .pages.dev e Render sem precisar de backend!)
  const peerRef = useRef(null);
  const isHostRef = useRef(false);
  const dataConnsRef = useRef(new Map()); // peerId -> DataConnection
  const roomUsersMapRef = useRef(new Map()); // peerId -> { id, nick }
  const activeStreamsMapRef = useRef(new Map()); // streamId -> meta
  const localStreamsRef = useRef([]);
  const activeEncodersRef = useRef({});
  const videoChunkHandlersRef = useRef({});
  const audioChunkHandlersRef = useRef({});
  const clipManagersRef = useRef({});
  const stoppedWatchingSetRef = useRef(new Set());

  const qualityRef = useRef(quality);
  const fpsRef = useRef(fps);
  const codecRef = useRef(codec);
  const outgoingVolumeRef = useRef(outgoingVolume);

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
    fpsRef.current = fps;
    codecRef.current = codec;
    Object.values(activeEncodersRef.current).forEach(enc => enc.reconfigure?.());
  }, [quality, fps, codec]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sala')) setRoomName(params.get('sala'));
    if (params.get('senha')) setRoomPassword(params.get('senha'));
  }, []);

  useEffect(() => {
    localStorage.setItem('tv_nick', nickname);
  }, [nickname]);

  // Envia mensagem de controle ou binário para todos os participantes conectados na malha WebRTC
  const broadcastPacket = (packet, excludePeerId = null) => {
    dataConnsRef.current.forEach((conn, pid) => {
      if (pid !== excludePeerId && conn && conn.open) {
        try { conn.send(packet); } catch (e) {}
      }
    });
  };

  const syncRoomStateFromHost = () => {
    if (!isHostRef.current) return;
    const usersArray = Array.from(roomUsersMapRef.current.values());
    const streamsArray = Array.from(activeStreamsMapRef.current.values());
    setParticipants(usersArray);
    broadcastPacket({
      type: 'room-sync',
      users: usersArray,
      streams: streamsArray
    });
  };

  // Inicializa a Sala Serverless P2P (PeerJS Cloud + WebRTC DataChannel & MediaChannel)
  useEffect(() => {
    if (!inRoom || !window.Peer) return;

    const { hostPeerId } = parseRoomInput(roomName, roomPassword);
    let destroyed = false;
    let currentPeer = null;

    const handleIncomingPacket = (pkt, fromPeerId) => {
      if (!pkt || typeof pkt !== 'object') return;

      if (pkt.type === 'join-request' && isHostRef.current) {
        roomUsersMapRef.current.set(fromPeerId, { id: fromPeerId, nick: pkt.nick || 'Amigo' });
        syncRoomStateFromHost();
        // Envia as streams locais do Host para quem acabou de entrar
        localStreamsRef.current.forEach(ls => {
          try {
            currentPeer.call(fromPeerId, ls.stream, {
              metadata: {
                streamId: ls.id,
                senderId: currentPeer.id,
                owner: nickname,
                type: ls.type,
                res: ls.res,
                fps: ls.fps
              }
            });
          } catch (e) {}
        });
        Object.values(activeEncodersRef.current).forEach(enc => enc.forceKey?.());
      } else if (pkt.type === 'room-sync') {
        if (Array.isArray(pkt.users)) {
          setParticipants(pkt.users);
          // Conecta diretamente aos demais membros da sala (Mesh completa)
          pkt.users.forEach(u => {
            if (u.id !== currentPeer.id && !dataConnsRef.current.has(u.id)) {
              const c = currentPeer.connect(u.id, { reliable: true });
              setupDataConnection(c);
            }
          });
        }
        if (Array.isArray(pkt.streams)) {
          handleActiveStreamsList(pkt.streams, currentPeer.id);
        }
      } else if (pkt.type === 'start-stream') {
        if (isHostRef.current) {
          activeStreamsMapRef.current.set(pkt.meta.streamId, pkt.meta);
          syncRoomStateFromHost();
        }
        handleStreamStarted(pkt.meta, currentPeer.id);
      } else if (pkt.type === 'stop-stream') {
        if (isHostRef.current) {
          activeStreamsMapRef.current.delete(pkt.streamId);
          syncRoomStateFromHost();
        }
        stoppedWatchingSetRef.current.delete(pkt.streamId);
        clipManagersRef.current[pkt.streamId]?.destroy?.();
        delete clipManagersRef.current[pkt.streamId];
        setStreams(prev => prev.filter(s => s.id !== pkt.streamId));
      } else if (pkt.type === 'chat-message') {
        setMessages(prev => prev.some(m => m.id === pkt.msg.id) ? prev : [...prev, pkt.msg]);
        if (isHostRef.current) broadcastPacket(pkt, fromPeerId);
      } else if (pkt.type === 'request-keyframe') {
        Object.values(activeEncodersRef.current).forEach(enc => enc.forceKey?.());
        if (isHostRef.current) broadcastPacket(pkt, fromPeerId);
      } else if (pkt.type === 'v-chunk') {
        if (isHostRef.current) broadcastPacket(pkt, fromPeerId);
        if (!stoppedWatchingSetRef.current.has(pkt.meta.id)) {
          const handler = videoChunkHandlersRef.current[pkt.meta.id];
          if (handler) handler(pkt.meta, pkt.buffer);
        }
      } else if (pkt.type === 'a-chunk') {
        if (isHostRef.current) broadcastPacket(pkt, fromPeerId);
        if (!stoppedWatchingSetRef.current.has(pkt.meta.id)) {
          const handler = audioChunkHandlersRef.current[pkt.meta.id];
          if (handler) handler(pkt.meta, pkt.buffer);
        }
      }
    };

    const setupDataConnection = (conn) => {
      if (!conn) return;
      conn.on('open', () => {
        dataConnsRef.current.set(conn.peer, conn);
        if (!isHostRef.current && conn.peer === hostPeerId) {
          conn.send({ type: 'join-request', nick: nickname });
        }
        // Se estamos transmitindo tela, liga chamada WebRTC de vídeo direto para este par
        localStreamsRef.current.forEach(ls => {
          try {
            currentPeer.call(conn.peer, ls.stream, {
              metadata: {
                streamId: ls.id,
                senderId: currentPeer.id,
                owner: nickname,
                type: ls.type,
                res: ls.res,
                fps: ls.fps
              }
            });
          } catch (e) {}
        });
      });

      conn.on('data', (data) => handleIncomingPacket(data, conn.peer));

      const handleDisconnect = () => {
        dataConnsRef.current.delete(conn.peer);
        if (isHostRef.current) {
          roomUsersMapRef.current.delete(conn.peer);
          for (const [sId, sMeta] of activeStreamsMapRef.current.entries()) {
            if (sMeta.senderId === conn.peer) {
              activeStreamsMapRef.current.delete(sId);
              broadcastPacket({ type: 'stop-stream', streamId: sId });
              setStreams(prev => prev.filter(s => s.id !== sId));
            }
          }
          syncRoomStateFromHost();
        }
      };

      conn.on('close', handleDisconnect);
      conn.on('error', handleDisconnect);
    };

    const bindPeerEvents = (peer, asHost) => {
      currentPeer = peer;
      peerRef.current = peer;
      isHostRef.current = asHost;

      peer.on('open', (id) => {
        if (destroyed) return;
        setMyPeerId(id);
        if (asHost) {
          roomUsersMapRef.current.set(id, { id, nick: nickname });
          setParticipants([{ id, nick: nickname }]);
        } else {
          // Conecta ao Host da sala
          const hostConn = peer.connect(hostPeerId, { reliable: true });
          setupDataConnection(hostConn);
        }
      });

      peer.on('connection', (conn) => {
        setupDataConnection(conn);
      });

      peer.on('call', (call) => {
        call.answer();
        call.on('stream', (remoteMediaStream) => {
          const meta = call.metadata || {};
          if (!meta.streamId) return;
          setStreams(prev => {
            const exists = prev.find(s => s.id === meta.streamId);
            if (exists) {
              return prev.map(s => s.id === meta.streamId ? { ...s, p2pStream: remoteMediaStream } : s);
            }
            const isStopped = stoppedWatchingSetRef.current.has(meta.streamId);
            return [
              ...prev,
              {
                id: meta.streamId,
                senderId: meta.senderId,
                owner: meta.owner || 'Participante',
                type: meta.type || 'Tela',
                res: meta.res || '1080p',
                fps: meta.fps || 60,
                p2pStream: remoteMediaStream,
                volume: 75,
                muted: false,
                minimized: false,
                watching: !isStopped,
                watchSession: 1,
                isLocal: false
              }
            ];
          });
        });
      });

      peer.on('error', (err) => {
        // Se o ID de Host já estiver ocupado na sala, entra automaticamente como Cliente conectado ao Host!
        if (asHost && err.type === 'unavailable-id') {
          try { peer.destroy(); } catch (e) {}
          const clientPeer = new window.Peer(undefined, { config: { iceServers: ICE_SERVERS } });
          bindPeerEvents(clientPeer, false);
        }
      });
    };

    // Tenta iniciar como Host da sala; se já houver alguém na sala, entra como Cliente
    const initialPeer = new window.Peer(hostPeerId, { config: { iceServers: ICE_SERVERS } });
    bindPeerEvents(initialPeer, true);

    return () => {
      destroyed = true;
      Object.values(activeEncodersRef.current).forEach(e => e.stop?.());
      Object.values(clipManagersRef.current).forEach(m => m.destroy?.());
      dataConnsRef.current.clear();
      roomUsersMapRef.current.clear();
      activeStreamsMapRef.current.clear();
      try { if (currentPeer) currentPeer.destroy(); } catch (e) {}
    };
  }, [inRoom, roomName, roomPassword, nickname]);

  const handleActiveStreamsList = (list, selfId) => {
    setStreams(prev => {
      const localOnes = prev.filter(s => s.isLocal);
      const updatedRemotes = [];

      list.forEach(st => {
        if (st.senderId === selfId) return;
        const existing = prev.find(p => p.id === st.streamId);
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

  const handleStreamStarted = (st, selfId) => {
    if (st.senderId === selfId) return;
    stoppedWatchingSetRef.current.delete(st.streamId);

    setStreams(prev => {
      const exists = prev.find(s => s.id === st.streamId);
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
    broadcastPacket({ type: 'request-keyframe', streamId: st.streamId });
  };

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
      broadcastPacket({ type: 'request-keyframe', streamId });
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

  // Envia também via WebCodecs pelo DataChannel P2P para garantir imagem mesmo se a chamada de mídia WebRTC sofrer bloqueio
  const startWebCodecsSender = async (streamId, mediaStream, isCamera = false) => {
    const vTrack = mediaStream.getVideoTracks()[0];
    if (!vTrack || !('VideoEncoder' in window)) return;

    let running = true;
    let forceKey = true;
    let frameCount = 0;
    let currentCodecStr = 'vp8';
    let targetW = RES_CONFIG[qualityRef.current]?.width || 1920;
    let targetH = RES_CONFIG[qualityRef.current]?.height || 1080;

    const videoEncoder = new VideoEncoder({
      output: (chunk) => {
        if (!running) return;
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);

        broadcastPacket({
          type: 'v-chunk',
          meta: {
            id: streamId,
            senderId: peerRef.current?.id,
            owner: nickname,
            c: currentCodecStr,
            t: chunk.type,
            ts: chunk.timestamp,
            w: targetW,
            h: targetH,
            fps: fpsRef.current
          },
          buffer: buf.buffer
        });
      },
      error: () => {}
    });

    const configureEncoderNow = async (rawW, rawH) => {
      const cfg = RES_CONFIG[qualityRef.current] || RES_CONFIG['1080p'];
      const targetFps = Number(fpsRef.current) || 60;
      const ratio = rawW && rawH ? rawW / rawH : 16 / 9;
      targetH = Math.min(cfg.height, rawH || cfg.height);
      targetW = Math.round(targetH * ratio);

      const bestCfg = await findSupportedVideoConfig(targetW, targetH, targetFps, cfg.bitrate, codecRef.current);
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
    const aTrack = mediaStream.getAudioTracks()[0];
    if (!isCamera && aTrack && 'AudioEncoder' in window && 'MediaStreamTrackProcessor' in window) {
      try {
        audioEncoder = new AudioEncoder({
          output: (chunk) => {
            if (!running) return;
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            broadcastPacket({
              type: 'a-chunk',
              meta: {
                id: streamId,
                ts: chunk.timestamp,
                sr: 48000,
                ch: 2,
                gain: outgoingVolumeRef.current
              },
              buffer: buf.buffer
            });
          },
          error: () => {}
        });
        audioEncoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 96000 });
        const aProc = new MediaStreamTrackProcessor({ track: aTrack });
        const aReader = aProc.readable.getReader();
        (async () => {
          while (running) {
            const { value: aData, done } = await aReader.read();
            if (done || !aData) break;
            if (audioEncoder.state === 'configured') audioEncoder.encode(aData);
            aData.close();
          }
        })().catch(() => {});
      } catch (e) {}
    }

    if ('MediaStreamTrackProcessor' in window) {
      const processor = new MediaStreamTrackProcessor({ track: vTrack });
      const reader = processor.readable.getReader();

      (async () => {
        let lastFrameTime = 0;
        let droppedFrame = false;
        while (running) {
          const { value: frame, done } = await reader.read();
          if (done || !frame) break;

          const now = performance.now();
          const minInterval = 1000 / (Number(fpsRef.current) + 2);

          if (now - lastFrameTime < minInterval) {
            frame.close();
            continue;
          }
          if (videoEncoder.encodeQueueSize > 2) {
            droppedFrame = true;
            frame.close();
            continue;
          }
          lastFrameTime = now;

          try {
            if (videoEncoder.state === 'configured') {
              const isKey = forceKey || droppedFrame || (frameCount % 60 === 0);
              forceKey = false;
              droppedFrame = false;
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
      forceKey: () => { forceKey = true; },
      reconfigure: () => {
        const st = vTrack.getSettings ? vTrack.getSettings() : {};
        configureEncoderNow(st.width || 1920, st.height || 1080);
      },
      stop: () => {
        running = false;
        try { if (videoEncoder.state !== 'closed') videoEncoder.close(); } catch (e) {}
        try { if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close(); } catch (e) {}
      }
    };
  };

  const handleShareScreen = async () => {
    try {
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
      vTrack.onended = () => stopStream(newId);

      const selfId = peerRef.current?.id || 'local';
      const newStreamObj = {
        id: newId,
        senderId: selfId,
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

      localStreamsRef.current.push(newStreamObj);
      setStreams(prev => [...prev, newStreamObj]);

      const streamMeta = {
        streamId: newId,
        senderId: selfId,
        owner: nickname,
        type: newStreamObj.type,
        res: cfg.label,
        fps: targetFps
      };

      if (isHostRef.current) {
        activeStreamsMapRef.current.set(newId, streamMeta);
        syncRoomStateFromHost();
      }
      broadcastPacket({ type: 'start-stream', meta: streamMeta });

      // Liga chamada WebRTC de vídeo direto para todos os participantes na sala
      if (peerRef.current) {
        dataConnsRef.current.forEach((_, pid) => {
          try {
            peerRef.current.call(pid, mediaStream, { metadata: streamMeta });
          } catch (e) {}
        });
      }

      await startWebCodecsSender(newId, mediaStream, false);
    } catch (err) {}
  };

  const handleShareCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: Number(fps) } },
        audio: false
      });
      const newId = 'cam_' + Math.random().toString(36).substring(2, 9);
      const vTrack = mediaStream.getVideoTracks()[0];
      vTrack.onended = () => stopStream(newId);

      const selfId = peerRef.current?.id || 'local';
      const newStreamObj = {
        id: newId,
        senderId: selfId,
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

      localStreamsRef.current.push(newStreamObj);
      setStreams(prev => [...prev, newStreamObj]);

      const streamMeta = {
        streamId: newId,
        senderId: selfId,
        owner: nickname,
        type: 'Câmera',
        res: '720p',
        fps: Number(fps)
      };

      if (isHostRef.current) {
        activeStreamsMapRef.current.set(newId, streamMeta);
        syncRoomStateFromHost();
      }
      broadcastPacket({ type: 'start-stream', meta: streamMeta });

      if (peerRef.current) {
        dataConnsRef.current.forEach((_, pid) => {
          try {
            peerRef.current.call(pid, mediaStream, { metadata: streamMeta });
          } catch (e) {}
        });
      }

      await startWebCodecsSender(newId, mediaStream, true);
    } catch (err) {
      alert('Não foi possível acessar a webcam.');
    }
  };

  const stopStream = (streamId) => {
    activeEncodersRef.current[streamId]?.stop?.();
    delete activeEncodersRef.current[streamId];
    clipManagersRef.current[streamId]?.destroy?.();
    delete clipManagersRef.current[streamId];
    localStreamsRef.current = localStreamsRef.current.filter(s => s.id !== streamId);

    setStreams(prev => {
      const target = prev.find(s => s.id === streamId);
      if (target?.stream) target.stream.getTracks().forEach(t => t.stop());
      return prev.filter(s => s.id !== streamId);
    });

    if (isHostRef.current) {
      activeStreamsMapRef.current.delete(streamId);
      syncRoomStateFromHost();
    }
    broadcastPacket({ type: 'stop-stream', streamId });
    if (expandedId === streamId) setExpandedId(null);
  };

  const handleReplayOrClip = async (targetStreamId, openModal = true) => {
    const targetStream = streams.find(s => s.id === targetStreamId) || streams.find(s => s.watching !== false);
    if (!targetStream) {
      alert('Nenhuma transmissão ativa para gerar o replay de 30 segundos.');
      return;
    }

    const manager = clipManagersRef.current[targetStream.id];
    if (!manager) {
      alert('Aguarde pelo menos 2 segundos assistindo à transmissão para capturar o replay.');
      return;
    }

    const res = await manager.captureLast30s();
    if (!res || !res.url) {
      alert('Acumulando frames da transmissão... tente novamente em 2 segundos!');
      return;
    }

    if (openModal) {
      if (replayModal?.url) URL.revokeObjectURL(replayModal.url);
      setReplayModal({
        streamId: targetStream.id,
        owner: targetStream.owner,
        url: res.url,
        mimeType: res.mimeType,
        durationSec: res.durationSec
      });
    } else {
      const ext = res.mimeType.includes('mp4') ? 'mp4' : 'webm';
      const a = document.createElement('a');
      a.href = res.url;
      a.download = `VogelsTV_Clip_${targetStream.owner}_${Date.now()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  // Gera e baixa o Launcher Desktop Windows (.cmd) que NÃO sofre bloqueio de vírus no Chrome nem no Windows Defender
  const downloadSafeDesktopApp = () => {
    const { cleanRoom, cleanPass } = parseRoomInput(roomName, roomPassword);
    const targetUrl = `${window.location.origin}/?desktop=1&sala=${encodeURIComponent(cleanRoom)}${cleanPass ? `&senha=${encodeURIComponent(cleanPass)}` : ''}`;

    const launcherScript = [
      '@echo off',
      'chcp 65001 >nul',
      'title VogelsTV Desktop',
      'set "APP_URL=' + targetUrl + '"',
      'set "PROFILE_DIR=%LOCALAPPDATA%\\VogelsTV\\AppProfile"',
      'if not exist "%PROFILE_DIR%" mkdir "%PROFILE_DIR%"',
      '',
      'set "BROWSER="',
      'if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
      'if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
      'if exist "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" set "BROWSER=%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"',
      'if "%BROWSER%"=="" if exist "%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
      'if "%BROWSER%"=="" if exist "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" set "BROWSER=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
      '',
      'if not "%BROWSER%"=="" (',
      '  start "" "%BROWSER%" --app="%APP_URL%" --user-data-dir="%PROFILE_DIR%" --enable-features=ApplicationAudioCaptureWin,AudioServiceOutOfProcess --autoplay-policy=no-user-gesture-required',
      ') else (',
      '  start "" "%APP_URL%"',
      ')',
      'exit'
    ].join('\r\n');

    const blob = new Blob([launcherScript], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'VogelsTV-Desktop.cmd';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const sendChat = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    const msgPayload = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender: nickname,
      text: chatInput.trim().slice(0, 500),
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };
    setMessages(prev => [...prev, msgPayload]);
    broadcastPacket({ type: 'chat-message', msg: msgPayload });
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
            <VogelsLogo size="text-2xl" />
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
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-red-500"
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
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-red-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Senha da sala (opcional)</label>
              <input
                type="text"
                value={roomPassword}
                onChange={e => setRoomPassword(e.target.value)}
                placeholder="Deixe vazio se a sala não tiver senha"
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-red-500"
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
    <div className="h-screen w-screen bg-[#0D0F13] text-[#E2E8F0] flex flex-col select-none overflow-hidden">
      <header className="h-12 bg-[#12151C] border-b border-[#1E232E] px-3 flex items-center justify-between gap-2 shrink-0 z-20">
        <div className="flex items-center gap-2">
          <VogelsLogo size="text-base" />
          <span className="text-amber-400 text-xs">🔒</span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[11px] text-gray-200 px-2 py-0.5 rounded-full font-mono">
            {cleanRoom}
          </span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[11px] text-emerald-400 px-2 py-0.5 rounded-full font-medium">
            {Math.max(1, participants.length)} online
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <select value={quality} onChange={e => setQuality(e.target.value)} className="bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            <option value="720p">Qualidade: 720p (HD)</option>
            <option value="1080p">Qualidade: 1080p (Full HD)</option>
            <option value="1440p">Qualidade: 2K (1440p)</option>
          </select>

          <select value={sharpness} onChange={e => setSharpness(e.target.value)} className="bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            <option value="motion">Fluidez Máxima (Jogos / Vídeo)</option>
            <option value="detail">Nitidez (Texto / Código)</option>
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
              onClick={() => handleReplayOrClip(watchingStreams[0].id, true)}
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
                    <span className="text-xs font-semibold text-white">Remover sons do Discord na live</span>
                    <input
                      type="checkbox"
                      checked={excludeDiscordAudio}
                      onChange={e => setExcludeDiscordAudio(e.target.checked)}
                      className="w-4 h-4 accent-red-500 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1 leading-snug">
                    Ativado por padrão: isola o áudio da janela/jogo sem transmitir a voz do Discord para quem assiste.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Codec de Hardware (WebCodecs GPU)</label>
                  <select value={codec} onChange={e => setCodec(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="VP8">VP8 Ultra-Rápido (Recomendado · 60 FPS)</option>
                    <option value="H264">H.264 NVENC / Hardware</option>
                    <option value="VP9">VP9 Alta Definição (2K)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Clipes e replay (30s sem áudio)</label>
                  <select value={clipConfig} onChange={e => setClipConfig(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="720p">Ligado · 720p</option>
                    <option value="1080p">Ligado · 1080p</option>
                    <option value="off">Desligado</option>
                  </select>
                </div>
              </div>
            )}
          </div>

          <button
            onClick={downloadSafeDesktopApp}
            className="bg-[#2B82F6] hover:bg-[#1D6FE0] text-white font-medium text-xs rounded-md px-3 py-1.5 cursor-pointer"
            title="Baixar Launcher Desktop Oficial (Sem alerta do Chrome/Windows)"
          >
            Baixar app
          </button>

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
        <main className="flex-1 bg-[#0B0D11] relative flex flex-col p-3 overflow-hidden">
          {watchingStreams.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center space-y-3">
              {unwatchedStreams.length > 0 ? (
                <>
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
                </>
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
                .map(streamObj => (
                  <VideoTile
                    key={`${streamObj.id}_${streamObj.watchSession || 1}`}
                    streamObj={streamObj}
                    masterVolume={masterVolume}
                    onRequestKeyframe={() => broadcastPacket({ type: 'request-keyframe', streamId: streamObj.id })}
                    videoChunkHandlersRef={videoChunkHandlersRef}
                    audioChunkHandlersRef={audioChunkHandlersRef}
                    clipManagersRef={clipManagersRef}
                    clipConfig={clipConfig}
                    onStop={() => stopStream(streamObj.id)}
                    onStopWatching={() => setWatchingStream(streamObj.id, false)}
                    onMute={() => toggleStreamMute(streamObj.id)}
                    onVolumeChange={(val) => setStreamVolume(streamObj.id, val)}
                    onMinimize={() => setStreams(prev => prev.map(s => s.id === streamObj.id ? { ...s, minimized: !s.minimized } : s))}
                    onExpand={() => setExpandedId(expandedId === streamObj.id ? null : streamObj.id)}
                    isExpanded={expandedId === streamObj.id}
                    onClip={() => handleReplayOrClip(streamObj.id, false)}
                    onReplay={() => handleReplayOrClip(streamObj.id, true)}
                  />
                ))}
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
            <VogelsLogo size="text-xs" />
          </div>
        </main>

        {!sidebarCollapsed && (
          <aside className="w-72 bg-[#12151C] border-l border-[#1E232E] flex flex-col shrink-0 transition-all">
            <div className="p-3 border-b border-[#1E232E]">
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
                  const isMe = p.id === myPeerId;
                  const userStreams = streams.filter(
                    s => (s.senderId && s.senderId === p.id) || (!s.senderId && s.owner === p.nick)
                  );
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

            <div className="flex-1 flex flex-col p-3 overflow-hidden">
              <h3 className="text-[10px] font-bold tracking-wider text-gray-400 uppercase mb-2">CHAT</h3>
              <div className="flex-1 bg-[#0D1016] border border-[#1E232E] rounded-lg p-2.5 overflow-y-auto space-y-2 text-xs">
                {messages.map(m =>
                  m.system ? (
                    <p key={m.id} className="text-gray-400 italic text-[11px]">{m.text}</p>
                  ) : (
                    <div key={m.id}>
                      <span className="font-semibold text-red-400">{m.sender}: </span>
                      <span className="text-gray-200 break-words">{m.text}</span>
                    </div>
                  )
                )}
              </div>
              <form onSubmit={sendChat} className="mt-2 flex gap-1.5">
                <input
                  type="text"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  placeholder="Mensagem..."
                  className="flex-1 bg-[#0D1016] border border-[#242A38] rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-red-500"
                />
                <button type="submit" className="bg-[#1C212E] hover:bg-[#252C3D] border border-[#2E364A] text-xs text-gray-200 px-3 py-1.5 rounded-md cursor-pointer">
                  Enviar
                </button>
              </form>
            </div>
          </aside>
        )}
      </div>

      {replayModal && (
        <div className="fixed inset-0 bg-black/85 flex items-center justify-center p-4 z-50">
          <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-3xl p-4 space-y-3 shadow-2xl">
            <div className="flex items-center justify-between flex-wrap gap-2 border-b border-[#222834] pb-2.5">
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-bold text-white">
                  ⏪ Replay dos Últimos {replayModal.durationSec || 30}s — <span className="text-red-400">{replayModal.owner}</span>
                </h4>
              </div>

              <div className="flex items-center gap-2">
                {watchingStreams.length > 1 && (
                  <select
                    value={replayModal.streamId}
                    onChange={(e) => handleReplayOrClip(e.target.value, true)}
                    className="bg-[#1B202B] border border-[#2C3446] text-xs text-white rounded px-2.5 py-1 cursor-pointer"
                  >
                    {watchingStreams.map(ws => (
                      <option key={ws.id} value={ws.id}>
                        Tela de: {ws.owner} ({ws.res})
                      </option>
                    ))}
                  </select>
                )}
                <a
                  href={replayModal.url}
                  download={`VogelsTV_Replay_${replayModal.owner}_${Date.now()}.${replayModal.mimeType?.includes('mp4') ? 'mp4' : 'webm'}`}
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium px-3 py-1 rounded cursor-pointer"
                >
                  💾 Salvar Clipe
                </a>
                <button
                  onClick={() => {
                    if (replayModal?.url) URL.revokeObjectURL(replayModal.url);
                    setReplayModal(null);
                  }}
                  className="text-xs text-gray-400 hover:text-white bg-[#1C212C] px-2.5 py-1 rounded cursor-pointer"
                >
                  ✕ Fechar
                </button>
              </div>
            </div>

            <video
              key={replayModal.url}
              src={replayModal.url}
              controls
              autoPlay
              loop
              className="w-full rounded-lg bg-black max-h-[72vh]"
            />
          </div>
        </div>
      )}
    </div>
  );
}

function VideoTile({
  streamObj,
  masterVolume,
  onRequestKeyframe,
  videoChunkHandlersRef,
  audioChunkHandlersRef,
  clipManagersRef,
  clipConfig,
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
  const remoteP2PVideoRef = useRef(null);
  const remoteCanvasRef = useRef(null);
  const gainNodeRef = useRef(null);
  const [stats, setStats] = useState({ w: 0, h: 0, fps: 0, mbps: '0.0' });
  const [p2pActive, setP2pActive] = useState(false);

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

    const effectiveGain = streamObj.muted
      ? 0
      : ((streamObj.volume ?? 75) / 100) * ((masterVolume ?? 80) / 100);

    if (gainNodeRef.current) {
      gainNodeRef.current.gain.value = effectiveGain;
    }
    if (remoteP2PVideoRef.current) {
      remoteP2PVideoRef.current.muted = streamObj.muted || effectiveGain === 0;
      remoteP2PVideoRef.current.volume = Math.max(0, Math.min(1, effectiveGain));
    }
  }, [streamObj.muted, streamObj.volume, masterVolume]);

  useEffect(() => {
    if (streamObj.isLocal || !streamObj.p2pStream || !remoteP2PVideoRef.current) return;
    const el = remoteP2PVideoRef.current;
    el.srcObject = streamObj.p2pStream;
    el.muted = true;
    el.play().then(() => {
      const eff = streamObj.muted ? 0 : ((streamObj.volume ?? 75) / 100) * ((masterVolume ?? 80) / 100);
      el.muted = streamObj.muted || eff === 0;
      el.volume = Math.max(0, Math.min(1, eff));
    }).catch(() => {});

    const timer = setInterval(() => {
      if (el.videoWidth > 0 && el.readyState >= 2) {
        setP2pActive(true);
        if (clipConfig !== 'off' && !clipManagersRef.current[streamObj.id]) {
          clipManagersRef.current[streamObj.id] = createRolling30sBuffer(() => streamObj.p2pStream);
        }
      }
    }, 500);

    return () => clearInterval(timer);
  }, [streamObj.p2pStream, streamObj.isLocal]);

  useEffect(() => {
    if (!streamObj.isLocal || !localVideoRef.current || !streamObj.stream) return;
    localVideoRef.current.srcObject = streamObj.stream;
    localVideoRef.current.play().catch(() => {});

    if (clipConfig !== 'off') {
      clipManagersRef.current[streamObj.id]?.destroy?.();
      clipManagersRef.current[streamObj.id] = createRolling30sBuffer(() => streamObj.stream);
    }

    return () => {
      clipManagersRef.current[streamObj.id]?.destroy?.();
      delete clipManagersRef.current[streamObj.id];
    };
  }, [streamObj.isLocal, streamObj.stream, clipConfig]);

  useEffect(() => {
    if (streamObj.isLocal) return;

    const canvas = remoteCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });

    let decoder = null;
    let configuredCodec = null;
    let waitingForKey = true;
    let framesRendered = 0;
    let bytesCount = 0;
    let currentW = 1920;
    let currentH = 1080;

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
          onRequestKeyframe?.();
        }
      });

      const cfg = codecStr.startsWith('avc1')
        ? { codec: codecStr, avc: { format: 'annexb' }, optimizeForLatency: true }
        : { codec: codecStr, optimizeForLatency: true };

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
            onRequestKeyframe?.();
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
        onRequestKeyframe?.();
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
                if (nextPlayTime < now || nextPlayTime - now > 0.25) {
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
          if (audioDecoder.state === 'configured') {
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

    let sharedCanvasStream = null;
    if (clipConfig !== 'off' && canvas.captureStream) {
      setTimeout(() => {
        try {
          sharedCanvasStream = canvas.captureStream(30);
          if (!clipManagersRef.current[streamObj.id]) {
            clipManagersRef.current[streamObj.id] = createRolling30sBuffer(() => sharedCanvasStream);
          }
        } catch (e) {}
      }, 800);
    }

    onRequestKeyframe?.();
    const keyframeRetryTimer = setInterval(() => {
      if (waitingForKey) {
        onRequestKeyframe?.();
      }
    }, 500);

    const statTimer = setInterval(() => {
      const mbps = ((bytesCount * 8) / 1000000).toFixed(1);
      setStats({ w: currentW, h: currentH, fps: framesRendered, mbps });
      framesRendered = 0;
      bytesCount = 0;
    }, 1000);

    return () => {
      clearInterval(keyframeRetryTimer);
      clearInterval(statTimer);
      clipManagersRef.current[streamObj.id]?.destroy?.();
      delete clipManagersRef.current[streamObj.id];
      delete videoChunkHandlersRef.current[streamObj.id];
      delete audioChunkHandlersRef.current[streamObj.id];
      try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (e) {}
      try { if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close(); } catch (e) {}
      try { if (audioCtx && audioCtx.state !== 'closed') audioCtx.close(); } catch (e) {}
    };
  }, [streamObj.id, streamObj.isLocal, clipConfig]);

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
        <>
          <video
            ref={remoteP2PVideoRef}
            autoPlay
            playsInline
            className={`w-full h-full object-contain bg-black ${p2pActive ? 'block' : 'hidden'}`}
          />
          <canvas
            ref={remoteCanvasRef}
            className={`w-full h-full object-contain bg-black ${p2pActive ? 'hidden' : 'block'}`}
          />
        </>
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
            : p2pActive
            ? `· ${streamObj.res} · ${streamObj.fps} FPS · P2P Direto`
            : `· ${stats.h ? stats.h + 'p' : streamObj.res} · ${stats.fps} FPS · ${stats.mbps} Mbps`}
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