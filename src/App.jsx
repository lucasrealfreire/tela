import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const RES_CONFIG = {
  '720p': { width: 1280, height: 720, bitrate: 3500000, label: '720p' },
  '1080p': { width: 1920, height: 1080, bitrate: 6000000, label: '1080p' },
  '1440p': { width: 2560, height: 1440, bitrate: 9000000, label: '2K (1440p)' }
};

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

  const [quality, setQuality] = useState('1080p');
  const [sharpness, setSharpness] = useState('motion');
  const [fps, setFps] = useState(60);
  const [gameMode, setGameMode] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showDownloadModal, setShowDownloadModal] = useState(false);
  const [replayClipUrl, setReplayClipUrl] = useState(null);

  // Opção ATIVADA POR PADRÃO para mutar o Discord por completo ao compartilhar a tela
  const [muteDiscordOnShare, setMuteDiscordOnShare] = useState(() => {
    const saved = localStorage.getItem('tv_mute_discord');
    return saved !== null ? saved === 'true' : true;
  });
  const [desktopBridgeActive, setDesktopBridgeActive] = useState(false);
  const [discordCurrentlyMuted, setDiscordCurrentlyMuted] = useState(false);

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

  const qualityRef = useRef(quality);
  const fpsRef = useRef(fps);
  const codecRef = useRef(codec);

  const addLog = (msg) => {
    const time = new Date().toLocaleTimeString('pt-BR');
    setLogs(prev => [`[${time}] ${msg}`, ...prev.slice(0, 120)]);
  };

  // Comunica com o processo nativo Windows (TelinhaVogels.exe na porta local 19876) para mutar/desmutar o Discord.exe
  const setWindowsDiscordMute = async (shouldMute) => {
    try {
      const res = await fetch(`http://127.0.0.1:19876/discord-mute?mute=${shouldMute ? 1 : 0}`, {
        method: 'GET',
        mode: 'cors'
      });
      const data = await res.json();
      if (data && data.ok) {
        setDesktopBridgeActive(true);
        setDiscordCurrentlyMuted(Boolean(data.discordMuted));
        addLog(
          shouldMute
            ? `App Desktop: Discord.exe mutado automaticamente (${data.sessions} sessões WASAPI) para evitar duplicação de voz.`
            : `App Desktop: Áudio do Discord.exe restaurado.`
        );
      }
    } catch (e) {
      // Usuário está rodando apenas pelo navegador comum sem o executável aberto
    }
  };

  // Detecta se está rodando dentro do Executável Desktop Windows
  useEffect(() => {
    const checkBridge = async () => {
      try {
        const res = await fetch('http://127.0.0.1:19876/ping', { method: 'GET', mode: 'cors' });
        const data = await res.json();
        if (data?.ok) setDesktopBridgeActive(true);
      } catch (e) {}
    };
    checkBridge();
  }, []);

  useEffect(() => {
    localStorage.setItem('tv_mute_discord', String(muteDiscordOnShare));
    const hasLocalScreen = streams.some(s => s.isLocal && s.type !== 'Câmera');
    if (hasLocalScreen) {
      setWindowsDiscordMute(muteDiscordOnShare);
    } else if (!muteDiscordOnShare && discordCurrentlyMuted) {
      setWindowsDiscordMute(false);
    }
  }, [muteDiscordOnShare]);

  useEffect(() => {
    qualityRef.current = quality;
    fpsRef.current = fps;
    codecRef.current = codec;
    Object.values(activeEncodersRef.current).forEach(enc => enc.reconfigure?.());
  }, [quality, fps, codec]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sala')) setRoomName(params.get('sala'));
  }, []);

  useEffect(() => {
    localStorage.setItem('tv_nick', nickname);
  }, [nickname]);

  useEffect(() => {
    if (!inRoom) return;

    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      addLog(`Conectado ao servidor telinha vogels (ID: ${socket.id})`);
      socket.emit('join-room', { roomName, nickname });
    });

    socket.on('room-users', (list) => setParticipants(list));

    socket.on('active-streams', (list) => {
      list.forEach(st => {
        if (st.senderId === socket.id) return;
        setStreams(prev => prev.some(s => s.id === st.streamId) ? prev : [
          ...prev,
          {
            id: st.streamId,
            owner: st.owner,
            type: st.type,
            res: st.res,
            fps: st.fps,
            muted: false,
            minimized: false,
            isLocal: false
          }
        ]);
      });
    });

    socket.on('stream-started', (st) => {
      if (st.senderId === socket.id) return;
      addLog(`${st.owner} iniciou transmissão (${st.res} @ ${st.fps} FPS)`);
      setStreams(prev => prev.some(s => s.id === st.streamId) ? prev : [
        ...prev,
        {
          id: st.streamId,
          owner: st.owner,
          type: st.type,
          res: st.res,
          fps: st.fps,
          muted: false,
          minimized: false,
          isLocal: false
        }
      ]);
      socket.emit('request-keyframe', { streamId: st.streamId });
    });

    socket.on('force-keyframe', () => {
      Object.values(activeEncodersRef.current).forEach(enc => enc.forceKey?.());
    });

    socket.on('v-chunk', (meta, buffer) => {
      setStreams(prev => {
        if (prev.some(s => s.id === meta.id)) return prev;
        return [
          ...prev,
          {
            id: meta.id,
            owner: meta.owner || 'Participante',
            type: 'Tela',
            res: `${meta.h}p`,
            fps: meta.fps || 60,
            muted: false,
            minimized: false,
            isLocal: false
          }
        ];
      });
      const handler = videoChunkHandlersRef.current[meta.id];
      if (handler) handler(meta, buffer);
    });

    socket.on('a-chunk', (meta, buffer) => {
      const handler = audioChunkHandlersRef.current[meta.id];
      if (handler) handler(meta, buffer);
    });

    socket.on('peer-stopped-stream', ({ streamId }) => {
      setStreams(prev => prev.filter(s => s.id !== streamId));
      delete videoChunkHandlersRef.current[streamId];
      delete audioChunkHandlersRef.current[streamId];
    });

    socket.on('chat-message', (msg) => {
      setMessages(prev => [...prev, msg]);
    });

    return () => {
      Object.values(activeEncodersRef.current).forEach(e => e.stop?.());
      setWindowsDiscordMute(false);
      socket.disconnect();
    };
  }, [inRoom, roomName, nickname]);

  const startWebCodecsSender = async (streamId, mediaStream) => {
    const vTrack = mediaStream.getVideoTracks()[0];
    if (!vTrack) return;

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
    const aTrack = mediaStream.getAudioTracks()[0];
    if (aTrack && 'AudioEncoder' in window && 'MediaStreamTrackProcessor' in window) {
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
              ch: 2
            }, buf.buffer);
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
              const isKey = forceKey || (frameCount % 90 === 0);
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

      // Se a opção "Mutar Discord ao compartilhar" estiver ativa (padrão), silencia o Discord.exe no Windows imediatamente
      if (muteDiscordOnShare) {
        setWindowsDiscordMute(true);
      }

      const vTrack = mediaStream.getVideoTracks()[0];
      if (vTrack && 'contentHint' in vTrack) {
        vTrack.contentHint = 'motion';
      }

      const newId = 'stream_' + Math.random().toString(36).substring(2, 9);
      vTrack.onended = () => stopStream(newId);

      const newStreamObj = {
        id: newId,
        owner: nickname,
        type: gameMode ? 'Modo Jogo' : 'Tela',
        stream: mediaStream,
        res: cfg.label,
        fps: targetFps,
        muted: true,
        minimized: false,
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

      await startWebCodecsSender(newId, mediaStream);
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
        owner: nickname,
        type: 'Câmera',
        stream: mediaStream,
        res: '720p',
        fps: Number(fps),
        muted: true,
        minimized: false,
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

      await startWebCodecsSender(newId, mediaStream);
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
      const remaining = prev.filter(s => s.id !== streamId);

      // Se parou de compartilhar a tela, restaura o som do Discord automaticamente
      const stillSharingScreen = remaining.some(s => s.isLocal && s.type !== 'Câmera');
      if (!stillSharingScreen) {
        setWindowsDiscordMute(false);
      }
      return remaining;
    });

    socketRef.current?.emit('stop-stream', { streamId });
    if (expandedId === streamId) setExpandedId(null);
  };

  const triggerAppDownload = () => {
    setShowDownloadModal(true);
    const a = document.createElement('a');
    a.href = '/api/download-app';
    a.download = 'Telinha-Vogels-Windows.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
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
    a.download = `TelinhaVogels_Clip_${owner}_${Date.now()}.${ext}`;
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
    const url = `${window.location.origin}/?sala=${encodeURIComponent(roomName)}`;
    navigator.clipboard.writeText(url);
    alert(`Link copiado:\n${url}`);
  };

  if (!inRoom) {
    return (
      <div className="h-screen w-screen bg-[#0D0F13] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#151922] border border-[#232936] rounded-xl p-6 shadow-2xl">
          <div className="flex items-center justify-between mb-6">
            <span className="text-xl font-bold tracking-tight text-white">telinha vogels</span>
            {desktopBridgeActive && (
              <span className="text-[11px] bg-emerald-950/60 border border-emerald-700/50 text-emerald-300 px-2 py-0.5 rounded font-medium">
                App Windows Ativo
              </span>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (nickname.trim() && roomName.trim()) setInRoom(true);
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
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1.5 font-medium">Nome da sala</label>
              <input
                type="text"
                required
                value={roomName}
                onChange={e => setRoomName(e.target.value)}
                className="w-full bg-[#0D0F13] border border-[#262C3A] rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:border-indigo-500"
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

  const activeStreams = streams.filter(s => !s.minimized);
  const minimizedStreams = streams.filter(s => s.minimized);

  return (
    <div className="h-screen w-screen bg-[#0D0F13] text-[#E2E8F0] flex flex-col select-none overflow-hidden">
      <header className="h-12 bg-[#12151C] border-b border-[#1E232E] px-3 flex items-center justify-between gap-2 shrink-0 z-20">
        <div className="flex items-center gap-2">
          <span className="font-bold text-white text-sm tracking-tight">telinha vogels</span>
          <span className="text-amber-400 text-xs">🔒</span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[11px] text-gray-300 px-2 py-0.5 rounded-full">
            {participants.length} online
          </span>
          {discordCurrentlyMuted && (
            <span className="bg-indigo-950/70 border border-indigo-700/60 text-[11px] text-indigo-300 px-2 py-0.5 rounded-full">
              🔇 Discord Mutado
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
            <button onClick={() => setShowSettings(!showSettings)} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
              ⚙️
            </button>
            {showSettings && (
              <div className="absolute right-0 mt-2 w-80 bg-[#141820] border border-[#262C3A] rounded-xl shadow-2xl p-4 z-50 text-left space-y-3.5">
                <div className="flex items-center justify-between border-b border-[#222834] pb-2">
                  <span className="font-semibold text-sm text-white">Configurações</span>
                  <button onClick={() => setShowSettings(false)} className="text-gray-400 hover:text-white text-sm px-1.5 py-0.5 rounded bg-[#1C212C]">✕</button>
                </div>

                {/* Opção ativada por padrão para mutar o Discord ao compartilhar tela */}
                <div className="bg-[#1B202B] border border-[#2B3242] rounded-lg p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-white">Mutar Discord ao compartilhar</span>
                    <input
                      type="checkbox"
                      checked={muteDiscordOnShare}
                      onChange={e => setMuteDiscordOnShare(e.target.checked)}
                      className="w-4 h-4 accent-indigo-500 cursor-pointer"
                    />
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1 leading-snug">
                    Vem ativado por padrão no App Windows: silencia o aplicativo Discord por completo enquanto você compartilha a tela para evitar duplicação de vozes.
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
          >
            Baixar app
          </button>

          <button onClick={copyRoomLink} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            🔗 Link
          </button>

          <button onClick={() => window.location.reload()} className="bg-[#171B24] hover:bg-red-950/60 border border-red-800/60 text-xs text-red-300 rounded-md px-2.5 py-1.5 cursor-pointer">
            Sair
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 bg-[#0B0D11] relative flex flex-col p-3 overflow-hidden">
          {activeStreams.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center">
              <p className="text-xs text-gray-400">Ninguém está compartilhando ainda.</p>
              <p className="text-xs text-gray-400 mt-0.5">
                Clique em <button onClick={handleShareScreen} className="text-gray-200 font-semibold hover:underline cursor-pointer">Compartilhar tela</button> para começar.
              </p>
            </div>
          ) : (
            <div className={`flex-1 grid gap-3 overflow-hidden ${expandedId || activeStreams.length === 1 ? 'grid-cols-1' : 'grid-cols-1 md:grid-cols-2'}`}>
              {activeStreams
                .filter(s => !expandedId || s.id === expandedId)
                .map(streamObj => (
                  <VideoTile
                    key={streamObj.id}
                    streamObj={streamObj}
                    socketRef={socketRef}
                    videoChunkHandlersRef={videoChunkHandlersRef}
                    audioChunkHandlersRef={audioChunkHandlersRef}
                    clipRecordersRef={clipRecordersRef}
                    clipChunksRef={clipChunksRef}
                    clipConfig={clipConfig}
                    clipDuration={clipDuration}
                    onStop={() => stopStream(streamObj.id)}
                    onMute={() => setStreams(prev => prev.map(s => s.id === streamObj.id ? { ...s, muted: !s.muted } : s))}
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

          <div className="absolute bottom-1.5 left-3 text-[10px] text-gray-600 pointer-events-none">
            telinha vogels
          </div>
        </main>

        <aside className="w-72 bg-[#12151C] border-l border-[#1E232E] flex flex-col shrink-0">
          <div className="p-3 border-b border-[#1E232E]">
            <h3 className="text-[10px] font-bold tracking-wider text-gray-400 uppercase mb-2">PARTICIPANTES</h3>
            <div className="space-y-1.5">
              {participants.map(p => (
                <div key={p.id} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                    <span className="text-gray-200 font-medium">
                      {p.nick} {p.id === socketRef.current?.id && <span className="text-gray-400">(você)</span>}
                    </span>
                  </div>
                  <span className="text-[10px] text-emerald-400/80 bg-emerald-950/40 px-1.5 py-0.5 rounded">{p.conn}</span>
                </div>
              ))}
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
                    <span className="font-semibold text-indigo-400">{m.sender}: </span>
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
                className="flex-1 bg-[#0D1016] border border-[#242A38] rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-indigo-500"
              />
              <button type="submit" className="bg-[#1C212E] hover:bg-[#252C3D] border border-[#2E364A] text-xs text-gray-200 px-3 py-1.5 rounded-md cursor-pointer">
                Enviar
              </button>
            </form>
          </div>
        </aside>
      </div>

      {/* MODAL DE DOWNLOAD DO EXECUTÁVEL WINDOWS */}
      {showDownloadModal && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center p-4 z-50">
          <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-md p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#222834] pb-2.5">
              <h4 className="text-sm font-bold text-white">🖥️ Telinha Vogels — App Windows</h4>
              <button onClick={() => setShowDownloadModal(false)} className="text-xs text-gray-400 hover:text-white px-2 py-0.5 rounded bg-[#1C212C]">✕</button>
            </div>
            <div className="text-xs text-gray-300 space-y-2.5 leading-relaxed">
              <p>
                O download de <b className="text-white">Telinha-Vogels-Windows.zip</b> foi iniciado!
              </p>
              <div className="bg-[#0D1016] border border-[#1E232E] rounded-lg p-3 space-y-1.5 text-[11px]">
                <p className="text-indigo-300 font-semibold">Como abrir sem alerta do Windows:</p>
                <p>1. Extraia o arquivo <b>Telinha-Vogels-Windows.zip</b>.</p>
                <p>2. Dê dois cliques em <b>Instalar e Abrir Telinha Vogels.cmd</b>.</p>
                <p>3. Ele criará o executável nativo <b>TelinhaVogels.exe</b> e o atalho na sua Área de Trabalho com a função de <b>Mutar o Discord automaticamente</b> ao compartilhar a tela.</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <a
                href="/api/download-app"
                download="Telinha-Vogels-Windows.zip"
                className="bg-[#2B82F6] hover:bg-[#1D6FE0] text-white font-medium text-xs rounded-lg px-4 py-2"
              >
                Baixar novamente (.ZIP)
              </a>
              <button
                onClick={() => setShowDownloadModal(false)}
                className="bg-[#1C212E] hover:bg-[#252C3D] text-gray-200 text-xs rounded-lg px-4 py-2 cursor-pointer"
              >
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}

      {showLogs && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">Logs telinha vogels</h4>
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
  socketRef,
  videoChunkHandlersRef,
  audioChunkHandlersRef,
  clipRecordersRef,
  clipChunksRef,
  clipConfig,
  clipDuration,
  onStop,
  onMute,
  onMinimize,
  onExpand,
  isExpanded,
  onClip,
  onReplay
}) {
  const localVideoRef = useRef(null);
  const remoteCanvasRef = useRef(null);
  const remoteAudioRef = useRef(null);
  const [stats, setStats] = useState({ w: 0, h: 0, fps: 0, mbps: '0.0' });

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

    let audioDecoder = null;
    if ('AudioDecoder' in window && 'MediaStreamTrackGenerator' in window) {
      try {
        const trackGen = new MediaStreamTrackGenerator({ kind: 'audio' });
        const writer = trackGen.writable.getWriter();
        const remoteAudioStream = new MediaStream([trackGen]);
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = remoteAudioStream;
          remoteAudioRef.current.play().catch(() => {});
        }
        audioDecoder = new AudioDecoder({
          output: (audioData) => {
            writer.write(audioData).catch(() => {});
            audioData.close();
          },
          error: () => {}
        });
        audioDecoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });

        audioChunkHandlersRef.current[streamObj.id] = (meta, buffer) => {
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

    socketRef.current?.emit('request-keyframe', { streamId: streamObj.id });

    const statTimer = setInterval(() => {
      const mbps = ((bytesCount * 8) / 1000000).toFixed(1);
      setStats({ w: currentW, h: currentH, fps: framesRendered, mbps });
      framesRendered = 0;
      bytesCount = 0;
    }, 1000);

    return () => {
      clearInterval(statTimer);
      delete videoChunkHandlersRef.current[streamObj.id];
      delete audioChunkHandlersRef.current[streamObj.id];
      try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (e) {}
      try { if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close(); } catch (e) {}
    };
  }, [streamObj.id, streamObj.isLocal]);

  useEffect(() => {
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = streamObj.muted;
    }
  }, [streamObj.muted]);

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
        <>
          <canvas
            ref={remoteCanvasRef}
            className="w-full h-full object-contain bg-black"
          />
          <audio ref={remoteAudioRef} autoPlay muted={streamObj.muted} />
        </>
      )}

      <div className="absolute top-2.5 left-2.5 z-30 flex items-center gap-2 bg-black/80 px-2.5 py-1 rounded-md border border-white/10 text-xs">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
        <span className="font-semibold text-white">{streamObj.owner} {streamObj.isLocal && '(Você)'}</span>
        <span className="text-emerald-300 font-mono text-[11px]">
          {streamObj.isLocal
            ? `· ${streamObj.res} · ${streamObj.fps} FPS · Local`
            : `· ${stats.h ? stats.h + 'p' : streamObj.res} · ${stats.fps} FPS · ${stats.mbps} Mbps`}
        </span>
      </div>

      <div className="absolute bottom-2.5 right-2.5 z-30 flex items-center gap-1.5 bg-black/80 p-1.5 rounded-lg border border-white/10">
        <button onClick={onClip} className="bg-[#1E2433] hover:bg-indigo-600 text-white text-[11px] px-2.5 py-1 rounded cursor-pointer">🎬 Clipe 30s</button>
        <button onClick={onReplay} className="bg-[#1E2433] hover:bg-indigo-600 text-white text-[11px] px-2 py-1 rounded cursor-pointer">⏪ Replay</button>
        {!streamObj.isLocal && (
          <button onClick={onMute} className="bg-[#1E2433] hover:bg-[#2A3246] text-white text-[11px] px-2 py-1 rounded cursor-pointer">
            {streamObj.muted ? '🔇 Mutado' : '🔊 Áudio'}
          </button>
        )}
        <button onClick={onMinimize} className="bg-[#1E2433] hover:bg-[#2A3246] text-white text-[11px] px-2 py-1 rounded cursor-pointer">_ Minimizar</button>
        <button onClick={onExpand} className="bg-[#1E2433] hover:bg-[#2A3246] text-white text-[11px] px-2 py-1 rounded cursor-pointer">
          {isExpanded ? '🗗 Restaurar' : '⛶ Expandir'}
        </button>
        {streamObj.isLocal && (
          <button onClick={onStop} className="bg-red-600/80 hover:bg-red-600 text-white text-[11px] px-2.5 py-1 rounded cursor-pointer">Parar</button>
        )}
      </div>
    </div>
  );
}