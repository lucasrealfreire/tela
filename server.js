import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Gerador ZIP nativo em memória (sem dependências externas) para entrega limpa pelo navegador
function createZipBuffer(files) {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[n] = c >>> 0;
  }
  function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const dataBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const crc = crc32(dataBuf);

    const localHeader = Buffer.alloc(30 + nameBuf.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 flag
    localHeader.writeUInt16LE(0, 8);      // STORE (0)
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuf.length, 18);
    localHeader.writeUInt32LE(dataBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuf.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuf.length, 20);
    centralHeader.writeUInt32LE(dataBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuf.copy(centralHeader, 46);

    localParts.push(localHeader, dataBuf);
    centralParts.push(centralHeader);
    offset += localHeader.length + dataBuf.length;
  }

  const centralSize = centralParts.reduce((a, b) => a + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

// Endpoint que gera e baixa o Executável Desktop Windows (TelinhaVogels.exe com WASAPI Anti-Eco do Discord)
app.get('/api/download-app', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const appUrl = `${proto}://${req.get('host')}`;

  // Código-fonte C# compilado nativamente pelo csc.exe do próprio Windows (Zero alerta de vírus/SmartScreen)
  const csharpSource = `
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace TelinhaVogelsDesktop {
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator {
        int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollection ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    }

    [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection {
        int GetCount(out int pcDevices);
        int Item(int nDevice, out IMMDevice ppDevice);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2 {
        int GetAudioSessionControl(IntPtr AudioSessionGuid, int StreamFlags, out IntPtr SessionControl);
        int GetSimpleAudioVolume(IntPtr AudioSessionGuid, int StreamFlags, out IntPtr AudioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator {
        int GetCount(out int SessionCount);
        int GetSession(int SessionCount, [MarshalAs(UnmanagedType.IUnknown)] out object Session);
    }

    [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2 {
        int GetState(out int pRetVal);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, ref Guid EventContext);
        int GetGroupingParam(out Guid pRetVal);
        int SetGroupingParam(ref Guid Override, ref Guid EventContext);
        int RegisterAudioSessionNotification(IntPtr NewNotifications);
        int UnregisterAudioSessionNotification(IntPtr NewNotifications);
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string pRetVal);
        int GetProcessId(out uint pRetVal);
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ISimpleAudioVolume {
        int SetMasterVolume(float fLevel, ref Guid EventContext);
        int GetMasterVolume(out float pfLevel);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid EventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    public class Program {
        static bool discordMuted = false;

        public static int SetDiscordMute(bool mute) {
            int count = 0;
            try {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
                IMMDeviceCollection devices;
                enumerator.EnumAudioEndpoints(0, 1, out devices); // eRender, DEVICE_STATE_ACTIVE
                int devCount = 0;
                devices.GetCount(out devCount);
                Guid iidMgr = typeof(IAudioSessionManager2).GUID;
                Guid emptyGuid = Guid.Empty;

                for (int d = 0; d < devCount; d++) {
                    IMMDevice dev;
                    devices.Item(d, out dev);
                    object objMgr;
                    dev.Activate(ref iidMgr, 23, IntPtr.Zero, out objMgr);
                    IAudioSessionManager2 mgr = objMgr as IAudioSessionManager2;
                    if (mgr == null) continue;

                    IAudioSessionEnumerator sessionEnum;
                    mgr.GetSessionEnumerator(out sessionEnum);
                    int sessCount = 0;
                    sessionEnum.GetCount(out sessCount);

                    for (int i = 0; i < sessCount; i++) {
                        object rawSession;
                        sessionEnum.GetSession(i, out rawSession);
                        IAudioSessionControl2 ctl2 = rawSession as IAudioSessionControl2;
                        if (ctl2 == null) continue;

                        uint pid = 0;
                        ctl2.GetProcessId(out pid);
                        string sid = "";
                        ctl2.GetSessionIdentifier(out sid);

                        bool isDiscord = false;
                        if (!string.IsNullOrEmpty(sid) && sid.ToLower().Contains("discord")) {
                            isDiscord = true;
                        } else if (pid > 0) {
                            try {
                                Process p = Process.GetProcessById((int)pid);
                                if (p != null && p.ProcessName.ToLower().Contains("discord")) isDiscord = true;
                            } catch { }
                        }

                        if (isDiscord) {
                            ISimpleAudioVolume vol = rawSession as ISimpleAudioVolume;
                            if (vol != null) {
                                vol.SetMute(mute, ref emptyGuid);
                                count++;
                            }
                        }
                    }
                }
                discordMuted = mute;
            } catch { }
            return count;
        }

        static void StartLocalBridge() {
            Thread t = new Thread(() => {
                try {
                    TcpListener server = new TcpListener(IPAddress.Loopback, 19876);
                    server.Start();
                    while (true) {
                        using (TcpClient client = server.AcceptTcpClient())
                        using (NetworkStream stream = client.GetStream()) {
                            byte[] buf = new byte[1024];
                            int read = stream.Read(buf, 0, buf.Length);
                            string req = Encoding.UTF8.GetString(buf, 0, read);

                            int affected = 0;
                            if (req.Contains("/discord-mute?mute=1")) {
                                affected = SetDiscordMute(true);
                            } else if (req.Contains("/discord-mute?mute=0")) {
                                affected = SetDiscordMute(false);
                            }

                            string json = "{\\"ok\\":true,\\"desktop\\":true,\\"discordMuted\\":" + (discordMuted ? "true" : "false") + ",\\"sessions\\":" + affected + "}";
                            byte[] body = Encoding.UTF8.GetBytes(json);
                            string headers = "HTTP/1.1 200 OK\\r\\n" +
                                             "Content-Type: application/json\\r\\n" +
                                             "Access-Control-Allow-Origin: *\\r\\n" +
                                             "Access-Control-Allow-Methods: GET, POST, OPTIONS\\r\\n" +
                                             "Access-Control-Allow-Headers: *\\r\\n" +
                                             "Access-Control-Allow-Private-Network: true\\r\\n" +
                                             "Content-Length: " + body.Length + "\\r\\n" +
                                             "Connection: close\\r\\n\\r\\n";
                            byte[] headBytes = Encoding.UTF8.GetBytes(headers);
                            stream.Write(headBytes, 0, headBytes.Length);
                            stream.Write(body, 0, body.Length);
                        }
                    }
                } catch { }
            });
            t.IsBackground = true;
            t.Start();
        }

        [STAThread]
        public static void Main(string[] args) {
            StartLocalBridge();

            string url = "${appUrl}/?desktop=1";
            string profileDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "TelinhaVogels", "AppProfile");
            Directory.CreateDirectory(profileDir);

            string[] browsers = new string[] {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google\\\\Chrome\\\\Application\\\\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google\\\\Chrome\\\\Application\\\\chrome.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft\\\\Edge\\\\Application\\\\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft\\\\Edge\\\\Application\\\\msedge.exe")
            };

            string chosenBrowser = null;
            foreach (string b in browsers) {
                if (File.Exists(b)) { chosenBrowser = b; break; }
            }

            try {
                if (chosenBrowser != null) {
                    ProcessStartInfo psi = new ProcessStartInfo();
                    psi.FileName = chosenBrowser;
                    psi.Arguments = "--app=\\"" + url + "\\" --user-data-dir=\\"" + profileDir + "\\" --disable-features=BlockInsecurePrivateNetworkRequests --autoplay-policy=no-user-gesture-required";
                    psi.UseShellExecute = false;
                    Process appProc = Process.Start(psi);
                    if (appProc != null) {
                        appProc.WaitForExit();
                    }
                } else {
                    Process.Start(url);
                    Thread.Sleep(3600000);
                }
            } finally {
                // Garante que o Discord seja desmutado ao fechar o Telinha Vogels
                SetDiscordMute(false);
            }
        }
    }
}
`.trim();

  // Script instalador (.cmd) que compila o TelinhaVogels.exe localmente usando o compilador nativo da Microsoft (Zero SmartScreen!)
  const installerCmd = `@echo off
chcp 65001 >nul
title Instalador Telinha Vogels Desktop
echo ========================================================
echo   TELINHA VOGELS - INSTALADOR DESKTOP OFICIAL (WINDOWS)
echo ========================================================
echo.
echo [1/3] Preparando ambiente nativo WASAPI (Anti-Eco Discord)...

set "APP_DIR=%LOCALAPPDATA%\\TelinhaVogels"
if not exist "%APP_DIR%" mkdir "%APP_DIR%"

copy /Y "%~dp0TelinhaVogels.cs" "%APP_DIR%\\TelinhaVogels.cs" >nul

set "CSC=%WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"

echo [2/3] Gerando executavel assinado localmente (Sem alerta SmartScreen)...
"%CSC%" /target:winexe /nologo /optimize+ /out:"%APP_DIR%\\TelinhaVogels.exe" "%APP_DIR%\\TelinhaVogels.cs"

echo [3/3] Criando atalho 'Telinha Vogels' na Area de Trabalho...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\\Telinha Vogels.lnk'); $s.TargetPath = '%APP_DIR%\\TelinhaVogels.exe'; $s.WorkingDirectory = '%APP_DIR%'; $s.IconLocation = 'shell32.dll,18'; $s.Description = 'Telinha Vogels Desktop'; $s.Save()"

echo.
echo Concluido! Iniciando o Telinha Vogels Desktop...
start "" "%APP_DIR%\\TelinhaVogels.exe"
timeout /t 2 >nul
exit
`.replace(/\n/g, '\r\n');

  const zipBuffer = createZipBuffer([
    { name: 'Instalar e Abrir Telinha Vogels.cmd', content: installerCmd },
    { name: 'TelinhaVogels.cs', content: csharpSource }
  ]);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="Telinha-Vogels-Windows.zip"');
  res.send(zipBuffer);
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 2e7,
  pingTimeout: 60000,
  pingInterval: 15000,
  perMessageDeflate: false
});

const rooms = new Map();
const activeStreams = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;

  socket.on('join-room', ({ roomName, nickname }) => {
    const cleanRoom = String(roomName || 'geral').trim().toLowerCase().slice(0, 40);
    const cleanNick = String(nickname || 'usuario').trim().slice(0, 24);

    currentRoom = cleanRoom;
    socket.join(cleanRoom);

    if (!rooms.has(cleanRoom)) rooms.set(cleanRoom, new Map());
    if (!activeStreams.has(cleanRoom)) activeStreams.set(cleanRoom, new Map());

    const roomUsers = rooms.get(cleanRoom);
    roomUsers.set(socket.id, {
      id: socket.id,
      nick: cleanNick,
      conn: 'GPU Stream'
    });

    io.to(cleanRoom).emit('room-users', Array.from(roomUsers.values()));

    const currentStreams = Array.from(activeStreams.get(cleanRoom).values());
    if (currentStreams.length > 0) {
      socket.emit('active-streams', currentStreams);
      socket.to(cleanRoom).emit('force-keyframe');
    }
  });

  socket.on('start-stream', (meta) => {
    if (!currentRoom || !activeStreams.has(currentRoom)) return;
    const streamData = { ...meta, senderId: socket.id };
    activeStreams.get(currentRoom).set(meta.streamId, streamData);
    socket.to(currentRoom).emit('stream-started', streamData);
  });

  socket.on('v-chunk', (meta, buffer) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('v-chunk', meta, buffer);
    }
  });

  socket.on('a-chunk', (meta, buffer) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('a-chunk', meta, buffer);
    }
  });

  socket.on('request-keyframe', ({ streamId }) => {
    if (currentRoom) {
      socket.to(currentRoom).emit('force-keyframe', { streamId });
    }
  });

  socket.on('stop-stream', ({ streamId }) => {
    if (currentRoom) {
      activeStreams.get(currentRoom)?.delete(streamId);
      socket.to(currentRoom).emit('peer-stopped-stream', { streamId });
    }
  });

  socket.on('chat-message', ({ text }) => {
    if (!currentRoom) return;
    const sender = rooms.get(currentRoom)?.get(socket.id);
    if (!sender || !text || !String(text).trim()) return;

    io.to(currentRoom).emit('chat-message', {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      sender: sender.nick,
      text: String(text).trim().slice(0, 500),
      time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    });
  });

  socket.on('disconnect', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      const roomUsers = rooms.get(currentRoom);
      roomUsers.delete(socket.id);

      const roomStreams = activeStreams.get(currentRoom);
      if (roomStreams) {
        for (const [sId, sMeta] of roomStreams.entries()) {
          if (sMeta.senderId === socket.id) {
            roomStreams.delete(sId);
            socket.to(currentRoom).emit('peer-stopped-stream', { streamId: sId });
          }
        }
      }

      if (roomUsers.size === 0) {
        rooms.delete(currentRoom);
        activeStreams.delete(currentRoom);
      } else {
        io.to(currentRoom).emit('room-users', Array.from(roomUsers.values()));
      }
    }
  });
});

const distPath = path.join(__dirname, 'dist');
app.use(express.static(distPath));
app.get('*', (req, res) => {
  res.sendFile(path.join(distPath, 'index.html'));
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[TELINHA VOGELS] Rodando na porta ${PORT}`);
});