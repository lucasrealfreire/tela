import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';

const DEFAULT_ICE_SERVERS = [
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

const RES_MAP = {
  '720p': { width: 1280, height: 720, bitrate: 6000000, label: '720p' },
  '1080p': { width: 1920, height: 1080, bitrate: 10000000, label: '1080p' },
  '1440p': { width: 2560, height: 1440, bitrate: 15000000, label: '2K (1440p)' },
  'auto': { width: 1920, height: 1080, bitrate: 10000000, label: '1080p' }
};

export default function App() {
  const [inRoom, setInRoom] = useState(false);
  const [nickname, setNickname] = useState(() => localStorage.getItem('tl_nick') || 'gosadinhas');
  const [roomName, setRoomName] = useState('squad-brasil');

  // Controles de Qualidade (Padrão 1080p / 60fps)
  const [quality, setQuality] = useState('1080p');
  const [sharpness, setSharpness] = useState('detail');
  const [fps, setFps] = useState(60);
  const [gameMode, setGameMode] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showIpv6Modal, setShowIpv6Modal] = useState(false);
  const [replayClipUrl, setReplayClipUrl] = useState(null);

  const [smoothness, setSmoothness] = useState('smooth');
  const [codec, setCodec] = useState('AUTO');
  const [clipConfig, setClipConfig] = useState('1080p');
  const [clipDuration, setClipDuration] = useState(30);
  const [connPolicy, setConnPolicy] = useState('auto');

  const [streams, setStreams] = useState([]);
  const [expandedId, setExpandedId] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [messages, setMessages] = useState([
    { id: 'sys-1', system: true, text: 'Sessão criada com senha. Mande o link para a galera!' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [logs, setLogs] = useState([]);
  const [ipv6Diag, setIpv6Diag] = useState({ running: false, hasIpv6: false, candidates: [] });

  const socketRef = useRef(null);
  const pcsRef = useRef({});
  const webrtcConnectedRef = useRef({}); // streamId -> true quando WebRTC está ativo (desliga o Plano B lento)
  const pendingCandidatesRef = useRef({});
  const participantsRef = useRef([]);
  const localStreamsRef = useRef([]);
  const relayIntervalsRef = useRef({});
  const relayFramesRef = useRef({});
  const clipChunksRef = useRef({});
  const recordersRef = useRef({});

  const addLog = (msg) => {
    const time = new Date().toLocaleTimeString('pt-BR');
    setLogs(prev => [`[${time}] ${msg}`, ...prev.slice(0, 140)]);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('sala')) setRoomName(params.get('sala'));
  }, []);

  useEffect(() => {
    localStorage.setItem('tl_nick', nickname);
  }, [nickname]);

  // Atualiza resolução, FPS e Bitrate EM TEMPO REAL se o usuário mudar os seletores durante a live!
  useEffect(() => {
    const targetCfg = RES_MAP[quality] || RES_MAP['1080p'];
    const targetFps = gameMode ? 60 : Number(fps);

    localStreamsRef.current.forEach(async (ls) => {
      if (ls.type === 'Câmera') return;
      const vTrack = ls.stream.getVideoTracks()[0];
      if (!vTrack) return;

      try {
        await vTrack.applyConstraints({
          width: { ideal: targetCfg.width },
          height: { ideal: targetCfg.height },
          frameRate: { ideal: targetFps, max: 60 }
        });
        if ('contentHint' in vTrack) {
          vTrack.contentHint = gameMode ? 'motion' : sharpness;
        }
      } catch (e) {}

      ls.res = targetCfg.label;
      ls.fps = targetFps;

      // Atualiza todos os RTCPeerConnections enviando para os amigos para subir o bitrate para até 15 Mbps
      Object.entries(pcsRef.current).forEach(([key, pc]) => {
        if (key.endsWith(ls.id)) {
          pc.getSenders().forEach(sender => {
            if (sender.track && sender.track.kind === 'video') {
              try {
                const params = sender.getParameters();
                if (!params.encodings || !params.encodings.length) params.encodings = [{}];
                params.encodings[0].maxBitrate = targetCfg.bitrate;
                params.encodings[0].maxFramerate = targetFps;
                params.encodings[0].scaleResolutionDownBy = 1.0;
                params.degradationPreference = 'maintain-resolution';
                sender.setParameters(params).catch(() => {});
              } catch (e) {}
            }
          });
        }
      });

      setStreams(prev => prev.map(s => s.id === ls.id ? { ...s, res: targetCfg.label, fps: targetFps } : s));
      socketRef.current?.emit('stream-meta-update', { streamId: ls.id, res: targetCfg.label, fps: targetFps });
      addLog(`Qualidade atualizada ao vivo: ${targetCfg.label} @ ${targetFps} FPS (${targetCfg.bitrate / 1000000} Mbps)`);
    });
  }, [quality, fps, sharpness, gameMode]);

  useEffect(() => {
    if (!inRoom) return;

    const socket = io({ transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      addLog(`Conectado ao servidor (ID: ${socket.id})`);
      socket.emit('join-room', { roomName, nickname });
      setTimeout(() => socket.emit('request-streams'), 600);
    });

    socket.on('room-users', (usersList) => {
      participantsRef.current = usersList;
      setParticipants(usersList);
    });

    socket.on('user-joined', ({ id, nick }) => {
      if (id === socket.id) return;
      addLog(`Sincronizando transmissões de alta qualidade com ${nick || id}...`);
      localStreamsRef.current.forEach(ls => {
        createOfferForPeer(id, ls);
      });
    });

    socket.on('stream-meta-update', ({ streamId, res, fps: newFps }) => {
      setStreams(prev => prev.map(s => s.id === streamId ? { ...s, res, fps: newFps } : s));
    });

    socket.on('webrtc-signal', async ({ senderId, signal, streamMeta }) => {
      if (!streamMeta?.streamId) return;
      const key = `${senderId}_${streamMeta.streamId}`;

      try {
        if (signal.type === 'offer') {
          addLog(`Recebendo oferta WebRTC HD/2K de ${streamMeta.owner}...`);
          const pc = createPeerConnection(senderId, streamMeta);
          pcsRef.current[key] = pc;

          await pc.setRemoteDescription(new RTCSessionDescription(signal));

          const queued = pendingCandidatesRef.current[key] || [];
          for (const cand of queued) {
            await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
          }
          pendingCandidatesRef.current[key] = [];

          const answer = await pc.createAnswer();
          // Eleva o limite de bitrate no SDP para garantir 12-15 Mbps sem compressão agressiva do Chrome
          if (answer.sdp) {
            answer.sdp = answer.sdp.replace(/(m=video.*\r\n)/g, `$1b=AS:15000\r\n`);
          }
          await pc.setLocalDescription(answer);

          socket.emit('webrtc-signal', {
            targetId: senderId,
            signal: pc.localDescription,
            streamMeta
          });
        } else if (signal.type === 'answer') {
          const pc = pcsRef.current[key];
          if (pc && pc.signalingState === 'have-local-offer') {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
            const queued = pendingCandidatesRef.current[key] || [];
            for (const cand of queued) {
              await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
            }
            pendingCandidatesRef.current[key] = [];
            addLog(`Conexão WebRTC P2P/TURN de alta taxa ativa!`);
          }
        } else if (signal.candidate) {
          const pc = pcsRef.current[key];
          if (pc && pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)).catch(() => {});
          } else {
            if (!pendingCandidatesRef.current[key]) pendingCandidatesRef.current[key] = [];
            pendingCandidatesRef.current[key].push(signal.candidate);
          }
        }
      } catch (err) {
        addLog(`Aviso WebRTC: ${err.message}`);
      }
    });

    // O Plano B via WebSocket agora só roda em 720p HD se o WebRTC ainda não tiver conectado
    socket.on('relay-frame', ({ senderId, streamId, owner, res, fps: rFps, frame }) => {
      if (webrtcConnectedRef.current[streamId]) return; // Ignora Plano B se o WebRTC 60fps já conectou!
      relayFramesRef.current[streamId] = frame;
      setStreams(prev => {
        const exists = prev.find(s => s.id === streamId);
        if (exists) {
          return prev.map(s => s.id === streamId ? { ...s, lastRelayFrame: frame } : s);
        }
        return [
          ...prev,
          {
            id: streamId,
            peerId: senderId,
            owner: owner || 'Amigo',
            type: 'Tela',
            stream: null,
            lastRelayFrame: frame,
            muted: true,
            minimized: false,
            fps: rFps || 60,
            res: res || '1080p',
            isLocal: false
          }
        ];
      });
    });

    socket.on('peer-stopped-stream', ({ senderId, streamId }) => {
      const key = `${senderId}_${streamId}`;
      if (pcsRef.current[key]) {
        pcsRef.current[key].close();
        delete pcsRef.current[key];
      }
      delete relayFramesRef.current[streamId];
      delete webrtcConnectedRef.current[streamId];
      setStreams(prev => prev.filter(s => s.id !== streamId));
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
      Object.values(relayIntervalsRef.current).forEach(clearInterval);
      localStreamsRef.current.forEach(s => s.stream.getTracks().forEach(t => t.stop()));
      Object.values(pcsRef.current).forEach(pc => pc.close());
      socket.disconnect();
    };
  }, [inRoom, roomName, nickname]);

  const createPeerConnection = (peerId, streamMeta) => {
    const key = `${peerId}_${streamMeta.streamId}`;
    if (pcsRef.current[key]) {
      pcsRef.current[key].close();
    }

    const pc = new RTCPeerConnection({
      iceServers: DEFAULT_ICE_SERVERS,
      iceTransportPolicy: connPolicy === 'turn' ? 'relay' : 'all',
      bundlePolicy: 'max-bundle',
      iceCandidatePoolSize: 10
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('webrtc-signal', {
          targetId: peerId,
          signal: { candidate: event.candidate },
          streamMeta
        });
      }
    };

    const fallbackRemoteStream = new MediaStream();

    pc.ontrack = (event) => {
      fallbackRemoteStream.addTrack(event.track);
      const activeStream = (event.streams && event.streams[0]) ? event.streams[0] : fallbackRemoteStream;

      setStreams(prev => {
        const exists = prev.find(s => s.id === streamMeta.streamId);
        if (exists) {
          return prev.map(s => s.id === streamMeta.streamId ? { ...s, stream: activeStream, res: streamMeta.res, fps: streamMeta.fps } : s);
        }
        const newObj = {
          id: streamMeta.streamId,
          peerId,
          owner: streamMeta.owner,
          type: streamMeta.type,
          stream: activeStream,
          lastRelayFrame: relayFramesRef.current[streamMeta.streamId] || null,
          muted: false,
          minimized: false,
          fps: streamMeta.fps,
          res: streamMeta.res,
          isLocal: false
        };
        startCircularClipBuffer(streamMeta.streamId, activeStream);
        return [...prev, newObj];
      });
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      addLog(`ICE [${streamMeta.owner}]: ${state}`);
      if (state === 'connected' || state === 'completed') {
        webrtcConnectedRef.current[streamMeta.streamId] = true;
      }
    };

    return pc;
  };

  const createOfferForPeer = async (targetPeerId, localStreamObj) => {
    try {
      const targetCfg = RES_MAP[quality] || RES_MAP['1080p'];
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
          try {
            const params = sender.getParameters();
            if (!params.encodings || !params.encodings.length) params.encodings = [{}];
            params.encodings[0].maxBitrate = targetCfg.bitrate;
            params.encodings[0].maxFramerate = Number(localStreamObj.fps);
            params.encodings[0].scaleResolutionDownBy = 1.0;
            params.degradationPreference = 'maintain-resolution';
            sender.setParameters(params).catch(() => {});
          } catch (e) {}
        }
      });

      const offer = await pc.createOffer({
        offerToReceiveVideo: true,
        offerToReceiveAudio: true
      });
      if (offer.sdp) {
        offer.sdp = offer.sdp.replace(/(m=video.*\r\n)/g, `$1b=AS:15000\r\n`);
      }
      await pc.setLocalDescription(offer);

      socketRef.current?.emit('webrtc-signal', {
        targetId: targetPeerId,
        signal: pc.localDescription,
        streamMeta
      });
    } catch (err) {
      addLog(`Erro ao criar oferta: ${err.message}`);
    }
  };

  // O Plano B via WebSocket agora transmite em 720p HD (1280x720) e para de gastar CPU assim que o WebRTC 60fps conecta!
  const startBackupRelaySender = (streamObj) => {
    const hiddenVideo = document.createElement('video');
    hiddenVideo.srcObject = streamObj.stream;
    hiddenVideo.muted = true;
    hiddenVideo.playsInline = true;
    hiddenVideo.play().catch(() => {});

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const interval = setInterval(() => {
      if (!hiddenVideo.videoWidth) return;
      // Verifica se todos os peers já estão com WebRTC conectado; se sim, não envia frames de fallback desnecessários
      const allConnected = Object.values(pcsRef.current).length > 0 &&
        Object.values(pcsRef.current).every(pc => pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed');
      if (allConnected) return;

      const targetW = 1280;
      const targetH = Math.round((hiddenVideo.videoHeight / hiddenVideo.videoWidth) * targetW) || 720;
      canvas.width = targetW;
      canvas.height = targetH;
      ctx.drawImage(hiddenVideo, 0, 0, targetW, targetH);
      const base64Frame = canvas.toDataURL('image/jpeg', 0.80);

      socketRef.current?.emit('relay-frame', {
        streamId: streamObj.id,
        owner: nickname,
        res: streamObj.res,
        fps: streamObj.fps,
        frame: base64Frame
      });
    }, 90);

    relayIntervalsRef.current[streamObj.id] = interval;
  };

  // Buffer Circular de 30s (SOMENTE VÍDEO — ZERO ÁUDIO)
  const startCircularClipBuffer = (streamId, mediaStream) => {
    if (clipConfig === 'off' || !mediaStream) return;
    setTimeout(() => {
      try {
        const videoTracks = mediaStream.getVideoTracks();
        if (!videoTracks.length) return;
        const videoOnlyStream = new MediaStream([videoTracks[0]]);
        const mimeType = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1')
          ? 'video/mp4;codecs=avc1'
          : 'video/webm';

        const recorder = new MediaRecorder(videoOnlyStream, {
          mimeType,
          videoBitsPerSecond: 6000000
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
      } catch (err) {}
    }, 1000);
  };

  const saveClip30s = (streamObj, openReplayOnly = false) => {
    const chunks = clipChunksRef.current[streamObj.id] || [];
    if (!chunks.length) {
      alert('Aguarde alguns segundos de transmissão para salvar os últimos 30s.');
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
  };

  const handleShareScreen = async () => {
    try {
      const targetCfg = RES_MAP[quality] || RES_MAP['1080p'];
      const targetFps = gameMode ? 60 : Number(fps);

      const mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          width: { ideal: targetCfg.width, max: 2560 },
          height: { ideal: targetCfg.height, max: 1440 },
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
        res: targetCfg.label,
        isLocal: true
      };

      localStreamsRef.current.push(newStreamObj);
      setStreams(prev => [...prev, newStreamObj]);
      startCircularClipBuffer(newId, mediaStream);
      startBackupRelaySender(newStreamObj);

      participantsRef.current.forEach(p => {
        if (p.id !== socketRef.current?.id) {
          createOfferForPeer(p.id, newStreamObj);
        }
      });

      addLog(`Transmissão iniciada em ${targetCfg.label} @ ${targetFps} FPS`);
    } catch (err) {
      addLog(`Compartilhamento cancelado: ${err.message}`);
    }
  };

  const handleShareCamera = async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: Number(fps) } },
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
        res: '1080p',
        isLocal: true
      };

      localStreamsRef.current.push(newStreamObj);
      setStreams(prev => [...prev, newStreamObj]);
      startCircularClipBuffer(newId, mediaStream);
      startBackupRelaySender(newStreamObj);

      participantsRef.current.forEach(p => {
        if (p.id !== socketRef.current?.id) {
          createOfferForPeer(p.id, newStreamObj);
        }
      });
    } catch (err) {
      alert('Não foi possível acessar a webcam.');
    }
  };

  const stopStream = (streamId) => {
    if (relayIntervalsRef.current[streamId]) {
      clearInterval(relayIntervalsRef.current[streamId]);
      delete relayIntervalsRef.current[streamId];
    }
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
    const pc = new RTCPeerConnection({ iceServers: DEFAULT_ICE_SERVERS });
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
    setTimeout(() => pc.close(), 3000);
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
            <option value="720p">Qualidade: 720p</option>
            <option value="1080p">Qualidade: 1080p (Full HD)</option>
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

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Suavidade (para quem assiste)</label>
                  <select value={smoothness} onChange={e => setSmoothness(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="smooth">Mais suave (+atraso)</option>
                    <option value="balanced">Equilibrado</option>
                    <option value="responsive">Mais responsivo (menor latência)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Codec de vídeo</label>
                  <select value={codec} onChange={e => setCodec(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="AUTO">Automático (H.264 / VP9)</option>
                    <option value="H264">H.264 (NVENC / Hardware)</option>
                    <option value="VP9">VP9 (Alta Nitidez)</option>
                    <option value="AV1">AV1</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-200 mb-1">Clipes e replay</label>
                  <select value={clipConfig} onChange={e => setClipConfig(e.target.value)} className="w-full bg-[#1B202B] border border-[#2B3242] rounded-lg px-2.5 py-2 text-xs text-white">
                    <option value="1080p">Ligado · 1080p</option>
                    <option value="720p">Ligado · 720p (leve)</option>
                    <option value="off">Desligado</option>
                  </select>
                </div>

                <div className="pt-1 border-t border-[#222834]">
                  <button onClick={runIpv6Diagnostic} className="w-full bg-[#1B202B] hover:bg-[#242B3A] border border-[#2E3646] rounded-lg py-2 text-xs font-medium text-white flex items-center justify-center gap-1.5 cursor-pointer">
                    <span>🌐</span> Assistente de IPv6
                  </button>
                </div>
              </div>
            )}
          </div>

          <button onClick={() => setShowLogs(!showLogs)} className="bg-[#171B24] hover:bg-[#1E2330] border border-[#282E3D] text-xs text-gray-200 rounded-md px-2.5 py-1.5 cursor-pointer">
            📋 Logs
          </button>

          <button onClick={copyRoomLink} className="bg-[#2B82F6] hover:bg-[#1D6FE0] text-white font-medium text-xs rounded-md px-3 py-1.5 cursor-pointer">
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

      {showLogs && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50">
          <div className="bg-[#141820] border border-[#262C3A] rounded-xl w-full max-w-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold">Logs WebRTC / Qualidade</h4>
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
              <div>IPv6 Direto: {ipv6Diag.hasIpv6 ? <span className="text-emerald-400 font-semibold">Detectado</span> : <span className="text-amber-400">Usando IPv4 + TURN</span>}</div>
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
  const [webrtcPlaying, setWebrtcPlaying] = useState(false);
  const [realRes, setRealRes] = useState('');

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !streamObj.stream) return;

    el.srcObject = streamObj.stream;
    el.muted = true;
    el.play().then(() => {
      if (!streamObj.isLocal) el.muted = streamObj.muted;
    }).catch(() => {});

    const checkVideoFrames = setInterval(() => {
      if (el.videoWidth > 0 && el.readyState >= 2) {
        setWebrtcPlaying(true);
        setRealRes(`${el.videoHeight}p`);
      }
    }, 400);

    return () => clearInterval(checkVideoFrames);
  }, [streamObj.stream]);

  useEffect(() => {
    if (videoRef.current && !streamObj.isLocal) {
      videoRef.current.muted = streamObj.muted;
    }
  }, [streamObj.muted, streamObj.isLocal]);

  return (
    <div className="relative bg-[#12151C] border border-[#222836] rounded-xl overflow-hidden flex items-center justify-center group">
      {/* IMPORTANTE: nunca usar display:none no <video> WebRTC para o Chrome não pausar o decodificador de hardware! */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={streamObj.isLocal ? true : streamObj.muted}
        className="w-full h-full object-contain bg-black z-10"
      />

      {!streamObj.isLocal && !webrtcPlaying && streamObj.lastRelayFrame && (
        <img
          src={streamObj.lastRelayFrame}
          alt={streamObj.owner}
          className="absolute inset-0 w-full h-full object-contain bg-black z-20"
        />
      )}

      <div className="absolute top-2.5 left-2.5 z-30 flex items-center gap-2 bg-black/75 px-2.5 py-1 rounded-md border border-white/10 text-xs">
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
        <span className="font-semibold text-white">{streamObj.owner} {streamObj.isLocal && '(Você)'}</span>
        <span className="text-gray-400 text-[11px]">
          · {realRes || streamObj.res} · {streamObj.fps} FPS
        </span>
      </div>

      <div className="absolute bottom-2.5 right-2.5 z-30 flex items-center gap-1.5 bg-black/80 p-1.5 rounded-lg border border-white/10">
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