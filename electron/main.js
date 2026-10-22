const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, Notification, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const dns = require('dns');
const { exec } = require('child_process');

const DEV_URL = process.env.ELECTRON_START_URL || 'http://localhost:3000';
const isDev = process.env.NODE_ENV === 'development' || !!process.env.ELECTRON_START_URL;
const DATA_FILE     = path.join(app.getPath('userData'), 'ip-profiles.json');
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const HISTORY_FILE  = path.join(app.getPath('userData'), 'history.json');

const VERSION = app.getVersion() || '1.0.0';

let mainWindow = null;
let tray = null;
let isQuiting = false;

// ─── SETTINGS ────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  minimizeToTray: true,
  closeToTray: true,
  startMinimized: false,
  startWithWindows: false,
  showNotifications: true,
  watchNotifications: true,
  watchInterval: 15,
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8')) };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf-8'); return true; }
  catch { return false; }
}
let settings = loadSettings();

// ─── HISTORIAL ───────────────────────────────────────────────────────────────
const MAX_HISTORY = 100;
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {}
  return [];
}
function saveHistory(arr) {
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr.slice(0, MAX_HISTORY), null, 2), 'utf-8'); }
  catch {}
}
function pushHistory(entry) {
  const list = loadHistory();
  list.unshift({ ts: Date.now(), ...entry });
  saveHistory(list);
}

// ─── PERFILES ────────────────────────────────────────────────────────────────
function loadProfiles() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {}
  return null;
}

// ─── ICONO TRAY (generado en runtime) ────────────────────────────────────────
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function makeTrayIconPng(color = [16, 185, 129]) {
  // Patrón 16x16 de un mini-logo de red
  const P = [
    "0000001111000000",
    "0000011111100000",
    "0000011111100000",
    "0000001111000000",
    "0000000110000000",
    "0000000110000000",
    "0000000110000000",
    "0000000110000000",
    "0001100000011000",
    "0011110000111100",
    "0111111001111110",
    "0111111001111110",
    "0011110001111100",
    "0001100000011000",
    "0000000000000000",
    "0000000000000000",
  ];
  const size = 16;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      if (P[y][x] === '1') {
        raw[o++] = color[0]; raw[o++] = color[1]; raw[o++] = color[2]; raw[o++] = 255;
      } else {
        raw[o++] = 0; raw[o++] = 0; raw[o++] = 0; raw[o++] = 0;
      }
    }
  }
  const compressed = zlib.deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const mkChunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  return Buffer.concat([sig, mkChunk('IHDR', ihdr), mkChunk('IDAT', compressed), mkChunk('IEND', Buffer.alloc(0))]);
}

// ─── VENTANA ────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#09090b',
    show: !settings.startMinimized,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const loadProd = () => mainWindow?.loadFile(path.join(__dirname, '..', 'build', 'index.html'));
  if (isDev) mainWindow.loadURL(DEV_URL).catch(loadProd);
  else loadProd();

  // Minimizar a tray (si está configurado)
  mainWindow.on('minimize', (e) => {
    if (settings.minimizeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Cerrar a tray (si está configurado)
  mainWindow.on('close', (e) => {
    if (!isQuiting && settings.closeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
      return false;
    }
  });

  if (settings.startMinimized && tray) mainWindow.hide();
}

// ─── TRAY ────────────────────────────────────────────────────────────────────
// Devuelve la IP "principal" del equipo: la del adaptador con puerta de enlace
// y métrica más baja. Antes se cogía la primera que devolviera Get-NetIPAddress,
// que en equipos con WSL, Hyper-V o VMware es casi siempre la de un adaptador
// virtual, así que el tray mostraba una IP que no era la del perfil aplicado.
async function getPrimaryIpInfo() {
  const data = await psJson(`
    $best = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Address } | ForEach-Object {
      $nif = Get-NetIPInterface -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1;
      [pscustomobject]@{
        alias  = [string]$_.InterfaceAlias;
        ips    = @($_.IPv4Address | Where-Object { $_.IPAddress -notlike '169.254.*' } | ForEach-Object { $_.IPAddress });
        hasGw  = [bool]($_.IPv4DefaultGateway);
        metric = $(if ($nif) { [int]$nif.InterfaceMetric } else { 9999 });
        dhcp   = ($nif.Dhcp -eq 'Enabled');
      }
    } | Where-Object { @($_.ips).Count -gt 0 } | Sort-Object @{ Expression = { if ($_.hasGw) { 0 } else { 1 } } }, metric) | Select-Object -First 1;
    if ($best) { ConvertTo-Json -InputObject $best -Compress -Depth 4 }
  `, 8000);

  if (!data) return null;
  const ips = (Array.isArray(data.ips) ? data.ips : [data.ips]).filter(isValidIp);
  if (ips.length === 0) return null;
  return { alias: data.alias || null, ip: ips[0], ips, dhcp: !!data.dhcp };
}

let trayMenuBuilding = false;
let trayMenuQueued = false;

// Antes esto era execSync: bloqueaba el proceso principal hasta 2,5 s cada vez
// que se guardaba un perfil o se aplicaba una IP, y la ventana se congelaba.
async function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  if (trayMenuBuilding) { trayMenuQueued = true; return; }
  trayMenuBuilding = true;
  try {
    const profiles = loadProfiles() || [];
    const info = await getPrimaryIpInfo();
    const currentIp = info?.ip || null;
    const currentIps = info?.ips || [];
    const isDhcp = !!info?.dhcp;

    if (!tray || tray.isDestroyed()) return;

    const profileItems = profiles.length === 0
      ? [{ label: 'Sin perfiles', enabled: false }]
      : profiles.map(p => ({
          label: `${p.name} — ${p.ip}`,
          type: 'checkbox',
          // Se compara contra todas las IPs del adaptador, igual que la ventana:
          // antes el tray exigía además que no fuera DHCP y marcaba otro perfil
          // (o ninguno) del que mostraba la UI.
          checked: currentIps.includes(p.ip),
          click: () => {
            mainWindow?.webContents.send('tray-activate-profile', p.id);
            showWindow();
          },
        }));

    const statusLabel = currentIp
      ? `IP actual: ${currentIp}${isDhcp ? '  (DHCP)' : '  (estática)'}${info?.alias ? '  ·  ' + info.alias : ''}`
      : 'Sin IP detectada';

    const contextMenu = Menu.buildFromTemplate([
      { label: statusLabel, enabled: false },
      { type: 'separator' },
      { label: 'Mostrar ventana', click: () => showWindow() },
      { label: 'Quick switcher (Ctrl+Shift+Space)', click: () => {
        showWindow();
        mainWindow?.webContents.send('open-quick-switcher');
      }},
      { type: 'separator' },
      { label: 'Perfiles', enabled: false },
      ...profileItems,
      { type: 'separator' },
      { label: 'Volver a DHCP', click: () => {
        mainWindow?.webContents.send('tray-apply-dhcp');
        showWindow();
      }},
      { type: 'separator' },
      { label: 'Salir', click: () => { isQuiting = true; app.quit(); } },
    ]);

    tray.setContextMenu(contextMenu);
    tray.setToolTip(`IP Switcher${currentIp ? ' · ' + currentIp + (isDhcp ? ' (DHCP)' : '') : ''}`);
  } catch (e) {
    console.error('Error construyendo el menú del tray:', e);
  } finally {
    trayMenuBuilding = false;
    if (trayMenuQueued) { trayMenuQueued = false; buildTrayMenu(); }
  }
}


function createTray() {
  try {
    const iconBuffer = makeTrayIconPng();
    const icon = nativeImage.createFromBuffer(iconBuffer);
    tray = new Tray(icon);
    tray.setToolTip('IP Switcher');
    tray.on('click', () => toggleWindow());
    tray.on('double-click', () => showWindow());
    buildTrayMenu();
  } catch (e) {
    console.error('Error creando tray:', e);
  }
}

function showWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide();
  else showWindow();
}

// ─── AUTOSTART ──────────────────────────────────────────────────────────────
function applyAutoStart(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      args: settings.startMinimized ? ['--hidden'] : [],
    });
  } catch {}
}

// ─── GLOBAL SHORTCUT ────────────────────────────────────────────────────────
function registerShortcuts() {
  try {
    globalShortcut.register('Control+Shift+Space', () => {
      showWindow();
      mainWindow?.webContents.send('open-quick-switcher');
    });
  } catch (e) {
    console.error('No se pudo registrar shortcut global:', e);
  }
}

// ─── APP LIFECYCLE ──────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(() => {
    createTray();
    createWindow();
    registerShortcuts();
    if (settings.startWithWindows) applyAutoStart(true);
  });
}

app.on('window-all-closed', () => {
  // Solo sobrevive sin ventanas si hay tray; si createTray() falló, la app
  // se quedaba corriendo invisible y sin forma de cerrarla.
  if (!tray || tray.isDestroyed()) app.quit();
});
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(); });
app.on('before-quit', () => { isQuiting = true; });
app.on('will-quit', () => { stopWatcher(); globalShortcut.unregisterAll(); });

// ═══ HELPERS DE EJECUCIÓN ═══════════════════════════════════════════════════

function psEscape(str) { return String(str).replace(/'/g, "''"); }

// PowerShell se invoca SIEMPRE con -EncodedCommand (base64 UTF-16LE).
// Antes se interpolaba el script dentro de "..." pasando por cmd.exe, lo que
// rompía con nombres de adaptador que llevan comillas, &, ^, % o acentos
// (p. ej. "Conexión de área local 2") y hacía que la IP no se leyera ni se
// aplicara. Además se fija la salida a UTF-8: con la codepage OEM (850/1252)
// los nombres acentuados llegaban corruptos a JSON.parse.
const PS_PRELUDE =
  "$ErrorActionPreference='Stop';" +
  "$ProgressPreference='SilentlyContinue';" +
  "try{[Console]::OutputEncoding=[System.Text.Encoding]::UTF8}catch{};";

function psEncode(script) {
  return Buffer.from(PS_PRELUDE + script, 'utf16le').toString('base64');
}

function execAsync(cmd, timeout = 5000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// Ejecuta un script de PowerShell. Nunca rechaza: devuelve { ok, stdout }.
function psAsync(script, timeout = 8000) {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(script)}`,
      { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '').trim() })
    );
  });
}

// Igual que psAsync pero devolviendo JSON ya parseado (null si falla).
async function psJson(script, timeout = 8000) {
  const { stdout } = await psAsync(script, timeout);
  if (!stdout) return null;
  try { return JSON.parse(stdout); } catch { return null; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Pool de concurrencia. El escáner lanzaba 254 procesos ping a la vez (y 40
// PowerShell para los hostnames): en Windows eso satura la cola de creación de
// procesos, los ping se quedan sin ejecutar o los mata el timeout, y el barrido
// salía incompleto y distinto en cada pasada. Ahora va por tandas.
async function mapPool(items, limit, fn, shouldAbort) {
  const list = [...items];
  const out = new Array(list.length);
  let next = 0;
  const workers = new Array(Math.max(1, Math.min(limit, list.length))).fill(0).map(async () => {
    while (true) {
      if (shouldAbort && shouldAbort()) return;
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Validadores de red (el renderer valida, pero el main no se fía) ──────────
function isValidIp(s) {
  if (typeof s !== 'string') return false;
  const parts = s.trim().split('.');
  if (parts.length !== 4) return false;
  return parts.every(p => /^(0|[1-9][0-9]{0,2})$/.test(p) && +p <= 255);
}
function ipToInt(s) {
  return s.trim().split('.').reduce((a, o) => ((a << 8) + (+o)) >>> 0, 0) >>> 0;
}
function intToIp(n) {
  return [24, 16, 8, 0].map(sh => (n >>> sh) & 255).join('.');
}
function isValidMask(s) {
  if (!isValidIp(s)) return false;
  const n = ipToInt(s);
  return n !== 0 && ((~n >>> 0) & (((~n >>> 0) + 1) >>> 0)) === 0;
}
function maskToPrefix(mask) {
  if (!isValidMask(mask)) return null;
  return ipToInt(mask).toString(2).split('1').length - 1;
}
function prefixToMask(prefix) {
  const p = parseInt(prefix, 10);
  if (!(p >= 0 && p <= 32)) return null;
  return intToIp(p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0);
}
// Rechaza dirección de red y de broadcast: netsh las acepta a veces sin error
// y la interfaz se queda sin conectividad, que era uno de los casos de
// "apliqué la IP y no la coge".
function ipRoleInSubnet(ip, mask) {
  if (!isValidIp(ip) || !isValidMask(mask)) return 'unknown';
  const prefix = maskToPrefix(mask);
  if (prefix >= 31) return 'host';
  const m = ipToInt(mask), v = ipToInt(ip);
  if ((v & ~m) === 0) return 'network';
  if (((v & ~m) >>> 0) === ((~m) >>> 0)) return 'broadcast';
  return 'host';
}
function sameSubnet(a, b, mask) {
  if (!isValidIp(a) || !isValidIp(b) || !isValidMask(mask)) return true;
  const m = ipToInt(mask);
  return (ipToInt(a) & m) === (ipToInt(b) & m);
}

function runElevatedBatch(commands) {
  return new Promise((resolve) => {
    const list = (Array.isArray(commands) ? commands : []).filter(c => typeof c === 'string' && c.trim());
    if (list.length === 0) return resolve({ launched: false, codes: [], stdout: '', stderr: 'Sin comandos' });

    const tmpDir = os.tmpdir();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const batPath = path.join(tmpDir, `ipsw_${id}.bat`);
    const outPath = path.join(tmpDir, `ipsw_${id}.out`);
    const errPath = path.join(tmpDir, `ipsw_${id}.err`);

    // El .bat abortaba en el primer errorlevel != 0. Como el comando de DNS va
    // detrás del de la IP, un DNS que Windows rechaza (muy habitual) hacía que
    // la operación entera se reportase como fallida aunque la IP ya estuviera
    // puesta. Ahora cada comando deja su código de salida en el fichero de
    // salida y es JS quien decide qué es crítico (la IP) y qué no (el DNS).
    const lines = ['@echo off', 'chcp 65001 >nul'];
    list.forEach((cmd, i) => {
      const redir = i === 0 ? `> "${outPath}" 2> "${errPath}"` : `>> "${outPath}" 2>> "${errPath}"`;
      lines.push(`${cmd} ${redir}`);
      // Redirección delante a propósito: en "echo ... %errorlevel%>>f" cmd
      // interpreta el dígito final como el handle 1 y se come el código.
      lines.push(`>> "${outPath}" echo ##RC ${i}=%errorlevel%`);
    });
    lines.push('exit /b 0', '');

    try { fs.writeFileSync(batPath, lines.join('\r\n'), { encoding: 'utf8' }); }
    catch (e) { return resolve({ launched: false, codes: [], stdout: '', stderr: e.message }); }

    const cleanup = () => {
      try { fs.unlinkSync(batPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
      try { fs.unlinkSync(errPath); } catch {}
    };

    const launcher = [
      'try {',
      `  $p = Start-Process -FilePath '${psEscape(batPath)}' -Verb RunAs -WindowStyle Hidden -PassThru -Wait;`,
      '  if ($p) { try { $p.WaitForExit() } catch {}; Write-Output ("RC=" + $p.ExitCode) }',
      '  else { Write-Output "RC=0" }',
      '} catch { Write-Output "UAC_CANCEL" }',
    ].join('\n');

    // 180 s en vez de 60: el diálogo de UAC puede quedarse esperando al usuario
    // y antes se mataba PowerShell dejando el .bat a medias.
    exec(
      `powershell -NoProfile -NonInteractive -EncodedCommand ${psEncode(launcher)}`,
      { windowsHide: true, timeout: 180000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const result = String(stdout || '').trim();
        const readFile = p => { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } };
        const outRaw = readFile(outPath);
        const errContent = readFile(errPath).trim();
        cleanup();

        const codes = [];
        for (const m of outRaw.matchAll(/##RC\s+(\d+)=(-?\d+)/g)) codes[Number(m[1])] = Number(m[2]);
        const outContent = outRaw.replace(/^.*##RC\s+\d+=-?\d+.*$/gm, '').trim();

        if (/UAC_CANCEL/.test(result)) {
          return resolve({ launched: false, cancelled: true, codes, stdout: outContent, stderr: 'Operación cancelada por el usuario (UAC).' });
        }
        if (!/RC=/.test(result)) {
          return resolve({ launched: false, codes, stdout: outContent, stderr: errContent || String(stderr || '').trim() || (err && err.message) || 'No se pudo elevar el proceso' });
        }
        return resolve({ launched: true, codes, stdout: outContent, stderr: errContent });
      }
    );
  });
}

// netsh acepta un índice de interfaz en name=, así que se usa el índice siempre
// que se conoce: el nombre del adaptador pasaba por cmd.exe y rompía con
// acentos, comillas o & (p. ej. "Conexión de área local 2"), y ese era uno de
// los motivos de que "aplicar IP" no hiciera nada.
function netshTarget(index, adapter) {
  if (index != null && Number.isFinite(Number(index))) return String(Number(index));
  return `"${String(adapter).replace(/"/g, '')}"`;
}

const ADAPTER_BAD = /(loopback|tunnel|teredo|isatap|wan miniport|bluetooth pan|hyper-v virtual switch|hyper-v virtual ethernet)/i;
// Estos solo se descartan si queda al menos un adaptador "físico": dentro de
// una VM la NIC buena ES la de VMware/VirtualBox, y entonces no se filtra nada.
const ADAPTER_VIRTUAL = /(tap-windows|tap adapter|npcap|pptp|sstp|l2tp|openvpn|wireguard|tailscale|zerotier|vethernet|hyper-v|vmware|virtualbox|wsl|docker)/i;

async function getAdaptersAsync() {
  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter(a => { if (!a.name || seen.has(a.name)) return false; seen.add(a.name); return true; });
  };

  // Intento 1 — Get-NetAdapter + configuración IPv4 en una sola pasada. Se
  // devuelve el ifIndex, la métrica y si tiene gateway, y se ordena de "más
  // probable que sea la NIC real" a menos: antes se usaba el orden que diera
  // Windows y la app acababa leyendo/escribiendo la IP en un adaptador virtual
  // (vEthernet de WSL, VMware host-only...), con lo que la IP aplicada no
  // aparecía nunca en pantalla.
  const script = `
    $out = @();
    foreach ($a in @(Get-NetAdapter -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' })) {
      $cfg = Get-NetIPConfiguration -InterfaceIndex $a.ifIndex -ErrorAction SilentlyContinue;
      $nif = Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1;
      $ip  = $cfg.IPv4Address | Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1;
      $out += [pscustomobject]@{
        name        = $a.Name;
        description = $a.InterfaceDescription;
        index       = [int]$a.ifIndex;
        mediaType   = [string]$a.MediaType;
        virtual     = [bool]$a.Virtual;
        metric      = $(if ($nif) { [int]$nif.InterfaceMetric } else { 9999 });
        dhcp        = ($nif.Dhcp -eq 'Enabled');
        ip          = $ip.IPAddress;
        prefix      = $ip.PrefixLength;
        gateway     = ($cfg.IPv4DefaultGateway | Select-Object -First 1).NextHop;
      };
    }
    ConvertTo-Json -InputObject @($out) -Compress -Depth 4
  `;

  const raw = await psJson(script, 12000);
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  let filtered = list.filter(a => a && a.name && !ADAPTER_BAD.test(a.name) && !ADAPTER_BAD.test(a.description || ''));
  const physical = filtered.filter(a => !ADAPTER_VIRTUAL.test(a.name) && !ADAPTER_VIRTUAL.test(a.description || ''));
  if (physical.length > 0) filtered = physical;

  const score = (a) => (a.gateway ? 0 : 2000) + (a.ip ? 0 : 1000) + (a.virtual ? 200 : 0) +
                       (Number.isFinite(a.metric) ? Math.min(Math.max(a.metric, 0), 199) : 199);
  filtered.sort((x, y) => score(x) - score(y) || String(x.name).localeCompare(String(y.name)));

  const result = dedup(filtered.map(a => ({
    name: a.name,
    description: a.description || '',
    index: Number.isFinite(a.index) ? a.index : null,
    mediaType: a.mediaType || '',
    virtual: !!a.virtual,
    ip: isValidIp(a.ip) ? a.ip : null,
    prefix: Number.isFinite(a.prefix) ? a.prefix : null,
    gateway: isValidIp(a.gateway) ? a.gateway : null,
    dhcp: !!a.dhcp,
  })));
  if (result.length > 0) return result;

  // Intento 2 — netsh como fallback
  try {
    const { stdout } = await execAsync('netsh interface show interface', 4000);
    const adapters = [];
    for (const l of stdout.split('\n')) {
      if (!/connected|conectado/i.test(l)) continue;
      if (/disconnected|desconectado/i.test(l)) continue;
      const parts = l.trim().split(/\s{2,}/);
      const name = parts[parts.length - 1]?.trim();
      if (name && !ADAPTER_BAD.test(name)) {
        adapters.push({ name, description: '', index: null, mediaType: '', virtual: false, ip: null, prefix: null, gateway: null, dhcp: false });
      }
    }
    if (adapters.length > 0) return dedup(adapters);
  } catch {}

  // Intento 3 — ipconfig /all como último recurso
  try {
    const { stdout } = await execAsync('ipconfig /all', 4000);
    const adapters = [];
    const blocks = stdout.split(/\r?\n(?=[A-ZÁÉÍÓÚ].*adapter|Adaptador)/);
    for (const block of blocks) {
      const headerMatch = block.match(/(?:adapter|Adaptador)\s+([^:]+):/i);
      if (!headerMatch) continue;
      const name = headerMatch[1].trim();
      if (!name || ADAPTER_BAD.test(name)) continue;
      if (/IPv4|IP Address|Dirección IPv4/i.test(block)) {
        adapters.push({ name, description: '', index: null, mediaType: '', virtual: false, ip: null, prefix: null, gateway: null, dhcp: false });
      }
    }
    return dedup(adapters);
  } catch { return []; }
}

// Cache de IP actual
const ipCache = new Map();
const CACHE_MS = 1500;

async function readIpConfig(adapter) {
  const fail = { success: false, ip: null, ips: [], dhcp: false };
  if (!adapter) return fail;

  const script = `
    $alias = '${psEscape(adapter)}';
    $nif = Get-NetIPInterface -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object -First 1;
    if (-not $nif) { Write-Output '{"found":false}'; exit 0 }
    $cfg = Get-NetIPConfiguration -InterfaceIndex $nif.InterfaceIndex -ErrorAction SilentlyContinue;
    $addrs = @($cfg.IPv4Address | ForEach-Object {
      [pscustomobject]@{ ip = $_.IPAddress; prefix = [int]$_.PrefixLength; state = [string]$_.AddressState; origin = [string]$_.SuffixOrigin }
    });
    $res = [pscustomobject]@{
      found     = $true;
      index     = [int]$nif.InterfaceIndex;
      dhcp      = ($nif.Dhcp -eq 'Enabled');
      addresses = $addrs;
      gateway   = ($cfg.IPv4DefaultGateway | Select-Object -First 1).NextHop;
      dns       = @($cfg.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses });
    };
    ConvertTo-Json -InputObject $res -Compress -Depth 5
  `;

  const data = await psJson(script, 9000);
  if (!data || !data.found) return fail;

  const addrs = Array.isArray(data.addresses) ? data.addresses : (data.addresses ? [data.addresses] : []);
  const usable = addrs.filter(a => a && isValidIp(a.ip));
  const routable = usable.filter(a => !String(a.ip).startsWith('169.254.'));
  // Antes se cogía siempre la primera dirección que devolviera Windows. Si el
  // adaptador arrastraba una APIPA (169.254.x.x) o una segunda IP, la app
  // mostraba esa y el perfil recién aplicado no se reconocía como activo.
  const pool = routable.length ? routable : usable;
  const preferred = pool.find(a => a.state === 'Preferred') || pool[0] || null;
  const dnsRaw = Array.isArray(data.dns) ? data.dns : (data.dns ? [data.dns] : []);

  return {
    success: true,
    index: Number.isFinite(data.index) ? data.index : null,
    ip: preferred ? preferred.ip : null,
    ips: pool.map(a => a.ip),
    allIps: usable.map(a => a.ip),
    prefix: preferred && Number.isFinite(preferred.prefix) ? preferred.prefix : null,
    mask: preferred ? prefixToMask(preferred.prefix) : null,
    gateway: isValidIp(data.gateway) ? data.gateway : null,
    dns: [...new Set(dnsRaw.filter(isValidIp))],
    dhcp: !!data.dhcp,
    // Útil para avisar en la UI: DHCP activo pero sin servidor que responda.
    apipa: routable.length === 0 && usable.length > 0,
  };
}

async function getIpConfigAsync(adapter, { fresh = false } = {}) {
  if (!adapter) return { success: false, ip: null, ips: [], dhcp: false };
  if (!fresh) {
    const cached = ipCache.get(adapter);
    if (cached && Date.now() - cached.ts < CACHE_MS) return cached.data;
  }
  const result = await readIpConfig(adapter);
  // El adaptador puede haber desaparecido (cambio de red): no cachear fallos.
  if (result.success) ipCache.set(adapter, { data: result, ts: Date.now() });
  else ipCache.delete(adapter);
  return result;
}

async function getInterfaceIndex(adapter) {
  if (!adapter) return null;
  const cfg = await getIpConfigAsync(adapter);
  if (cfg.success && Number.isFinite(cfg.index)) return cfg.index;
  const data = await psJson(
    `$a = Get-NetAdapter -Name '${psEscape(adapter)}' -ErrorAction SilentlyContinue | Select-Object -First 1;
     ConvertTo-Json -InputObject @{ index = $(if ($a) { [int]$a.ifIndex } else { -1 }) } -Compress`,
    6000
  );
  return data && Number.isFinite(data.index) && data.index >= 0 ? data.index : null;
}

// Verificación post-netsh. netsh puede devolver 0 sin haber aplicado nada, o
// Windows puede tardar un par de segundos en publicar la dirección; antes la UI
// releía la IP una sola vez a los 600 ms, veía la vieja y la dejaba así hasta el
// siguiente sondeo de 10 s: de ahí el "aplico la IP y no la coge".
async function waitForIp(adapter, expectedIp, timeoutMs = 10000) {
  const started = Date.now();
  let delay = 200;
  while (true) {
    const cfg = await getIpConfigAsync(adapter, { fresh: true });
    if (cfg.success && Array.isArray(cfg.ips) && cfg.ips.includes(expectedIp)) {
      return { ok: true, ip: cfg.ip, cfg };
    }
    if (Date.now() - started >= timeoutMs) return { ok: false, ip: cfg.ip || null, cfg };
    await sleep(delay);
    delay = Math.min(delay + 200, 900);
  }
}

async function waitForDhcp(adapter, timeoutMs = 15000) {
  const started = Date.now();
  let delay = 300;
  while (true) {
    const cfg = await getIpConfigAsync(adapter, { fresh: true });
    if (cfg.success && cfg.dhcp && cfg.ip && !cfg.apipa) return { ok: true, ip: cfg.ip, cfg };
    if (Date.now() - started >= timeoutMs) {
      // Tener DHCP activado cuenta como éxito aunque el servidor no conteste aún.
      return { ok: !!(cfg.success && cfg.dhcp), ip: cfg.ip || null, cfg, noLease: true };
    }
    await sleep(delay);
    delay = Math.min(delay + 300, 1200);
  }
}

function invalidateCache(adapter) { if (adapter) ipCache.delete(adapter); }
function purgeCache() { ipCache.clear(); }


// ═══ IPC HANDLERS ═══════════════════════════════════════════════════════════

ipcMain.handle('load-profiles', () => loadProfiles());

ipcMain.handle('save-profiles', (_, data) => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8'); buildTrayMenu(); return true; }
  catch { return false; }
});

ipcMain.handle('get-adapters', () => { purgeCache(); return getAdaptersAsync(); });

ipcMain.handle('apply-ip', async (_, payload) => {
  const { adapter, ip, mask, gateway, dns, dns2, profileName } = payload || {};

  // Validación en el proceso principal: antes solo se comprobaba que los campos
  // no estuvieran vacíos y se le pasaba a netsh cualquier cosa, que fallaba con
  // un mensaje ininteligible o la aceptaba dejando la interfaz sin red.
  if (!adapter) return { success: false, error: 'No hay adaptador seleccionado' };
  if (!isValidIp(ip)) return { success: false, error: `IP inválida: ${ip ?? '(vacía)'}` };
  if (!isValidMask(mask)) return { success: false, error: `Máscara inválida: ${mask ?? '(vacía)'}` };

  const role = ipRoleInSubnet(ip, mask);
  if (role === 'network') return { success: false, error: `${ip} es la dirección de red de /${maskToPrefix(mask)}; Windows no la admite como IP de host` };
  if (role === 'broadcast') return { success: false, error: `${ip} es la dirección de broadcast de /${maskToPrefix(mask)}; Windows no la admite como IP de host` };
  if (gateway && !isValidIp(gateway)) return { success: false, error: `Gateway inválido: ${gateway}` };
  if (gateway && gateway === ip) return { success: false, error: 'El gateway no puede ser la propia IP' };
  if (dns && !isValidIp(dns)) return { success: false, error: `DNS primario inválido: ${dns}` };
  if (dns2 && !isValidIp(dns2)) return { success: false, error: `DNS secundario inválido: ${dns2}` };

  const index = await getInterfaceIndex(adapter);
  const target = netshTarget(index, adapter);

  // Parámetros con nombre (address=, mask=, gateway=) en vez de posicionales, y
  // validate=no en el DNS: la validación de netsh bloquea varios segundos y
  // devuelve error si el servidor DNS no contesta todavía.
  const commands = [];
  let addrCmd = `netsh interface ipv4 set address name=${target} source=static address=${ip} mask=${mask}`;
  if (gateway) addrCmd += ` gateway=${gateway} gwmetric=1`;
  commands.push(addrCmd);
  if (dns) {
    commands.push(`netsh interface ipv4 set dnsservers name=${target} source=static address=${dns} register=primary validate=no`);
    if (dns2) commands.push(`netsh interface ipv4 add dnsservers name=${target} address=${dns2} index=2 validate=no`);
  } else {
    commands.push(`netsh interface ipv4 set dnsservers name=${target} source=dhcp`);
  }

  const fail = (error, extra = {}) => {
    pushHistory({ action: 'apply', adapter, ip, profileName: profileName || null, success: false, error });
    return { success: false, error, ...extra };
  };

  try {
    const r = await runElevatedBatch(commands);
    invalidateCache(adapter);

    if (!r.launched) {
      return fail(r.stderr || 'No se pudo ejecutar netsh como administrador', { cancelled: !!r.cancelled });
    }

    const addrCode = r.codes[0];
    const verified = await waitForIp(adapter, ip, 10000);

    if (!verified.ok) {
      const netshMsg = [r.stderr, r.stdout]
        .map(t => String(t || '').split('\n').map(l => l.trim()).filter(Boolean).pop())
        .find(Boolean);
      if (addrCode !== 0) {
        return fail(netshMsg || `netsh devolvió el código ${addrCode} al fijar la IP`);
      }
      // netsh dijo que todo fue bien pero el adaptador no tiene la IP: pasaba al
      // aplicar sobre un adaptador equivocado o cuando otra interfaz ya usaba
      // esa dirección. Antes se reportaba éxito y la UI seguía con la IP vieja.
      return fail(
        `netsh no dio error pero "${adapter}" sigue en ${verified.ip || 'sin IP'}. ` +
        `Comprueba que es el adaptador correcto y que ${ip} no está en uso.`
      );
    }

    // El DNS es "mejor esfuerzo": si falla, la IP ya está aplicada y se avisa.
    const dnsFailed = r.codes.slice(1).some(c => typeof c === 'number' && c !== 0);
    const avisos = [];
    if (dnsFailed) avisos.push('Windows rechazó la configuración de DNS');
    // Un gateway fuera de la subred se aplica pero no encamina nada, y netsh no
    // siempre se queja: mejor decirlo claro que dejar al usuario sin internet.
    if (gateway && !sameSubnet(ip, gateway, mask)) avisos.push(`el gateway ${gateway} no está en la subred de ${ip}/${maskToPrefix(mask)}`);
    if (gateway && verified.cfg?.gateway && verified.cfg.gateway !== gateway) avisos.push(`Windows no aplicó el gateway ${gateway}`);
    const warning = avisos.length ? avisos.join(' · ') : null;

    pushHistory({ action: 'apply', adapter, ip, profileName: profileName || null, success: true, error: null });
    buildTrayMenu();
    if (settings.showNotifications && Notification.isSupported()) {
      new Notification({ title: 'IP Switcher', body: `IP ${ip} aplicada en "${adapter}"${profileName ? ' · ' + profileName : ''}`, silent: true }).show();
    }
    return { success: true, verified: true, ip: verified.ip, config: verified.cfg, warning };
  } catch (err) {
    return fail(err.message);
  }
});

ipcMain.handle('set-dhcp', async (_, adapter) => {
  if (!adapter) return { success: false, error: 'Adaptador no especificado' };
  const index = await getInterfaceIndex(adapter);
  const target = netshTarget(index, adapter);

  const fail = (error, extra = {}) => {
    pushHistory({ action: 'dhcp', adapter, success: false, error });
    return { success: false, error, ...extra };
  };

  try {
    const r = await runElevatedBatch([
      `netsh interface ipv4 set address name=${target} source=dhcp`,
      `netsh interface ipv4 set dnsservers name=${target} source=dhcp`,
    ]);
    invalidateCache(adapter);

    if (!r.launched) {
      return fail(r.stderr || 'No se pudo ejecutar netsh como administrador', { cancelled: !!r.cancelled });
    }

    const v = await waitForDhcp(adapter, 15000);
    if (!v.ok) {
      const netshMsg = [r.stderr, r.stdout]
        .map(t => String(t || '').split('\n').map(l => l.trim()).filter(Boolean).pop())
        .find(Boolean);
      return fail(netshMsg || `No se pudo activar DHCP en "${adapter}"`);
    }

    const warning = v.noLease
      ? 'DHCP activado, pero el servidor todavía no ha dado dirección'
      : null;

    pushHistory({ action: 'dhcp', adapter, success: true, error: null });
    buildTrayMenu();
    if (settings.showNotifications && Notification.isSupported()) {
      new Notification({ title: 'IP Switcher', body: `"${adapter}" vuelto a DHCP`, silent: true }).show();
    }
    return { success: true, ip: v.ip, config: v.cfg, warning };
  } catch (err) {
    return fail(err.message);
  }
});

ipcMain.handle('get-current-ip', async (_, adapter) => {
  const cfg = await getIpConfigAsync(adapter);
  return { success: cfg.success, ip: cfg.ip || null, ips: cfg.ips || [] };
});

ipcMain.handle('get-ip-config', (_, adapter, opts) => getIpConfigAsync(adapter, opts || {}));

// ─── Capturar configuración actual como perfil ──────────────────────────────
ipcMain.handle('capture-current', async (_, adapter) => {
  const cfg = await getIpConfigAsync(adapter, { fresh: true });
  if (!cfg.success || !cfg.ip) return { success: false, error: 'No hay IP detectada en este adaptador' };
  if (cfg.apipa) return { success: false, error: 'El adaptador solo tiene una dirección 169.254.x.x (DHCP sin respuesta)' };

  return {
    success: true,
    data: {
      ip: cfg.ip,
      mask: cfg.mask || prefixToMask(cfg.prefix) || '255.255.255.0',
      gateway: cfg.gateway || '',
      dns: cfg.dns?.[0] || '',
      dns2: cfg.dns?.[1] || '',
    },
  };
});

// ─── Ping test ───────────────────────────────────────────────────────────────
ipcMain.handle('ping-test', async (_, payload) => {
  const { gateway, dns: dnsServer } = payload || {};
  const pingOne = async (host) => {
    if (!isValidIp(host)) return null;
    try {
      const { stdout } = await execAsync(`ping -4 -n 2 -w 1500 ${host}`, 8000);
      const match = stdout.match(/(?:Average|Media|promedio)\s*=\s*(\d+)\s*ms/i);
      if (match) return { success: true, latency: parseInt(match[1], 10) };
      if (/TTL=|bytes=/i.test(stdout)) return { success: true, latency: null };
      return { success: false };
    } catch { return { success: false }; }
  };

  const [gwResult, dnsResult, internetResult] = await Promise.all([
    pingOne(gateway),
    pingOne(dnsServer),
    pingOne('8.8.8.8'),
  ]);

  return { gateway: gwResult, dns: dnsResult, internet: internetResult };
});

// ─── Import / Export ────────────────────────────────────────────────────────
ipcMain.handle('export-profiles', async (_, profiles) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Exportar perfiles',
    defaultPath: `ip-switcher-profiles-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(filePath, JSON.stringify({ version: VERSION, exported: new Date().toISOString(), profiles }, null, 2), 'utf-8');
    return { success: true, path: filePath };
  } catch (e) { return { success: false, error: e.message }; }
});

ipcMain.handle('import-profiles', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Importar perfiles',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths?.[0]) return { success: false, canceled: true };
  try {
    const raw = fs.readFileSync(filePaths[0], 'utf-8');
    const data = JSON.parse(raw);
    const profiles = Array.isArray(data) ? data : data.profiles;
    if (!Array.isArray(profiles)) return { success: false, error: 'Formato JSON inválido' };
    return { success: true, profiles };
  } catch (e) { return { success: false, error: e.message }; }
});

// ─── Settings / autostart ───────────────────────────────────────────────────
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', (_, newSettings) => {
  const oldStartWithWindows = settings.startWithWindows;
  const oldInterval = settings.watchInterval;
  settings = { ...settings, ...newSettings };
  saveSettings(settings);
  if (oldStartWithWindows !== settings.startWithWindows) applyAutoStart(settings.startWithWindows);
  // Re-arrancar watcher si el intervalo cambió y hay uno activo
  if (oldInterval !== settings.watchInterval && watchProfile) startWatcher(watchProfile);
  return settings;
});

// ─── Historial ──────────────────────────────────────────────────────────────
ipcMain.handle('get-history', () => loadHistory());
ipcMain.handle('clear-history', () => { saveHistory([]); return true; });

// ─── Escáner de red ─────────────────────────────────────────────────────────
// OUI prefix → vendor (los ~100 más comunes)
const OUI_VENDORS = {
  '00:00:0C':'Cisco','00:01:42':'Cisco','00:01:43':'Cisco','00:03:6B':'Cisco','00:05:DC':'Cisco','00:0B:BE':'Cisco',
  '00:03:93':'Apple','00:05:02':'Apple','00:0A:27':'Apple','00:0D:93':'Apple','00:14:51':'Apple','00:16:CB':'Apple',
  '00:17:F2':'Apple','00:1B:63':'Apple','00:1E:52':'Apple','00:1E:C2':'Apple','00:1F:5B':'Apple','00:1F:F3':'Apple',
  '00:21:E9':'Apple','00:22:41':'Apple','00:23:12':'Apple','00:23:32':'Apple','00:23:DF':'Apple','00:24:36':'Apple',
  '00:25:00':'Apple','00:25:4B':'Apple','00:25:BC':'Apple','00:26:08':'Apple','00:26:4A':'Apple','00:26:B0':'Apple',
  '00:26:BB':'Apple','00:3E:E1':'Apple','00:50:E4':'Apple','00:88:65':'Apple','00:A0:40':'Apple','00:C6:10':'Apple',
  '00:CD:FE':'Apple','00:F4:B9':'Apple','00:F7:6F':'Apple','04:0C:CE':'Apple','04:15:52':'Apple','04:1E:64':'Apple',
  '04:26:65':'Apple','04:48:9A':'Apple','04:4B:ED':'Apple','04:52:F3':'Apple','04:54:53':'Apple','04:69:F8':'Apple',
  '04:DB:56':'Apple','04:E5:36':'Apple','04:F1:3E':'Apple','04:F7:E4':'Apple','08:00:07':'Apple','08:66:98':'Apple',
  '08:6D:41':'Apple','08:70:45':'Apple','08:74:02':'Apple','0C:30:21':'Apple','0C:3E:9F':'Apple','0C:4D:E9':'Apple',
  '0C:74:C2':'Apple','0C:77:1A':'Apple','3C:22:FB':'Apple','3C:D0:F8':'Apple','BC:52:B7':'Apple','DC:A9:04':'Apple',
  'F0:18:98':'Apple','F4:37:B7':'Apple','F4:5C:89':'Apple',
  '00:03:47':'Intel','00:13:02':'Intel','00:15:17':'Intel','00:16:6F':'Intel','00:16:76':'Intel','00:16:EA':'Intel',
  '00:18:DE':'Intel','00:19:D1':'Intel','00:1B:21':'Intel','00:1B:77':'Intel','00:1C:BF':'Intel','00:1C:C0':'Intel',
  '00:1D:E0':'Intel','00:1D:E1':'Intel','00:1E:64':'Intel','00:1E:65':'Intel','00:1E:67':'Intel','00:1F:3B':'Intel',
  '00:1F:3C':'Intel','00:21:5C':'Intel','00:21:5D':'Intel','00:21:6A':'Intel','00:21:6B':'Intel','00:22:FA':'Intel',
  '00:22:FB':'Intel','00:23:14':'Intel','00:23:15':'Intel','00:24:D6':'Intel','00:24:D7':'Intel','00:26:C6':'Intel',
  '00:26:C7':'Intel','00:27:0E':'Intel','00:27:10':'Intel','00:50:F1':'Intel','00:A0:C9':'Intel','00:AA:01':'Intel',
  '00:D0:B7':'Intel','00:DB:DF':'Intel','10:0B:A9':'Intel','10:4A:7D':'Intel','1C:3E:84':'Intel','1C:4D:70':'Intel',
  '24:77:03':'Intel','28:B2:BD':'Intel','28:C6:3F':'Intel','2C:33:7A':'Intel','3C:A9:F4':'Intel','40:A8:F0':'Intel',
  '58:94:6B':'Intel','5C:51:4F':'Intel','60:F2:62':'Intel','64:80:99':'Intel','68:05:CA':'Intel','6C:88:14':'Intel',
  '74:E5:0B':'Intel','7C:67:A2':'Intel','7C:B2:7D':'Intel','80:00:0B':'Intel','80:19:34':'Intel','88:53:2E':'Intel',
  '8C:70:5A':'Intel','94:65:9C':'Intel','9C:B6:D0':'Intel','A0:A8:CD':'Intel','A0:C5:89':'Intel','B4:B6:76':'Intel',
  'B8:03:05':'Intel','BC:77:37':'Intel','C4:85:08':'Intel','C4:D9:87':'Intel','D4:25:8B':'Intel','D8:F8:83':'Intel',
  'DC:53:60':'Intel','E4:A7:A0':'Intel','EC:A8:6B':'Intel','F0:1F:AF':'Intel','F4:06:69':'Intel','F8:16:54':'Intel',
  '00:E0:4C':'Realtek','52:54:00':'Realtek/QEMU','00:18:F3':'Realtek',
  '14:CC:20':'TP-Link','50:C7:BF':'TP-Link','60:E3:27':'TP-Link','A4:2B:B0':'TP-Link','C4:E9:0A':'TP-Link','E8:DE:27':'TP-Link',
  'F0:F2:49':'TP-Link','F4:28:53':'TP-Link','F4:EC:38':'TP-Link','F8:1A:67':'TP-Link','00:1D:0F':'TP-Link',
  '00:03:25':'Samsung','00:07:AB':'Samsung','00:12:FB':'Samsung','00:15:99':'Samsung','00:15:B9':'Samsung',
  '00:16:32':'Samsung','00:17:C9':'Samsung','00:17:D5':'Samsung','00:18:AF':'Samsung','00:1A:8A':'Samsung',
  '00:1D:25':'Samsung','00:1D:F6':'Samsung','00:1E:E1':'Samsung','00:1E:E2':'Samsung','00:21:19':'Samsung',
  '00:23:39':'Samsung','00:23:3A':'Samsung','00:23:99':'Samsung','00:24:54':'Samsung','00:24:90':'Samsung',
  '08:37:3D':'Samsung','08:D4:2B':'Samsung','0C:14:20':'Samsung','28:CC:01':'Samsung','D8:9E:3F':'Samsung',
  '00:1B:78':'HP','00:23:7D':'HP','00:24:81':'HP','3C:52:82':'HP','5C:B9:01':'HP','80:C1:6E':'HP','94:57:A5':'HP',
  'A0:48:1C':'HP','A0:D3:C1':'HP','D8:9D:67':'HP','E4:11:5B':'HP','EC:9A:74':'HP','F4:30:B9':'HP',
  '00:14:22':'Dell','00:15:C5':'Dell','00:18:8B':'Dell','00:19:B9':'Dell','00:1A:A0':'Dell','00:1C:23':'Dell',
  '00:1D:09':'Dell','00:1E:4F':'Dell','00:21:70':'Dell','00:21:9B':'Dell','00:22:19':'Dell','00:23:AE':'Dell',
  '00:24:E8':'Dell','00:25:64':'Dell','00:26:B9':'Dell','14:FE:B5':'Dell','18:A9:9B':'Dell','24:B6:FD':'Dell',
  '44:A8:42':'Dell','78:2B:CB':'Dell','84:2B:2B':'Dell','A4:1F:72':'Dell','B0:83:FE':'Dell','B8:CA:3A':'Dell',
  'F4:8E:38':'Dell','F8:CA:B8':'Dell','F8:DB:88':'Dell','64:00:6A':'Dell',
  '00:26:BB':'Apple','B8:27:EB':'Raspberry Pi','DC:A6:32':'Raspberry Pi','E4:5F:01':'Raspberry Pi','2C:CF:67':'Raspberry Pi',
  '00:11:32':'Synology','00:50:43':'Marvell','00:1C:C4':'Hewlett Packard','78:A3:E4':'LG','BC:F5:AC':'LG',
  '00:0D:4B':'Roku','B8:A1:75':'Roku','D8:31:34':'Roku','DC:3A:5E':'Roku',
  '18:B4:30':'Nest','44:61:32':'Ecobee','B4:F6:1C':'Google','F4:F5:D8':'Google','F8:8F:CA':'Google',
  '50:F5:DA':'Google','A4:77:33':'Google','1C:F2:9A':'Google','6C:AD:F8':'Google',
  '38:2C:4A':'Asus','04:D4:C4':'Asus','10:C3:7B':'Asus','1C:87:2C':'Asus','20:CF:30':'Asus','40:16:7E':'Asus',
  '50:46:5D':'Asus','54:04:A6':'Asus','60:45:CB':'Asus','70:8B:CD':'Asus','AC:22:0B':'Asus','BC:EE:7B':'Asus',
  'D8:50:E6':'Asus','E0:3F:49':'Asus','F8:32:E4':'Asus','04:D9:F5':'Asus','08:62:66':'Asus',
  '00:09:B0':'Onkyo','00:0B:6B':'Wistron','00:11:50':'Belkin','94:10:3E':'Belkin','08:86:3B':'Belkin',
  '44:94:FC':'Netgear','C0:3F:0E':'Netgear','E0:91:F5':'Netgear','9C:3D:CF':'Netgear','A0:21:B7':'Netgear',
  'B0:B9:8A':'Netgear','C4:3D:C7':'Netgear','DC:EF:09':'Netgear','E0:46:9A':'Netgear',
  '00:14:6C':'Netgear','20:4E:7F':'Netgear','30:46:9A':'Netgear','00:03:7F':'Atheros',
  '00:1F:33':'Netgear','4C:60:DE':'Netgear','74:44:01':'Netgear','84:1B:5E':'Netgear','A4:2B:8C':'Netgear',
  '28:6C:07':'Xiaomi','50:64:2B':'Xiaomi','64:CC:2E':'Xiaomi','74:23:44':'Xiaomi','78:11:DC':'Xiaomi',
  '8C:BE:BE':'Xiaomi','9C:99:A0':'Xiaomi','A0:86:C6':'Xiaomi','C4:6A:B7':'Xiaomi','F0:B4:29':'Xiaomi',
  '00:1C:DF':'Belkin','B4:75:0E':'Belkin','EC:1A:59':'Belkin','94:44:52':'Belkin',
  '00:24:A5':'Buffalo','00:1D:73':'Buffalo','B8:AE:6E':'D-Link','14:D6:4D':'D-Link','1C:AF:F7':'D-Link',
  '1C:BD:B9':'D-Link','28:10:7B':'D-Link','28:C6:8E':'D-Link','78:32:1B':'D-Link','84:C9:B2':'D-Link',
  '00:14:51':'Apple','00:0C:29':'VMware','00:50:56':'VMware','00:1C:14':'VMware','00:05:69':'VMware',
  '08:00:27':'VirtualBox','00:03:FF':'Microsoft','00:15:5D':'Microsoft/Hyper-V','00:17:FA':'Microsoft',
  '00:1D:D8':'Microsoft','00:22:48':'Microsoft','00:25:AE':'Microsoft','7C:1E:52':'Microsoft',
  '00:24:0D':'Brother','00:1B:A9':'Brother','3C:2A:F4':'Brother','30:05:5C':'Brother','B0:0C:D1':'Brother',
  '00:00:74':'Ricoh','00:26:73':'Ricoh','00:1E:A9':'Canon','EC:71:DB':'Epson','00:00:48':'Epson',
  'A4:EE:57':'Epson','44:D8:84':'Epson',
};

function lookupVendor(mac) {
  if (!mac) return null;
  const prefix = mac.toUpperCase().replace(/-/g, ':').split(':').slice(0, 3).join(':');
  return OUI_VENDORS[prefix] || null;
}

// ─── VECINOS (ARP) ──────────────────────────────────────────────────────────
function normalizeMac(mac) {
  return String(mac || '').toUpperCase().replace(/-/g, ':').trim();
}
function isUsefulNeighbor(ip, mac) {
  if (!isValidIp(ip) || !/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac)) return false;
  if (mac === 'FF:FF:FF:FF:FF:FF' || mac === '00:00:00:00:00:00') return false;
  const first = Number(ip.split('.')[0]);
  if (first >= 224) return false;          // multicast / broadcast
  if (ip.endsWith('.255')) return false;
  return true;
}

// Parsea la salida de `arp -a` (fallback si Get-NetNeighbor no está disponible)
function parseArpTable() {
  return new Promise((resolve) => {
    exec('arp -a', { windowsHide: true, timeout: 4000, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve(new Map());
      const map = new Map();
      for (const line of String(stdout).split('\n')) {
        const m = line.match(/\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:[-:][0-9a-f]{2}){5})/i);
        if (!m) continue;
        const ip = m[1];
        const mac = normalizeMac(m[2]);
        if (isUsefulNeighbor(ip, mac)) map.set(ip, { mac, state: 'Unknown' });
      }
      resolve(map);
    });
  });
}

// Get-NetNeighbor da además el estado (Reachable / Stale / Incomplete), que es
// justo lo que faltaba: con `arp -a` a secas las entradas caducadas se
// mostraban como equipos presentes y el barrido listaba fantasmas.
async function readNeighbors() {
  const data = await psJson(`
    $n = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      ForEach-Object { [pscustomobject]@{ ip = [string]$_.IPAddress; mac = [string]$_.LinkLayerAddress; state = [string]$_.State } });
    ConvertTo-Json -InputObject @($n) -Compress -Depth 3
  `, 9000);

  const list = Array.isArray(data) ? data : (data ? [data] : []);
  const map = new Map();
  for (const n of list) {
    if (!n) continue;
    const mac = normalizeMac(n.mac);
    if (!isUsefulNeighbor(n.ip, mac)) continue;
    if (/^(Incomplete|Unreachable)$/i.test(n.state || '')) continue;
    map.set(n.ip, { mac, state: n.state || 'Unknown' });
  }
  if (map.size > 0) return map;
  return parseArpTable();
}

// ─── PING ───────────────────────────────────────────────────────────────────
// -4 fuerza IPv4 y la IP se valida antes de construir el comando: las IPs
// llegan de perfiles importados desde JSON, que es texto arbitrario.
function pingHostWithLatency(ip, timeout = 1000) {
  return new Promise((resolve) => {
    if (!isValidIp(ip)) return resolve({ alive: false, latency: null });
    exec(
      `ping -4 -n 1 -w ${Math.round(timeout)} ${ip}`,
      { windowsHide: true, timeout: timeout + 1500, encoding: 'utf8' },
      (err, stdout) => {
        const out = String(stdout || '');
        // ping devuelve 0 incluso con "Host de destino inaccesible", así que el
        // veredicto lo da el texto de la respuesta, no el código de salida.
        if (!/TTL=|bytes=/i.test(out)) return resolve({ alive: false, latency: null });
        const m = out.match(/(?:time|tiempo)\s*[=<]\s*(\d+)\s*ms/i) || out.match(/[=<]\s*(\d+)\s*ms/);
        resolve({ alive: true, latency: m ? parseInt(m[1], 10) : null });
      }
    );
  });
}

async function pingHost(ip, timeout = 900) {
  const { alive } = await pingHostWithLatency(ip, timeout);
  return alive;
}

// Resolución inversa con el resolver de Node: antes se lanzaba un PowerShell
// por equipo (40 procesos a la vez) solo para esto.
async function resolveHostnameFast(ip) {
  try {
    const names = await dns.promises.reverse(ip);
    const name = (names || []).find(n => n && !/^\d+\.\d+\.\d+\.\d+$/.test(n));
    return name || null;
  } catch { return null; }
}

// Segunda pasada para los que el DNS no resuelve, en UN único proceso de
// PowerShell para todos (incluye LLMNR/NetBIOS, que es lo que suele dar nombre
// en una LAN doméstica).
async function resolveHostnamesWindows(ips) {
  const valid = ips.filter(isValidIp);
  if (valid.length === 0) return {};
  const list = valid.map(ip => `'${ip}'`).join(',');
  const data = await psJson(`
    $res = @{};
    foreach ($ip in @(${list})) {
      try {
        $n = Resolve-DnsName -Name $ip -QuickTimeout -ErrorAction SilentlyContinue |
             Where-Object { $_.NameHost } | Select-Object -First 1;
        if ($n -and $n.NameHost) { $res[$ip] = [string]$n.NameHost }
      } catch {}
    }
    ConvertTo-Json -InputObject $res -Compress -Depth 3
  `, Math.min(60000, 2000 + valid.length * 700));
  return (data && typeof data === 'object') ? data : {};
}

// ─── WATCHER (monitor de equipos esperados por perfil) ──────────────────────
let watchTimer = null;
let watchProfile = null;           // perfil activo que estamos vigilando
let watchState = new Map();        // id → { ip, label, alive, latency, lastSeen, lastCheck }
let watchTicking = false;          // evita solapamiento si un tick tarda más de lo normal

function sendWatchUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const payload = {
    profileId: watchProfile?.id || null,
    items: [...watchState.values()],
  };
  mainWindow.webContents.send('watch-update', payload);
}

async function watchTick() {
  if (!watchProfile || !watchProfile.watchlist?.length || watchTicking) return;
  watchTicking = true;
  try {
    const items = watchProfile.watchlist.filter(it => it && isValidIp(it.ip));

    // Por tandas de 8: una watchlist larga lanzaba un ping por equipo a la vez.
    await mapPool(items, 8, async (item) => {
      const { alive, latency } = await pingHostWithLatency(item.ip, 1200);
      const prev = watchState.get(item.id);
      const now = Date.now();
      watchState.set(item.id, {
        id: item.id,
        ip: item.ip,
        label: item.label || '',
        alive,
        latency,
        lastCheck: now,
        lastSeen: alive ? now : (prev?.lastSeen || null),
      });

      // Transición de estado → notificar si está habilitado
      if (prev && prev.lastCheck && prev.alive !== alive && settings.watchNotifications && Notification.isSupported()) {
        const name = item.label || item.ip;
        new Notification({
          title: alive ? 'Equipo conectado' : 'Equipo caído',
          body: alive
            ? `${name} (${item.ip}) vuelve a responder${latency != null ? ` · ${latency}ms` : ''}`
            : `${name} (${item.ip}) no responde`,
          silent: true,
        }).show();
      }
    });

    sendWatchUpdate();
  } finally {
    watchTicking = false;
  }
}

function stopWatcher() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
  watchProfile = null;
  watchState = new Map();
  sendWatchUpdate();
}

function startWatcher(profile) {
  stopWatcher();
  const items = (profile?.watchlist || []).filter(it => it && isValidIp(it.ip));
  if (items.length === 0) return;
  watchProfile = { ...profile, watchlist: items };

  // Inicializa estado: todos "desconocidos" de entrada
  for (const item of items) {
    watchState.set(item.id, {
      id: item.id, ip: item.ip, label: item.label || '',
      alive: false, latency: null, lastCheck: null, lastSeen: null,
    });
  }
  sendWatchUpdate();

  // Primer tick inmediato, después intervalo
  watchTick();
  const intervalSec = Math.max(5, Math.min(120, parseInt(settings.watchInterval, 10) || 15));
  watchTimer = setInterval(watchTick, intervalSec * 1000);
}

ipcMain.handle('watch-start', (_, profile) => { startWatcher(profile); return { started: true }; });
ipcMain.handle('watch-stop', () => { stopWatcher(); return { stopped: true }; });
ipcMain.handle('watch-status', () => ({
  profileId: watchProfile?.id || null,
  items: [...watchState.values()],
}));
ipcMain.handle('watch-tick-now', async () => { await watchTick(); return { ok: true }; });

// ─── ESCÁNER DE RED ─────────────────────────────────────────────────────────
// 32 pings a la vez. Antes se lanzaban los 254 de golpe con Promise.all: en
// Windows eso desborda la creación de procesos, muchos ping no llegan a
// ejecutarse o los mata su propio timeout, y el barrido salía incompleto y
// distinto en cada pasada (el síntoma de "no hace el barrido bien").
const SCAN_PING_CONCURRENCY = 32;
const SCAN_MAX_HOSTS = 1024;

// Calcula los hosts del rango. Antes se asumía siempre /24 a partir de la IP
// base, ignorando la máscara real del adaptador.
function cidrHosts(baseIp, prefix) {
  if (!isValidIp(baseIp)) return null;
  let p = parseInt(prefix, 10);
  if (!Number.isFinite(p) || p < 8 || p > 32) p = 24;

  const mask = p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0;
  const net = (ipToInt(baseIp) & mask) >>> 0;
  const total = Math.pow(2, 32 - p);
  const size = p >= 31 ? total : total - 2;

  // Red demasiado grande para barrerla: se usa el /24 que contiene la IP base.
  if (size > SCAN_MAX_HOSTS) return cidrHosts(baseIp, 24);

  const first = p >= 31 ? net : net + 1;
  const hosts = [];
  for (let i = 0; i < size; i++) hosts.push(intToIp((first + i) >>> 0));
  return { hosts, prefix: p, network: intToIp(net), mask: intToIp(mask) };
}

let scanSeq = 0;
let activeScan = null;

async function scanNetwork(req, webContents) {
  // Cancelar el barrido anterior. Antes "Re-escanear" dejaba el anterior vivo
  // lanzando pings en segundo plano y los dos se estorbaban.
  if (activeScan) activeScan.cancelled = true;
  const scan = { id: ++scanSeq, cancelled: false };
  activeScan = scan;

  const aborted = () => scan.cancelled || activeScan !== scan || !webContents || webContents.isDestroyed();
  const send = (event, payload) => { if (!aborted()) webContents.send(event, payload); };
  const finish = () => { if (activeScan === scan) activeScan = null; };

  const baseIp = typeof req === 'string' ? req : req?.baseIp;
  const prefixReq = (req && typeof req === 'object') ? req.prefix : null;

  if (!isValidIp(baseIp)) {
    if (webContents && !webContents.isDestroyed()) webContents.send('scan-complete', { success: false, error: 'IP base inválida' });
    finish();
    return;
  }

  const range = cidrHosts(baseIp, prefixReq);
  const ips = range.hosts;
  const inRange = new Set(ips);
  const seen = new Map();

  send('scan-start', { total: ips.length, base: baseIp, prefix: range.prefix, network: range.network });

  const emitNew = (entry) => { seen.set(entry.ip, entry); send('scan-device', entry); };
  const emitUpd = (entry) => send('scan-device-update', entry);

  // FASE 1 — vecinos ya conocidos (respuesta instantánea en la lista).
  for (const [ip, n] of await readNeighbors()) {
    if (!inRange.has(ip)) continue;
    emitNew({
      ip, mac: n.mac, vendor: lookupVendor(n.mac), hostname: null,
      source: 'arp',
      // Solo "Reachable"/"Permanent" prueban que está vivo ahora mismo; el resto
      // queda pendiente de confirmar con el ping.
      alive: /^(Reachable|Permanent)$/i.test(n.state) ? true : null,
      latency: null,
    });
  }
  if (aborted()) return finish();

  // FASE 2 — barrido de ping por tandas.
  let done = 0;
  let lastProgress = 0;
  await mapPool(ips, SCAN_PING_CONCURRENCY, async (ip) => {
    const { alive, latency } = await pingHostWithLatency(ip, 900);
    done++;
    if (Date.now() - lastProgress > 150) { lastProgress = Date.now(); send('scan-progress', { done, total: ips.length }); }
    if (!alive) return;
    const existing = seen.get(ip);
    if (existing) {
      existing.alive = true;
      existing.latency = latency;
      emitUpd(existing);
    } else {
      emitNew({ ip, mac: null, vendor: null, hostname: null, source: 'ping', alive: true, latency });
    }
  }, aborted);
  if (aborted()) return finish();
  send('scan-progress', { done: ips.length, total: ips.length });

  // FASE 3 — releer vecinos: los equipos con el ICMP bloqueado por firewall no
  // contestan al ping pero sí al ARP que lo precede, así que ahora salen como
  // Reachable. Y las entradas que siguen en Stale sin haber contestado se
  // marcan como caídas en vez de colarse en la lista como equipos presentes.
  for (const [ip, n] of await readNeighbors()) {
    if (!inRange.has(ip)) continue;
    const fresh = /^(Reachable|Permanent)$/i.test(n.state);
    const existing = seen.get(ip);
    if (existing) {
      let changed = false;
      if (!existing.mac) { existing.mac = n.mac; existing.vendor = lookupVendor(n.mac); changed = true; }
      if (existing.alive !== true && fresh) { existing.alive = true; changed = true; }
      if (changed) emitUpd(existing);
    } else if (fresh) {
      emitNew({ ip, mac: n.mac, vendor: lookupVendor(n.mac), hostname: null, source: 'arp-late', alive: true, latency: null });
    }
  }
  if (aborted()) return finish();

  // Lo que a estas alturas no ha respondido a nada, no está: se informa como
  // caído para que la UI lo muestre apagado y no cuente como equipo encontrado.
  for (const entry of seen.values()) {
    if (entry.alive === null) { entry.alive = false; emitUpd(entry); }
  }

  // FASE 4 — nombres. Primero el resolver de Node (gratis) para todos.
  const aliveIps = [...seen.values()].filter(e => e.alive).map(e => e.ip);
  await mapPool(aliveIps, 24, async (ip) => {
    const name = await resolveHostnameFast(ip);
    if (!name) return;
    const entry = seen.get(ip);
    if (entry) { entry.hostname = name; emitUpd(entry); }
  }, aborted);
  if (aborted()) return finish();

  send('scan-complete', { success: true, count: [...seen.values()].filter(e => e.alive).length });

  // Los que siguen sin nombre, en una sola llamada a PowerShell, ya con el
  // barrido dado por terminado: los nombres van llegando después.
  const unnamed = [...seen.values()].filter(e => e.alive && !e.hostname).map(e => e.ip);
  if (unnamed.length > 0 && !aborted()) {
    const names = await resolveHostnamesWindows(unnamed);
    for (const [ip, name] of Object.entries(names)) {
      const entry = seen.get(ip);
      if (entry && name && !entry.hostname) { entry.hostname = String(name); emitUpd(entry); }
    }
  }
  finish();
}

ipcMain.handle('scan-network', (e, req) => {
  scanNetwork(req, e.sender);
  return { started: true };
});

ipcMain.handle('cancel-scan', () => {
  if (activeScan) activeScan.cancelled = true;
  activeScan = null;
  return { cancelled: true };
});

// ─── Info app ───────────────────────────────────────────────────────────────
ipcMain.handle('get-app-info', () => ({
  version: VERSION,
  electron: process.versions.electron,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}));

// ─── Ventana ────────────────────────────────────────────────────────────────
ipcMain.on('minimize-window', () => mainWindow?.minimize());
ipcMain.on('maximize-window', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('close-window', () => mainWindow?.close());
ipcMain.on('hide-to-tray', () => mainWindow?.hide());
ipcMain.on('quit-app', () => { isQuiting = true; app.quit(); });

ipcMain.on('open-external', (_, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
});
