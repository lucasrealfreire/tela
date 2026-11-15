import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const MASTER_RENDER_URL = 'https://telinha-platform.onrender.com';

const RES_CONFIG = {
  '720p': { width: 1280, height: 720, bitrate: 3500000, label: '720p' },
  '1080p': { width: 1920, height: 1080, bitrate: 6000000, label: '1080p' },
  '1440p': { width: 2560, height: 1440, bitrate: 9000000, label: '2K (1440p)' }
};

function VogelsLogo({ size = 'text-sm' }) {
  return (
    <span className={`font-extrabold tracking-tight select-none ${size}`}>
      <span className="text-white">Vogels</span>
      <span className="text-red-500">TV</span>
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
  return {
    cleanRoom: r.toLowerCase().replace(/\s+/g, '-').slice(0, 40) || 'squad-brasil',
    cleanPass: p.toLowerCase().slice(0, 30)
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
  const [showLogs, setShowLogs] = useState(false);
  const [replayClipUrl, setReplayClipUrl] = useState(null);

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

  const [codec, setCodec] = useState('VP8');
  const [clipConfig, setClipConfig] = useState('720p');
  const [clipDuration] = useState(30);

  const [streams, setStreams] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([
    { id: 'sys-1', system: true, text: 'Sessão criada com senha. Mande o link para a galera!' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [logs, setLogs] = useState([]);

  const socketRef = useRef(null);
  const activeEncodersRef = useRef({});
  const videoChunkHandlersRef = useRef({});
  const audioChunkHandlersRef = useRef({});
  const clipRecordersRef = useRef({});
  const clipChunksRef = useRef({});
  // Guarda quais streams o usuário clicou em "Parar de assistir" para não reabrir sozinho quando chegar pacote
  const stoppedWatchingSetRef = useRef(new Set());

  const qualityRef = useRef(quality);
  const fpsRef = useRef(fps);
  const codecRef = useRef(codec);
  const excludeDiscordRef = useRef(excludeDiscordAudio);
  const outgoingVolumeRef = useRef(outgoingVolume);

  const addLog = (msg) => {
    const time = new Date().toLocaleTimeString('pt-BR');
    setLogs(prev => [`[${time}] ${msg}`, ...prev.slice(0, 120)]);
  };

  useEffect(() => {
    const checkBridge = async () => {
      try {
        const res = await fetch('http://127.0.0.1:19876/ping', { method: 'GET', mode: 'cors' });
        const data = await res.json();
        if (data?.ok) {
          setDesktopBridgeActive(true);
        }
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

  const setStreamVolume = (streamId, newVol) => {
    const clamped = Math.max(0, Math.min(100, Number(newVol)));
    setStreams(prev =>
      prev.map(s =>
        s.id === streamId
          ? { ...s, volume: clamped, muted: clamped === 0 }
          : s
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

  // Alterna entre "Assistir" e "Parar de assistir" instantaneamente sem precisar de F5!
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
          // Incrementa watchSession para remontar o VideoDecoder do zero quando clicar em Assistir
          watchSession: (s.watchSession || 0) + 1
        };
      })
    );

    if (shouldWatch) {
      socketRef.current?.emit('request-keyframe', { streamId });
      addLog(`Assistindo transmissão [${streamId}]...`);
    } else {
      addLog(`Parou de assistir transmissão [${streamId}].`);
    }
  };

  const handlePasteRoomLink = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const { cleanRoom, cleanPass } = parseRoomInput(text, roomPassword);
      setRoomName(cleanRoom);
      if (cleanPass) setRoomPassword(cleanPass);
      addLog(`Link colado: Sala "${cleanRoom}"`);
    } catch (e) {
      alert('Cole o link diretamente no campo "Nome da sala" (Ctrl+V).');
    }
  };

  useEffect(() => {
    if (!inRoom) return;

    const { cleanRoom, cleanPass } = parseRoomInput(roomName, roomPassword);
    const targetServer = window.location.hostname.includes('onrender.com')
      ? MASTER_RENDER_URL
      : window.location.origin;

    const socket = io(targetServer, {
      transports: ['websocket', 'polling'],
      reconnection: true
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      addLog(`Conectado ao VogelsTV na sala [${cleanRoom}]`);
      socket.emit('join-room', {
        roomName: cleanRoom,
        roomPassword: cleanPass,
        nickname
      });
    });

    socket.on('room-users', (list) => setParticipants(list));

    socket.on('active-streams', (list) => {
      setStreams(prev => {
        const localOnes = prev.filter(s => s.isLocal);
        const updatedRemotes = [];

        list.forEach(st => {
          if (st.senderId === socket.id) return;
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
    });

    socket.on('stream-started', (st) => {
      if (st.senderId === socket.id) return;
      addLog(`${st.owner} iniciou transmissão (${st.res} @ ${st.fps} FPS)`);
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
      socket.emit('request-keyframe', { streamId: st.streamId });
    });

    socket.on('force-keyframe', () => {
      Object.values(activeEncodersRef.current).forEach(enc => enc.forceKey?.());
    });

    socket.on('v-chunk', (meta, buffer) => {
      // Se o stream ainda não estava registrado na lista local, registra respeitando se o usuário parou de assistir
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
      const handler = videoChunkHandlersRef.current[meta.id];
      if (handler) handler(meta, buffer);
    });

    socket.on('a-chunk', (meta, buffer) => {
      if (stoppedWatchingSetRef.current.has(meta.id)) return;
      const handler = audioChunkHandlersRef.current[meta.id];
      if (handler) handler(meta, buffer);
    });

    socket.on('peer-stopped-stream', ({ streamId }) => {
      stoppedWatchingSetRef.current.delete(streamId);
      setStreams(prev => prev.filter(s => s.id !== streamId));
      delete videoChunkHandlersRef.current[streamId];
      delete audioChunkHandlersRef.current[streamId];
    });

    socket.on('chat-message', (msg) => {
      setMessages(prev => [...prev, msg]);
    });

    return () => {
      Object.values(activeEncodersRef.current).forEach(e => e.stop?.());
      socket.disconnect();
    };
  }, [inRoom, roomName, roomPassword, nickname]);

  const startWebCodecsSender = async (streamId, mediaStream, isCamera = false) => {
    const vTrack = mediaStream.getVideoTracks()[0];
    if (!vTrack) return;

    let running = true;
    let forceKey = true;
    let frameCount = 0;
    let currentCodecStr = 'vp8';
    let targetW = RES_CONFIG[qualityRef.current]?.width || 1920;
    let targetH = RES_CONFIG[qualityRef.current]?.height || 1080;
    const abortCtrl = new AbortController();

    const videoEncoder = new VideoEncoder({
      output: (chunk) => {
        if (!running) return;
        const buf = new Uint8Array(chunk.byteLength);
        chunk.copyTo(buf);

        socketRef.current?.emit('v-chunk', {
          id: streamId,
          owner: nickname,
          c: currentCodecStr,
          t: chunk.type,
          ts: chunk.timestamp,
          w: targetW,
          h: targetH,
          fps: fpsRef.current
        }, buf.buffer);
      },
      error: (err) => addLog(`Aviso GPU Encoder: ${err.message}`)
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
        addLog(`GPU Encoder ativo: ${targetW}x${targetH} @ ${targetFps} FPS (${currentCodecStr})`);
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
            socketRef.current?.emit('a-chunk', {
              id: streamId,
              ts: chunk.timestamp,
              sr: 48000,
              ch: 2,
              gain: outgoingVolumeRef.current
            }, buf.buffer);
          },
          error: () => {}
        });
        audioEncoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });

        let usingDesktopWasapi = false;
        if (desktopBridgeActive) {
          try {
            const excludeFlag = excludeDiscordRef.current ? 1 : 0;
            const response = await fetch(`http://127.0.0.1:19876/clean-audio?exclude=${excludeFlag}`, {
              signal: abortCtrl.signal
            });
            if (response.ok && response.body) {
              usingDesktopWasapi = true;
              setDiscordIsolatedActive(excludeDiscordRef.current);
              addLog(
                excludeDiscordRef.current
                  ? 'Áudio WASAPI Ativo: Transmitindo som do PC/Jogo SEM a voz do Discord.'
                  : 'Áudio WASAPI Ativo: Transmitindo todo o som do PC.'
              );

              mediaStream.getAudioTracks().forEach(t => { t.enabled = false; t.stop(); });

              const reader = response.body.getReader();
              let leftover = new Uint8Array(0);
              const frameBytes = 960 * 4;
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

                    if (audioEncoder.state === 'configured') {
                      const ad = new AudioData({
                        format: 's16',
                        sampleRate: 48000,
                        numberOfFrames: 960,
                        numberOfChannels: 2,
                        timestamp: timestampUs,
                        data: slice
                      });
                      audioEncoder.encode(ad);
                      ad.close();
                      timestampUs += 20000;
                    }
                  }
                  leftover = combined.slice(offset);
                }
              })().catch(() => {});
            }
          } catch (e) {}
        }

        if (!usingDesktopWasapi) {
          const aTrack = mediaStream.getAudioTracks()[0];
          if (aTrack && 'MediaStreamTrackProcessor' in window) {
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
          const ws = socketRef.current?.io?.engine?.transport?.ws;
          const netBusy = ws && ws.bufferedAmount > 450000;

          if (now - lastFrameTime < minInterval || videoEncoder.encodeQueueSize > 2 || netBusy) {
            frame.close();
            continue;
          }
          lastFrameTime = now;

          try {
            if (videoEncoder.state === 'configured') {
              const isKey = forceKey || (frameCount % 60 === 0);
              forceKey = false;
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
        abortCtrl.abort();
        setDiscordIsolatedActive(false);
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
        }
      });

      const vTrack = mediaStream.getVideoTracks()[0];
      if (vTrack && 'contentHint' in vTrack) {
        vTrack.contentHint = 'motion';
      }

      const newId = 'stream_' + Math.random().toString(36).substring(2, 9);
      vTrack.onended = () => stopStream(newId);

      const newStreamObj = {
        id: newId,
        senderId: socketRef.current?.id,
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

      setStreams(prev => [...prev, newStreamObj]);
      socketRef.current?.emit('start-stream', {
        streamId: newId,
        owner: nickname,
        type: newStreamObj.type,
        res: cfg.label,
        fps: targetFps
      });

      await startWebCodecsSender(newId, mediaStream, false);
    } catch (err) {
      addLog(`Compartilhamento cancelado: ${err.message}`);
    }
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

      const newStreamObj = {
        id: newId,
        senderId: socketRef.current?.id,
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

      setStreams(prev => [...prev, newStreamObj]);
      socketRef.current?.emit('start-stream', {
        streamId: newId,
        owner: nickname,
        type: 'Câmera',
        res: '720p',
        fps: Number(fps)
      });

      await startWebCodecsSender(newId, mediaStream, true);
    } catch (err) {
      alert('Não foi possível acessar a webcam.');
    }
  };

  const stopStream = (streamId) => {
    activeEncodersRef.current[streamId]?.stop?.();
    delete activeEncodersRef.current[streamId];

    setStreams(prev => {
      const target = prev.find(s => s.id === streamId);
      if (target?.stream) target.stream.getTracks().forEach(t => t.stop());
      return prev.filter(s => s.id !== streamId);
    });

    socketRef.current?.emit('stop-stream', { streamId });
    if (expandedId === streamId) setExpandedId(null);
  };

  // Faz o download direto do executável único VogelsTV.exe (sem .zip)
  const triggerAppDownload = () => {
    const { cleanRoom, cleanPass } = parseRoomInput(roomName, roomPassword);
    const dlUrl = `/api/download-app?sala=${encodeURIComponent(cleanRoom)}${cleanPass ? `&senha=${encodeURIComponent(cleanPass)}` : ''}`;
    const a = document.createElement('a');
    a.href = dlUrl;
    a.download = 'VogelsTV.exe';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    addLog('Download do executável VogelsTV.exe iniciado.');
  };

  const saveClip30s = (streamId, owner, openReplay = false) => {
    const chunks = clipChunksRef.current[streamId] || [];
    if (!chunks.length) {
      alert('Aguarde alguns segundos assistindo para acumular o buffer de 30s.');
      return;
    }
    const mime = clipRecordersRef.current[streamId]?.mimeType || 'video/webm';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks.map(c => c.blob), { type: mime });
    const url = URL.createObjectURL(blob);

    if (openReplay) {
      setReplayClipUrl(url);
      return;
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = `VogelsTV_Clip_${owner}_${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const sendChat = (e) => {
    e.preventDefault();
    if (!chatInput.trim()) return;
    socketRef.current?.emit('chat-message', { text: chatInput.trim() });
    setChatInput('');
  };

  const copyRoomLink = () => {
    const { cleanRoom, cleanPass } = parseRoomInput(roomName, roomPassword);
    const base = window.location.hostname.includes('onrender.com') ? MASTER_RENDER_URL : window.location.origin;
    const url = `${base}/?sala=${encodeURIComponent(cleanRoom)}${cleanPass ? `&senha=${encodeURIComponent(cleanPass)}` : ''}`;
    navigator.clipboard.writeText(url);
    alert(`Link da sala copiado:\n${url}`);
  };

  if (!inRoom) {
    return (
      <div className="h-screen w-screen bg-[#0D0F13] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#151922] border border-[#232936] rounded-xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <VogelsLogo size="text-2xl" />
            {desktopBridgeActive && (
              <span className="text-[11px] bg-emerald-950/60 border border-emerald-700/50 text-emerald-300 px-2 py-0.5 rounded font-medium">
                App Windows Ativo
              </span>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const { cleanRoom, cleanPass } = parseRoomInput(roomName, roomPassword);
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
  const { cleanRoom } = parseRoomInput(roomName, roomPassword);

  return (
    <div className="h-screen w-screen bg-[#0D0F13] text-[#E2E8F0] flex flex-col select-none overflow-hidden">
      <header className="h-12 bg-[#12151C] border-b border-[#1E232E] px-3 flex items-center justify-between gap-2 shrink-0 z-20">
        <div className="flex items-center gap-2">
          <VogelsLogo size="text-base" />
          <span className="text-amber-400 text-xs">🔒</span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[11px] text-gray-200 px-2 py-0.5 rounded-full font-mono">
            {cleanRoom}
          </span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[11px] text-gray-300 px-2 py-0.5 rounded-full">
            {participants.length} online
          </span>
          {discordIsolatedActive && (
            <span className="bg-emerald-950/70 border border-emerald-700/60 text-[11px] text-emerald-300 px-2 py-0.5 rounded-full">
              🛡️ Voz do Discord Isolada
            </span>
          )}
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
                    Ativado por padrão: você continua ouvindo seus amigos no Discord normalmente, mas a voz deles não sai na sua transmissão.
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

          <button onClick={() => setShowLogs(!showLogs)} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            📋 Logs
          </button>

          <button
            onClick={triggerAppDownload}
            className="bg-[#2B82F6] hover:bg-[#1D6FE0] text-white font-medium text-xs rounded-md px-3 py-1.5 cursor-pointer"
            title="Baixar executável VogelsTV.exe direto"
          >
            Baixar app
          </button>

          <button onClick={copyRoomLink} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            🔗 Link
          </button>

          <button onClick={() => setInRoom(false)} className="bg-[#171B24] hover:bg-red-950/60 border border-red-800/60 text-xs text-red-300 rounded-md px-2.5 py-1.5 cursor-pointer">
            Sair
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
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
                    socketRef={socketRef}
                    videoChunkHandlersRef={videoChunkHandlersRef}
                    audioChunkHandlersRef={audioChunkHandlersRef}
                    clipRecordersRef={clipRecordersRef}
                    clipChunksRef={clipChunksRef}
                    clipConfig={clipConfig}
                    clipDuration={clipDuration}
                    onStop={() => stopStream(streamObj.id)}
                    onStopWatching={() => setWatchingStream(streamObj.id, false)}
                    onMute={() => toggleStreamMute(streamObj.id)}
                    onVolumeChange={(val) => setStreamVolume(streamObj.id, val)}
                    onMinimize={() => setStreams(prev => prev.map(s => s.id === streamObj.id ? { ...s, minimized: !s.minimized } : s))}
                    onExpand={() => setExpandedId(expandedId === streamObj.id ? null : streamObj.id)}
                    isExpanded={expandedId === streamObj.id}
                    onClip={() => saveClip30s(streamObj.id, streamObj.owner, false)}
                    onReplay={() => saveClip30s(streamObj.id, streamObj.owner, true)}
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

        <aside className="w-72 bg-[#12151C] border-l border-[#1E232E] flex flex-col shrink-0">
          <div className="p-3 border-b border-[#1E232E]">
            <h3 className="text-[10px] font-bold tracking-wider text-gray-400 uppercase mb-2">PARTICIPANTES</h3>
            <div className="space-y-1.5">
              {participants.map(p => {
                const isMe = p.id === socketRef.current?.id;
                const userStreams = streams.filter(
                  s => (s.senderId && s.senderId === p.id) || (!s.senderId && s.owner === p.nick)
                );
                const hasActiveStream = userStreams.length > 0;
                const isCurrentlyWatching = userStreams.some(s => s.watching !== false);

                return (
                  <div key={p.id} className="flex items-center justify-between text-xs gap-1">
                    <div className="flex items-center gap-2 truncate">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${hasActiveStream ? 'bg-red-500 animate-pulse' : 'bg-emerald-400'}`}></span>
                      <span className="text-gray-200 font-medium truncate">
                        {p.nick} {isMe && <span className="text-gray-400">(você)</span>}
                      </span>
                    </div>

                    {/* No local onde ficava GPU Stream: botão Assistir / Parar de assistir */}
                    {isMe ? (
                      hasActiveStream ? (
                        <button
                          onClick={() => userStreams.forEach(s => stopStream(s.id))}
                          className="text-[10px] bg-red-950/70 hover:bg-red-900 border border-red-700/60 text-red-200 px-2 py-0.5 rounded cursor-pointer shrink-0 transition"
                        >
                          Parar live
                        </button>
                      ) : (
                        <span className="text-[10px] text-gray-500 bg-[#181C26] px-2 py-0.5 rounded shrink-0">
                          Online
                        </span>
                      )
                    ) : hasActiveStream ? (
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
                    ) : (
                      <button
                        onClick={() => socketRef.current?.emit('request-active-streams')}
                        className="text-[10px] text-gray-400 hover:text-white bg-[#181C26] hover:bg-[#222836] border border-[#262C3A] px-2 py-0.5 rounded cursor-pointer shrink-0 transition"
                        title="Verificar ou assistir transmissão deste participante"
                      >
                        Assistir
                      </button>
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
      </div>

      {showLogs && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold flex items-center gap-1.5">Logs <VogelsLogo size="text-sm" /></h4>
              <button onClick={() => setShowLogs(false)} className="text-xs text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="bg-[#0B0D11] border border-[#1E232E] rounded-lg p-3 h-64 overflow-y-auto font-mono text-[11px] text-emerald-400 space-y-1">
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>
        </div>
      )}

      {replayClipUrl && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center p-4 z-50">
          <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-2xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">⏪ Replay Instantâneo (Últimos 30s — Sem Áudio)</h4>
              <button onClick={() => setReplayClipUrl(null)} className="text-xs text-gray-400 hover:text-white">✕</button>
            </div>
            <video src={replayClipUrl} controls autoPlay className="w-full rounded-lg bg-black max-h-[70vh]" />
          </div>
        </div>
      )}
    </div>
  );
}

function VideoTile({
  streamObj,
  masterVolume,
  socketRef,
  videoChunkHandlersRef,
  audioChunkHandlersRef,
  clipRecordersRef,
  clipChunksRef,
  clipConfig,
  clipDuration,
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
  const [stats, setStats] = useState({ w: 0, h: 0, fps: 0, mbps: '0.0' });

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

    const vTrack = streamObj.stream.getVideoTracks()[0];
    if (vTrack && clipConfig !== 'off') {
      try {
        const videoOnly = new MediaStream([vTrack]);
        const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1') ? 'video/mp4;codecs=avc1' : 'video/webm';
        const rec = new MediaRecorder(videoOnly, { mimeType, videoBitsPerSecond: 4000000 });
        clipChunksRef.current[streamObj.id] = [];
        rec.ondataavailable = (e) => {
          if (e.data?.size > 0) {
            const list = clipChunksRef.current[streamObj.id] || [];
            list.push({ blob: e.data, ts: Date.now() });
            const cutoff = Date.now() - clipDuration * 1000;
            clipChunksRef.current[streamObj.id] = list.length > 2 ? [list[0], ...list.slice(1).filter(i => i.ts >= cutoff)] : list;
          }
        };
        rec.start(1000);
        clipRecordersRef.current[streamObj.id] = { recorder: rec, mimeType };
      } catch (e) {}
    }
  }, [streamObj.isLocal, streamObj.stream]);

  useEffect(() => {
    if (streamObj.isLocal) return;

    const canvas = remoteCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

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
          socketRef.current?.emit('request-keyframe', { streamId: streamObj.id });
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
            socketRef.current?.emit('request-keyframe', { streamId: streamObj.id });
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
        socketRef.current?.emit('request-keyframe', { streamId: streamObj.id });
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

    if (clipConfig !== 'off' && canvas.captureStream) {
      setTimeout(() => {
        try {
          const canvasStream = canvas.captureStream(30);
          const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1') ? 'video/mp4;codecs=avc1' : 'video/webm';
          const rec = new MediaRecorder(canvasStream, { mimeType, videoBitsPerSecond: 4000000 });
          clipChunksRef.current[streamObj.id] = [];
          rec.ondataavailable = (e) => {
            if (e.data?.size > 0) {
              const list = clipChunksRef.current[streamObj.id] || [];
              list.push({ blob: e.data, ts: Date.now() });
              const cutoff = Date.now() - clipDuration * 1000;
              clipChunksRef.current[streamObj.id] = list.length > 2 ? [list[0], ...list.slice(1).filter(i => i.ts >= cutoff)] : list;
            }
          };
          rec.start(1000);
          clipRecordersRef.current[streamObj.id] = { recorder: rec, mimeType };
        } catch (e) {}
      }, 1500);
    }

    // Pede keyframe imediatamente e repete a cada 400ms enquanto aguarda o 1º quadro (garante reabertura sem F5!)
    socketRef.current?.emit('request-keyframe', { streamId: streamObj.id });
    const keyframeRetryTimer = setInterval(() => {
      if (waitingForKey) {
        socketRef.current?.emit('request-keyframe', { streamId: streamObj.id });
      }
    }, 400);

    const statTimer = setInterval(() => {
      const mbps = ((bytesCount * 8) / 1000000).toFixed(1);
      setStats({ w: currentW, h: currentH, fps: framesRendered, mbps });
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
    <div className="relative bg-[#12151C] border border-[#222836] rounded-xl overflow-hidden flex items-center justify-center group">
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

      <div className="absolute top-2.5 left-2.5 z-30 flex items-center gap-2 bg-black/80 px-2.5 py-1 rounded-md border border-white/10 text-xs">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
        <span className="font-semibold text-white">{streamObj.owner} {streamObj.isLocal && '(Você)'}</span>
        <span className="text-emerald-300 font-mono text-[11px]">
          {streamObj.isLocal
            ? `· ${streamObj.res} · ${streamObj.fps} FPS · Local`
            : `· ${stats.h ? stats.h + 'p' : streamObj.res} · ${stats.fps} FPS · ${stats.mbps} Mbps`}
        </span>
      </div>

      <div className="absolute bottom-2.5 right-2.5 z-30 flex items-center gap-2 bg-black/85 px-2.5 py-1.5 rounded-lg border border-white/10">
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