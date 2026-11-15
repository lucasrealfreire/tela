import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp'
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];

export default function App() {
  const [inRoom, setInRoom] = useState(false);
  const [nickname, setNickname] = useState('gosadinhas');
  const [roomName, setRoomName] = useState('squad-brasil');

  // Controles da Barra Superior (Imagem 1)
  const [quality, setQuality] = useState('auto');
  const [sharpness, setSharpness] = useState('detail');
  const [fps, setFps] = useState(30);
  const [gameMode, setGameMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showIpv6Modal, setShowIpv6Modal] = useState(false);
  const [replayClipUrl, setReplayClipUrl] = useState(null);

  // Configurações Persistentes (Imagem 2)
  const [smoothness, setSmoothness] = useState(() => localStorage.getItem('tl_smooth') || 'smooth');
  const [codec, setCodec] = useState(() => localStorage.getItem('tl_codec') || 'AV1');
  const [clipConfig, setClipConfig] = useState(() => localStorage.getItem('tl_clip') || '720p');
  const [clipDuration, setClipDuration] = useState(30);
  const [connPolicy, setConnPolicy] = useState(() => localStorage.getItem('tl_policy') || 'auto');
  const [removeDiscordAudio, setRemoveDiscordAudio] = useState(true);

  // Estado da Sala
  const [streams, setStreams] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([
    { id: 'sys-1', system: true, text: 'Sessão criada com senha. Mande o link para a galera!' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [logs, setLogs] = useState([]);
  const [ipv6Diag, setIpv6Diag] = useState({ running: false, hasIpv6: false, candidates: [] });

  // Referências WebRTC e Socket
  const socketRef = useRef(null);
  const pcsRef = useRef({}); // key: `${peerId}_${streamId}` -> RTCPeerConnection
  const localStreamsRef = useRef([]);
  const clipChunksRef = useRef({});
  const recordersRef = useRef({});

  const addLog = (msg) => {
    const time = new Date().toLocaleTimeString('pt-BR');
    setLogs(prev => [`[${time}] ${msg}`, ...prev.slice(0, 120)]);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sala')) setRoomName(params.get('sala'));
  }, []);

  useEffect(() => {
    localStorage.setItem('tl_smooth', smoothness);
    localStorage.setItem('tl_codec', codec);
    localStorage.setItem('tl_clip', clipConfig);
    localStorage.setItem('tl_policy', connPolicy);
  }, [smoothness, codec, clipConfig, connPolicy]);

  // Inicializa Socket.IO e Sinalização WebRTC Real
  useEffect(() => {
    if (!inRoom) return;

    const socket = io();
    socketRef.current = socket;

    socket.on('connect', () => {
      addLog(`Conectado ao servidor de sinalização (ID: ${socket.id})`);
      socket.emit('join-room', { roomName, nickname });
    });

    socket.on('room-users', (usersList) => {
      setParticipants(usersList);
    });

    socket.on('user-joined', ({ id, nick }) => {
      addLog(`${nick} entrou na sala. Sincronizando transmissões ativas...`);
      localStreamsRef.current.forEach(ls => {
        createOfferForPeer(id, ls);
      });
    });

    socket.on('webrtc-signal', async ({ senderId, signal, streamMeta }) => {
      const key = `${senderId}_${streamMeta.streamId}`;

      if (signal.type === 'offer') {
        const pc = createPeerConnection(senderId, streamMeta);
        pcsRef.current[key] = pc;
        await pc.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('webrtc-signal', {
          targetId: senderId,
          signal: pc.localDescription,
          streamMeta
        });
      } else if (signal.type === 'answer') {
        const pc = pcsRef.current[key];
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
        }
      } else if (signal.candidate) {
        const pc = pcsRef.current[key];
        if (pc) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } catch (e) {
            addLog(`Erro ICE Candidate: ${e.message}`);
          }
        }
      }
    });

    socket.on('peer-stopped-stream', ({ senderId, streamId }) => {
      const key = `${senderId}_${streamId}`;
      if (pcsRef.current[key]) {
        pcsRef.current[key].close();
        delete pcsRef.current[key];
      }
      setStreams(prev => prev.filter(s => s.id !== streamId));
      addLog(`Transmissão [${streamId}] encerrada pelo participante.`);
    });

    socket.on('user-left', ({ id }) => {
      Object.keys(pcsRef.current).forEach(k => {
        if (k.startsWith(id)) {
          pcsRef.current[k].close();
          delete pcsRef.current[k];
        }
      });
      setStreams(prev => prev.filter(s => s.peerId !== id));
    });

    socket.on('chat-message', (msg) => {
      setMessages(prev => [...prev, msg]);
    });

    return () => {
      localStreamsRef.current.forEach(s => s.stream.getTracks().forEach(t => t.stop()));
      Object.values(pcsRef.current).forEach(pc => pc.close());
      socket.disconnect();
    };
  }, [inRoom, roomName, nickname]);

  const applyCodecPreference = (pc) => {
    try {
      if (!RTCRtpSender.getCapabilities) return;
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps || !caps.codecs) return;
      const preferred = caps.codecs.filter(c =>
        c.mimeType.toLowerCase().includes(codec.toLowerCase())
      );
      const others = caps.codecs.filter(c =>
        !c.mimeType.toLowerCase().includes(codec.toLowerCase())
      );
      if (preferred.length > 0) {
        pc.getTransceivers().forEach(t => {
          if (t.setCodecPreferences) {
            t.setCodecPreferences([...preferred, ...others]);
          }
        });
      }
    } catch (e) {
      addLog(`Codec fallback automático: ${e.message}`);
    }
  };

  const createPeerConnection = (peerId, streamMeta) => {
    const config = {
      iceServers: ICE_SERVERS,
      iceTransportPolicy: connPolicy === 'turn' ? 'relay' : 'all'
    };
    const pc = new RTCPeerConnection(config);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        if (connPolicy === 'ipv6' && !event.candidate.candidate.includes(':')) return;
        socketRef.current?.emit('webrtc-signal', {
          targetId: peerId,
          signal: { candidate: event.candidate },
          streamMeta
        });
      }
    };

    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (!remoteStream) return;

      // Ajusta jitter buffer (Suavidade para quem assiste)
      if (event.receiver && 'playoutDelayHint' in event.receiver) {
        event.receiver.playoutDelayHint = smoothness === 'smooth' ? 0.35 : smoothness === 'balanced' ? 0.12 : 0.0;
      }

      setStreams(prev => {
        if (prev.some(s => s.id === streamMeta.streamId)) return prev;
        const newObj = {
          id: streamMeta.streamId,
          peerId,
          owner: streamMeta.owner,
          type: streamMeta.type,
          stream: remoteStream,
          muted: false,
          minimized: false,
          fps: streamMeta.fps,
          res: streamMeta.res,
          bitrate: '8.0 Mbps',
          isLocal: false
        };
        startCircularClipBuffer(streamMeta.streamId, remoteStream);
        addLog(`Recebendo vídeo WebRTC de ${streamMeta.owner} (${streamMeta.res} @ ${streamMeta.fps}fps)`);
        return [...prev, newObj];
      });
    };

    pc.oniceconnectionstatechange = () => {
      addLog(`Estado ICE (${streamMeta.owner}): ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected') {
        pc.getStats().then(stats => {
          stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              socketRef.current?.emit('update-conn-type', {
                connType: connPolicy === 'turn' ? 'TURN Plano B' : 'IPv6 / P2P'
              });
            }
          });
        });
      }
    };

    return pc;
  };

  const createOfferForPeer = async (targetPeerId, localStreamObj) => {
    const streamMeta = {
      streamId: localStreamObj.id,
      owner: nickname,
      type: localStreamObj.type,
      res: localStreamObj.res,
      fps: localStreamObj.fps
    };
    const key = `${targetPeerId}_${localStreamObj.id}`;
    const pc = createPeerConnection(targetPeerId, streamMeta);
    pcsRef.current[key] = pc;

    localStreamObj.stream.getTracks().forEach(track => {
      const sender = pc.addTrack(track, localStreamObj.stream);
      if (track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 8000000; // Meta de 8.000 Kbps adaptativos
        params.encodings[0].maxFramerate = Number(localStreamObj.fps);
        sender.setParameters(params).catch(() => {});
      }
    });

    applyCodecPreference(pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socketRef.current?.emit('webrtc-signal', {
      targetId: targetPeerId,
      signal: pc.localDescription,
      streamMeta
    });
  };

  // Buffer Circular de 30s (SOMENTE VÍDEO — ZERO ÁUDIO)
  const startCircularClipBuffer = (streamId, mediaStream) => {
    if (clipConfig === 'off') return;
    try {
      const videoTracks = mediaStream.getVideoTracks();
      if (!videoTracks.length) return;
      const videoOnlyStream = new MediaStream([videoTracks[0]]);
      const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
        ? 'video/mp4;codecs=avc1'
        : MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';

      const recorder = new MediaRecorder(videoOnlyStream, {
        mimeType,
        videoBitsPerSecond: clipConfig === '1080p' ? 6000000 : 3500000
      });

      clipChunksRef.current[streamId] = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          const list = clipChunksRef.current[streamId] || [];
          list.push({ blob: e.data, ts: Date.now() });
          const cutoff = Date.now() - clipDuration * 1000;
          if (list.length > 2) {
            clipChunksRef.current[streamId] = [list[0], ...list.slice(1).filter(i => i.ts >= cutoff)];
          } else {
            clipChunksRef.current[streamId] = list;
          }
        }
      };
      recorder.start(1000);
      recordersRef.current[streamId] = { recorder, mimeType };
    } catch (err) {
      addLog(`Aviso no buffer de clipe: ${err.message}`);
    }
  };

  const saveClip30s = (streamObj, openReplayOnly = false) => {
    const chunks = clipChunksRef.current[streamObj.id] || [];
    if (!chunks.length) {
      alert('Aguarde alguns segundos de transmissão para acumular o buffer de 30 segundos.');
      return;
    }
    const mime = recordersRef.current[streamObj.id]?.mimeType || 'video/webm';
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks.map(c => c.blob), { type: mime });
    const url = URL.createObjectURL(blob);

    if (openReplayOnly) {
      setReplayClipUrl(url);
      return;
    }

    const a = document.createElement('a');
    a.href = url;
    a.download = `Telinha_Clip_${streamObj.owner}_${Date.now()}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    addLog(`Clipe de ${clipDuration}s (sem áudio) salvo em Downloads!`);
  };

  // Compartilhar Tela / Jogo / Janela / Aba
  const handleShareScreen = async () => {
    try {
      const resMap = {
        '720p': { width: 1280, height: 720 },
        '1080p': { width: 1920, height: 1080 },
        '1440p': { width: 2560, height: 1440 },
        'auto': { width: 1920, height: 1080 }
      };
      const targetRes = resMap[quality] || resMap['auto'];
      const targetFps = gameMode ? 60 : Number(fps);

      const mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: targetRes.width },
          height: { ideal: targetRes.height },
          frameRate: { ideal: targetFps, max: 60 }
        },
        audio: true
      });

      const vTrack = mediaStream.getVideoTracks()[0];
      if (vTrack && 'contentHint' in vTrack) {
        vTrack.contentHint = gameMode ? 'motion' : sharpness;
      }

      const newId = 'screen_' + Math.random().toString(36).substring(2, 9);
      vTrack.onended = () => stopStream(newId);

      const newStreamObj = {
        id: newId,
        peerId: socketRef.current?.id,
        owner: nickname,
        type: gameMode ? 'Modo Jogo' : 'Tela',
        stream: mediaStream,
        muted: true,
        minimized: false,
        fps: targetFps,
        res: quality === 'auto' ? '1080p' : quality,
        bitrate: '8.0 Mbps',
        isLocal: true
      };

      localStreamsRef.current.push(newStreamObj);
      setStreams(prev => [...prev, newStreamObj]);
      startCircularClipBuffer(newId, mediaStream);

      participants.forEach(p => {
        if (p.id !== socketRef.current?.id) {
          createOfferForPeer(p.id, newStreamObj);
        }
      });

      addLog(`Compartilhamento iniciado (${newStreamObj.res} @ ${targetFps}fps, Codec: ${codec})`);
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
        peerId: socketRef.current?.id,
        owner: nickname,
        type: 'Câmera',
        stream: mediaStream,
        muted: true,
        minimized: false,
        fps: Number(fps),
        res: '720p',
        bitrate: '2.5 Mbps',
        isLocal: true
      };

      localStreamsRef.current.push(newStreamObj);
      setStreams(prev => [...prev, newStreamObj]);
      startCircularClipBuffer(newId, mediaStream);

      participants.forEach(p => {
        if (p.id !== socketRef.current?.id) {
          createOfferForPeer(p.id, newStreamObj);
        }
      });
    } catch (err) {
      alert('Não foi possível acessar a webcam.');
    }
  };

  const stopStream = (streamId) => {
    setStreams(prev => {
      const target = prev.find(s => s.id === streamId);
      if (target?.stream && target.isLocal) {
        target.stream.getTracks().forEach(t => t.stop());
      }
      return prev.filter(s => s.id !== streamId);
    });
    localStreamsRef.current = localStreamsRef.current.filter(s => s.id !== streamId);
    socketRef.current?.emit('stop-stream', { streamId });
    if (expandedId === streamId) setExpandedId(null);
  };

  const runIpv6Diagnostic = async () => {
    setShowIpv6Modal(true);
    setIpv6Diag({ running: true, hasIpv6: false, candidates: [] });
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.createDataChannel('ipv6_test');
    const list = [];
    let v6 = false;
    pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) {
        const c = e.candidate.candidate;
        list.push(c);
        if (c.includes(':') && !c.includes('.local')) v6 = true;
        setIpv6Diag({ running: true, hasIpv6: v6, candidates: [...list] });
      }
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    setTimeout(() => {
      pc.close();
      setIpv6Diag(prev => ({ ...prev, running: false }));
    }, 3000);
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
    alert(`Link da sala copiado:\n${url}`);
  };

  if (!inRoom) {
    return (
      <div className="h-screen w-screen bg-[#0D0F13] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#151922] border border-[#232936] rounded-xl p-6 shadow-2xl">
          <div className="flex items-center gap-2 mb-6">
            <span className="text-xl font-bold tracking-tight text-white">telinha</span>
            <span className="text-[11px] bg-[#1E2433] text-indigo-400 px-2 py-0.5 rounded font-medium">v1.13.4</span>
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
      {/* BARRA SUPERIOR (Imagem 1) */}
      <header className="h-12 bg-[#12151C] border-b border-[#1E232E] px-3 flex items-center justify-between gap-2 shrink-0 z-20">
        <div className="flex items-center gap-2">
          <span className="font-bold text-white text-sm tracking-tight">telinha</span>
          <span className="text-amber-400 text-xs">🔒</span>
          <span className="bg-[#1B202B] border border-[#262C3A] text-[11px] text-gray-300 px-2 py-0.5 rounded-full">
            {participants.length} online
          </span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <select value={quality} onChange={e => setQuality(e.target.value)} className="bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            <option value="auto">Qualidade: automática</option>
            <option value="720p">Qualidade: 720p</option>
            <option value="1080p">Qualidade: 1080p</option>
            <option value="1440p">Qualidade: 2K (1440p)</option>
          </select>

          <select value={sharpness} onChange={e => setSharpness(e.target.value)} className="bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            <option value="detail">Nitidez (texto/código)</option>
            <option value="motion">Fluidez (movimento/jogos)</option>
          </select>

          <select value={fps} onChange={e => setFps(Number(e.target.value))} className="bg-[#171B24] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>

          <button onClick={handleShareCamera} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer">
            <span>📷</span> Câmera
          </button>

          <button onClick={() => socketRef.current?.emit('send-cheer')} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 flex items-center gap-1.5 cursor-pointer">
            <span>🎉</span> Diga que valeu
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

          {/* Popover de Configurações (Imagem 2) */}
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

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Suavidade (para quem assiste)</label>
                  <select value={smoothness} onChange={e => setSmoothness(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="smooth">Mais suave (+atraso)</option>
                    <option value="balanced">Equilibrado</option>
                    <option value="responsive">Mais responsivo (menor latência)</option>
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1 leading-snug">
                    Se a tela dá umas engasgadas, use "Mais suave": fica uns décimos de segundo atrasado, mas fluido.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Codec de vídeo (para quem compartilha)</label>
                  <select value={codec} onChange={e => setCodec(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="AV1">AV1 (mais novo, pesa bastante)</option>
                    <option value="VP9">VP9 (alta qualidade)</option>
                    <option value="H264">H.264 (NVENC / Hardware)</option>
                    <option value="VP8">VP8 (padrão)</option>
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1 leading-snug">
                    Se travar ou engasgar, volte para o padrão. Muda na hora.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Clipes e replay (para quem assiste)</label>
                  <select value={clipConfig} onChange={e => setClipConfig(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="720p">Ligado · 720p (leve)</option>
                    <option value="1080p">Ligado · 1080p</option>
                    <option value="off">Desligado</option>
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1 leading-snug">
                    Guarda os últimos 30s de cada live (somente vídeo, sem áudio). 🎬 salva um clipe MP4; ⏪ abre o replay.
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Modo de Conexão</label>
                  <select value={connPolicy} onChange={e => setConnPolicy(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="auto">Automático (IPv6 Direto + Plano B)</option>
                    <option value="ipv6">Somente Conexão Direta (IPv6)</option>
                    <option value="turn">Somente Plano B (TURN Relay)</option>
                  </select>
                </div>

                <div className="pt-1 border-t border-[#222834]">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-gray-200">Remover sons do Discord (App Desktop)</span>
                    <input type="checkbox" checked={removeDiscordAudio} onChange={e => setRemoveDiscordAudio(e.target.checked)} className="accent-indigo-500" />
                  </div>
                  <button onClick={runIpv6Diagnostic} className="w-full bg-[#1B202B] hover:bg-[#242B3A] border border-[#2E3646] rounded-lg py-2 text-xs font-medium text-white flex items-center justify-center gap-1.5 cursor-pointer">
                    <span>🌐</span> Assistente de IPv6
                  </button>
                  <p className="text-[10px] text-gray-500 mt-2">Fica salvo neste navegador.</p>
                </div>
              </div>
            )}
          </div>

          <button onClick={() => setShowLogs(!showLogs)} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            📋 Logs
          </button>

          <button onClick={() => alert('App Desktop Tauri configurado para compilar via cargo tauri build.')} className="bg-[#2B82F6] hover:bg-[#1D6FE0] text-white font-medium text-xs rounded-md px-3 py-1.5 cursor-pointer">
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

      {/* ÁREA CENTRAL + BARRA LATERAL */}
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
                    onStop={() => stopStream(streamObj.id)}
                    onMute={() => setStreams(prev => prev.map(s => s.id === streamObj.id ? { ...s, muted: !s.muted } : s))}
                    onMinimize={() => setStreams(prev => prev.map(s => s.id === streamObj.id ? { ...s, minimized: !s.minimized } : s))}
                    onExpand={() => setExpandedId(expandedId === streamObj.id ? null : streamObj.id)}
                    isExpanded={expandedId === streamObj.id}
                    onClip={() => saveClip30s(streamObj, false)}
                    onReplay={() => saveClip30s(streamObj, true)}
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
            Telinha v1.13.4
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
                    <span className="text-amber-400 text-[11px]">✨ {p.cheers || 0}</span>
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

      {showLogs && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">Logs WebRTC / Socket.IO</h4>
              <button onClick={() => setShowLogs(false)} className="text-xs text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="bg-[#0B0D11] border border-[#1E232E] rounded-lg p-3 h-64 overflow-y-auto font-mono text-[11px] text-emerald-400 space-y-1">
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </div>
        </div>
      )}

      {showIpv6Modal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">🌐 Diagnóstico IPv6 Direto & TURN</h4>
              <button onClick={() => setShowIpv6Modal(false)} className="text-xs text-gray-400 hover:text-white">✕</button>
            </div>
            <div className="text-xs space-y-2 bg-[#0D1016] p-3 rounded-lg border border-[#1E232E]">
              <div>IPv6 Direto Detectado: {ipv6Diag.hasIpv6 ? <span className="text-emerald-400 font-semibold">Sim (Sem NAT)</span> : <span className="text-amber-400">Usando IPv4 + Plano B (TURN Ativo)</span>}</div>
              <div className="text-[11px] text-gray-400 font-mono max-h-40 overflow-y-auto pt-2 border-t border-[#1E232E]">
                {ipv6Diag.candidates.map((c, i) => <div key={i} className="truncate">{c}</div>)}
              </div>
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

function VideoTile({ streamObj, onStop, onMute, onMinimize, onExpand, isExpanded, onClip, onReplay }) {
  const videoRef = useRef(null);
  useEffect(() => {
    if (videoRef.current && streamObj.stream) {
      videoRef.current.srcObject = streamObj.stream;
    }
  }, [streamObj.stream]);

  return (
    <div className="relative bg-[#12151C] border border-[#222836] rounded-xl overflow-hidden flex items-center justify-center group">
      <video ref={videoRef} autoPlay playsInline muted={streamObj.muted} className="w-full h-full object-contain bg-black" />
      <div className="absolute top-2.5 left-2.5 flex items-center gap-2 bg-black/75 px-2.5 py-1 rounded-md border border-white/10 text-xs">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
        <span className="font-semibold text-white">{streamObj.owner}</span>
        <span className="text-gray-400 text-[11px]">· {streamObj.res} · {streamObj.fps} FPS</span>
      </div>
      <div className="absolute bottom-2.5 right-2.5 flex items-center gap-1.5 bg-black/80 p-1.5 rounded-lg border border-white/10">
        <button onClick={onClip} className="bg-[#1E2433] hover:bg-indigo-600 text-white text-[11px] px-2.5 py-1 rounded cursor-pointer">🎬 Clipe 30s</button>
        <button onClick={onReplay} className="bg-[#1E2433] hover:bg-indigo-600 text-white text-[11px] px-2 py-1 rounded cursor-pointer">⏪ Replay</button>
        <button onClick={onMute} className="bg-[#1E2433] hover:bg-[#2A3246] text-white text-[11px] px-2 py-1 rounded cursor-pointer">
          {streamObj.muted ? '🔇 Mutado' : '🔊 Áudio'}
        </button>
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
