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
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
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

app.get('/api/download-app', (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const appUrl = `${proto}://${req.get('host')}`;

  // Código C# Nativo com WASAPI PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
  // Captura todo o áudio do PC/Jogo EXCLUINDO o Discord.exe da transmissão (sem mutar o Discord para quem está jogando!)
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

    // Interfaces WASAPI Process Loopback (Windows 10 20H1+ / Windows 11)
    [ComImport, Guid("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAgileObject { }

    [ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IActivateAudioInterfaceAsyncOperation {
        void GetActivateResult([MarshalAs(UnmanagedType.Error)] out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IActivateAudioInterfaceCompletionHandler {
        void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioClient {
        int Initialize(int ShareMode, uint StreamFlags, long hnsBufferDuration, long hnsPeriodicity, ref WAVEFORMATEX pFormat, IntPtr AudioSessionGuid);
        int GetBufferSize(out uint pNumBufferFrames);
        int GetStreamLatency(out long phnsLatency);
        int GetCurrentPadding(out uint pNumPaddingFrames);
        int IsFormatSupported(int ShareMode, ref WAVEFORMATEX pFormat, IntPtr ppClosestMatch);
        int GetMixFormat(out IntPtr ppDeviceFormat);
        int GetDevicePeriod(out long phnsDefaultDevicePeriod, out long phnsMinimumDevicePeriod);
        int Start();
        int Stop();
        int Reset();
        int SetEventHandle(IntPtr eventHandle);
        int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object ppv);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioCaptureClient {
        int GetBuffer(out IntPtr ppData, out uint pNumFramesToRead, out uint pdwFlags, out ulong pu64DevicePosition, out ulong pu64QPCPosition);
        int ReleaseBuffer(uint NumFramesRead);
        int GetNextPacketSize(out uint pNumFramesInNextPacket);
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct WAVEFORMATEX {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        public uint TargetProcessId;
        public int ProcessLoopbackMode; // 0 = INCLUDE_TREE, 1 = EXCLUDE_TREE
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct AUDIOCLIENT_ACTIVATION_PARAMS {
        public int ActivationType; // 1 = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
        public AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BLOB {
        public uint cbSize;
        public IntPtr pBlobData;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROPVARIANT {
        public ushort vt;
        public ushort wReserved1;
        public ushort wReserved2;
        public ushort wReserved3;
        public BLOB blob;
        public IntPtr pReserved;
    }

    internal class ActivateCompletionHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject {
        public ManualResetEvent WaitEvent = new ManualResetEvent(false);
        public IAudioClient AudioClient = null;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation) {
            try {
                int hr = 0;
                object unk = null;
                activateOperation.GetActivateResult(out hr, out unk);
                if (hr >= 0 && unk != null) {
                    AudioClient = unk as IAudioClient;
                }
            } catch { }
            WaitEvent.Set();
        }
    }

    public class Program {
        [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = false)]
        static extern void ActivateAudioInterfaceAsync(
            [MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath,
            [MarshalAs(UnmanagedType.LPStruct)] Guid riid,
            ref PROPVARIANT activationParams,
            IActivateAudioInterfaceCompletionHandler completionHandler,
            out IActivateAudioInterfaceAsyncOperation activationOperation);

        // Garante que o Discord NUNCA fique mutado no fone de quem está streamando
        public static void EnsureDiscordUnmutedForStreamer() {
            try {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
                IMMDeviceCollection devices;
                enumerator.EnumAudioEndpoints(0, 1, out devices);
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
                        string sid = "";
                        ctl2.GetSessionIdentifier(out sid);
                        if (!string.IsNullOrEmpty(sid) && sid.ToLower().Contains("discord")) {
                            ISimpleAudioVolume vol = rawSession as ISimpleAudioVolume;
                            if (vol != null) vol.SetMute(false, ref emptyGuid);
                        }
                    }
                }
            } catch { }
        }

        // Localiza o PID do processo do Discord para excluí-lo da captura da live (sem mutar no fone!)
        public static uint FindDiscordTargetPid() {
            try {
                // 1. Procura a árvore raiz do Discord.exe (o processo pai iniciado primeiro engloba todos os subprocessos de áudio)
                Process[] procs = Process.GetProcessesByName("Discord");
                if (procs != null && procs.Length > 0) {
                    Process rootProc = procs[0];
                    DateTime earliest = DateTime.MaxValue;
                    foreach (Process p in procs) {
                        try {
                            if (p.StartTime < earliest) {
                                earliest = p.StartTime;
                                rootProc = p;
                            }
                        } catch { }
                    }
                    return (uint)rootProc.Id;
                }
            } catch { }
            return (uint)Process.GetCurrentProcess().Id;
        }

        public static IAudioClient CreateProcessExcludedAudioClient(uint excludePid) {
            AUDIOCLIENT_ACTIVATION_PARAMS actParams = new AUDIOCLIENT_ACTIVATION_PARAMS();
            actParams.ActivationType = 1; // AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
            actParams.ProcessLoopbackParams.TargetProcessId = excludePid;
            actParams.ProcessLoopbackParams.ProcessLoopbackMode = 1; // PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE

            int size = Marshal.SizeOf(actParams);
            IntPtr ptr = Marshal.AllocHGlobal(size);
            Marshal.StructureToPtr(actParams, ptr, false);

            try {
                PROPVARIANT pv = new PROPVARIANT();
                pv.vt = 65; // VT_BLOB
                pv.blob.cbSize = (uint)size;
                pv.blob.pBlobData = ptr;

                ActivateCompletionHandler handler = new ActivateCompletionHandler();
                IActivateAudioInterfaceAsyncOperation op = null;
                ActivateAudioInterfaceAsync("VAD\\\\Process_Loopback", typeof(IAudioClient).GUID, ref pv, handler, out op);
                handler.WaitEvent.WaitOne(3000);
                return handler.AudioClient;
            } catch {
                return null;
            } finally {
                Marshal.FreeHGlobal(ptr);
            }
        }

        static void StreamCleanAudioWithoutDiscord(NetworkStream netStream, bool excludeDiscord) {
            string headers = "HTTP/1.1 200 OK\\r\\n" +
                             "Content-Type: application/octet-stream\\r\\n" +
                             "Access-Control-Allow-Origin: *\\r\\n" +
                             "Access-Control-Allow-Private-Network: true\\r\\n" +
                             "Cache-Control: no-cache\\r\\n" +
                             "Connection: close\\r\\n\\r\\n";
            byte[] headBytes = Encoding.UTF8.GetBytes(headers);
            netStream.Write(headBytes, 0, headBytes.Length);

            uint targetPid = excludeDiscord ? FindDiscordTargetPid() : (uint)Process.GetCurrentProcess().Id;
            IAudioClient client = CreateProcessExcludedAudioClient(targetPid);
            if (client == null) return;

            WAVEFORMATEX fmt = new WAVEFORMATEX();
            fmt.wFormatTag = 1; // WAVE_FORMAT_PCM
            fmt.nChannels = 2;
            fmt.nSamplesPerSec = 48000;
            fmt.wBitsPerSample = 16;
            fmt.nBlockAlign = 4;
            fmt.nAvgBytesPerSec = 192000;
            fmt.cbSize = 0;

            // AUDCLNT_STREAMFLAGS_LOOPBACK (0x00020000) | AUTOCONVERTPCM (0x80000000) | SRC_DEFAULT_QUALITY (0x08000000)
            int hr = client.Initialize(0, 0x88020000, 200000, 0, ref fmt, IntPtr.Zero);
            if (hr < 0) return;

            object objCap = null;
            client.GetService(typeof(IAudioCaptureClient).GUID, out objCap);
            IAudioCaptureClient capture = objCap as IAudioCaptureClient;
            if (capture == null) return;

            client.Start();
            try {
                byte[] silenceBuf = new byte[48000];
                while (true) {
                    uint packetSize = 0;
                    capture.GetNextPacketSize(out packetSize);
                    while (packetSize > 0) {
                        IntPtr dataPtr;
                        uint numFrames;
                        uint flags;
                        ulong devPos;
                        ulong qpcPos;
                        int res = capture.GetBuffer(out dataPtr, out numFrames, out flags, out devPos, out qpcPos);
                        if (res < 0) break;

                        int byteCount = (int)(numFrames * 4);
                        if (byteCount > 0) {
                            if ((flags & 2) != 0) {
                                if (byteCount <= silenceBuf.Length) {
                                    netStream.Write(silenceBuf, 0, byteCount);
                                }
                            } else {
                                byte[] pcm = new byte[byteCount];
                                Marshal.Copy(dataPtr, pcm, 0, byteCount);
                                netStream.Write(pcm, 0, byteCount);
                            }
                        }
                        capture.ReleaseBuffer(numFrames);
                        capture.GetNextPacketSize(out packetSize);
                    }
                    Thread.Sleep(10);
                }
            } catch {
            } finally {
                try { client.Stop(); } catch { }
            }
        }

        static void StartLocalBridge() {
            Thread t = new Thread(() => {
                try {
                    TcpListener server = new TcpListener(IPAddress.Loopback, 19876);
                    server.Start();
                    while (true) {
                        TcpClient client = server.AcceptTcpClient();
                        ThreadPool.QueueUserWorkItem((obj) => {
                            TcpClient c = (TcpClient)obj;
                            try {
                                using (c)
                                using (NetworkStream stream = c.GetStream()) {
                                    byte[] buf = new byte[1024];
                                    int read = stream.Read(buf, 0, buf.Length);
                                    string req = Encoding.UTF8.GetString(buf, 0, read);

                                    if (req.StartsWith("OPTIONS")) {
                                        string opt = "HTTP/1.1 204 No Content\\r\\nAccess-Control-Allow-Origin: *\\r\\nAccess-Control-Allow-Methods: GET, OPTIONS\\r\\nAccess-Control-Allow-Headers: *\\r\\nAccess-Control-Allow-Private-Network: true\\r\\nConnection: close\\r\\n\\r\\n";
                                        byte[] ob = Encoding.UTF8.GetBytes(opt);
                                        stream.Write(ob, 0, ob.Length);
                                        return;
                                    }

                                    if (req.Contains("/clean-audio")) {
                                        bool exclude = !req.Contains("exclude=0");
                                        StreamCleanAudioWithoutDiscord(stream, exclude);
                                        return;
                                    }

                                    uint dPid = FindDiscordTargetPid();
                                    string json = "{\\"ok\\":true,\\"desktop\\":true,\\"discordPid\\":" + dPid + "}";
                                    byte[] body = Encoding.UTF8.GetBytes(json);
                                    string headers = "HTTP/1.1 200 OK\\r\\n" +
                                                     "Content-Type: application/json\\r\\n" +
                                                     "Access-Control-Allow-Origin: *\\r\\n" +
                                                     "Access-Control-Allow-Private-Network: true\\r\\n" +
                                                     "Content-Length: " + body.Length + "\\r\\n" +
                                                     "Connection: close\\r\\n\\r\\n";
                                    byte[] headBytes = Encoding.UTF8.GetBytes(headers);
                                    stream.Write(headBytes, 0, headBytes.Length);
                                    stream.Write(body, 0, body.Length);
                                }
                            } catch { }
                        }, client);
                    }
                } catch { }
            });
            t.IsBackground = true;
            t.Start();
        }

        [STAThread]
        public static void Main(string[] args) {
            // Garante que o Discord esteja desmutado no mixer do Windows para você ouvir seus amigos normalmente
            EnsureDiscordUnmutedForStreamer();
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

            if (chosenBrowser != null) {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = chosenBrowser;
                psi.Arguments = "--app=\\"" + url + "\\" --user-data-dir=\\"" + profileDir + "\\" --enable-features=ApplicationAudioCaptureWin --disable-features=BlockInsecurePrivateNetworkRequests --autoplay-policy=no-user-gesture-required";
                psi.UseShellExecute = false;
                Process appProc = Process.Start(psi);
                if (appProc != null) appProc.WaitForExit();
            } else {
                Process.Start(url);
                Thread.Sleep(3600000);
            }
        }
    }
}
`.trim();

  const installerCmd = `@echo off
chcp 65001 >nul
title Instalador Telinha Vogels Desktop
echo ========================================================
echo   TELINHA VOGELS - INSTALADOR DESKTOP OFICIAL (WINDOWS)
echo ========================================================
echo.
echo [1/3] Encerrando instancias antigas e preparando captura WASAPI...
taskkill /F /IM TelinhaVogels.exe >nul 2>&1

set "APP_DIR=%LOCALAPPDATA%\\TelinhaVogels"
if not exist "%APP_DIR%" mkdir "%APP_DIR%"

copy /Y "%~dp0TelinhaVogels.cs" "%APP_DIR%\\TelinhaVogels.cs" >nul

set "CSC=%WINDIR%\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"

echo [2/3] Compilando executavel nativo (Sem alerta SmartScreen)...
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