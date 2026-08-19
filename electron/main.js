const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, Notification, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { exec, execSync } = require('child_process');

const isDev = process.env.NODE_ENV === 'development';
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

  if (isDev) mainWindow.loadURL('http://localhost:3000');
  else mainWindow.loadFile(path.join(__dirname, '..', 'build', 'index.html'));

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
function buildTrayMenu() {
  const profiles = loadProfiles() || [];
  // Obtener IP actual + estado DHCP síncronamente (con fallback si falla)
  let currentIp = null;
  let isDhcp = false;
  try {
    const ps =
      "$ip = Get-NetIPAddress -AddressFamily IPv4 | " +
      "Where-Object {$_.PrefixOrigin -ne 'WellKnown' -and $_.IPAddress -notlike '169.*'} | " +
      "Select-Object -First 1; " +
      "if ($ip) { " +
      "  $dhcp = (Get-NetIPInterface -InterfaceIndex $ip.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).Dhcp; " +
      "  Write-Output \"$($ip.IPAddress)|$dhcp\" " +
      "}";
    const out = execSync(
      `powershell -NoProfile -Command "${ps}"`,
      { windowsHide: true, timeout: 2500 }
    ).toString().trim();
    if (out) {
      const [ip, dhcp] = out.split('|');
      currentIp = ip || null;
      isDhcp = (dhcp || '').trim() === 'Enabled';
    }
  } catch {}

  const profileItems = profiles.length === 0
    ? [{ label: 'Sin perfiles', enabled: false }]
    : profiles.map(p => ({
        label: `${p.name} — ${p.ip}`,
        type: 'checkbox',
        checked: !isDhcp && currentIp === p.ip,
        click: () => {
          mainWindow?.webContents.send('tray-activate-profile', p.id);
          showWindow();
        },
      }));

  const statusLabel = currentIp
    ? `IP actual: ${currentIp}${isDhcp ? '  (DHCP)' : '  (estática)'}`
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

app.on('window-all-closed', (e) => { /* no salir: vive en tray */ });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(); });
app.on('before-quit', () => { isQuiting = true; });
app.on('will-quit', () => { stopWatcher(); globalShortcut.unregisterAll(); });

// ═══ HELPERS DE EJECUCIÓN ═══════════════════════════════════════════════════

function psEscape(str) { return String(str).replace(/'/g, "''"); }

function execAsync(cmd, timeout = 5000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true, timeout }, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function runElevatedBatch(commands) {
  return new Promise((resolve) => {
    if (!Array.isArray(commands) || commands.length === 0) {
      return resolve({ success: false, code: -1, stdout: '', stderr: 'Sin comandos' });
    }
    const tmpDir = os.tmpdir();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const batPath = path.join(tmpDir, `ipsw_${id}.bat`);
    const outPath = path.join(tmpDir, `ipsw_${id}.out`);
    const errPath = path.join(tmpDir, `ipsw_${id}.err`);

    const lines = ['@echo off', 'chcp 65001 >nul'];
    commands.forEach((cmd, i) => {
      const redir = i === 0 ? `> "${outPath}" 2> "${errPath}"` : `>> "${outPath}" 2>> "${errPath}"`;
      lines.push(`${cmd} ${redir}`);
      lines.push('if %errorlevel% neq 0 exit /b %errorlevel%');
    });
    lines.push('exit /b 0', '');

    try { fs.writeFileSync(batPath, lines.join('\r\n'), { encoding: 'utf8' }); }
    catch (e) { return resolve({ success: false, code: -1, stdout: '', stderr: e.message }); }

    const cleanup = () => {
      try { fs.unlinkSync(batPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
      try { fs.unlinkSync(errPath); } catch {}
    };

    const ps = [
      'try {',
      `  $p = Start-Process -FilePath '${psEscape(batPath)}' -Verb RunAs -WindowStyle Hidden -PassThru -Wait;`,
      '  Write-Output $p.ExitCode;',
      '} catch { Write-Output "UAC_CANCEL"; }',
    ].join(' ');

    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) => {
      const result = (stdout || '').trim();
      const readFile = p => { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } };
      const outContent = readFile(outPath).trim();
      const errContent = readFile(errPath).trim();

      if (err && !result) { cleanup(); return resolve({ success: false, code: -1, stdout: '', stderr: stderr || err.message }); }
      if (/UAC_CANCEL/.test(result)) { cleanup(); return resolve({ success: false, code: 1223, stdout: '', stderr: 'Operación cancelada por el usuario (UAC).' }); }

      const code = parseInt(result, 10);
      cleanup();
      if (isNaN(code)) return resolve({ success: false, code: -1, stdout: outContent, stderr: errContent || `Salida inesperada: ${result}` });
      if (code !== 0)  return resolve({ success: false, code, stdout: outContent, stderr: errContent || outContent || `netsh devolvió código ${code}` });
      return resolve({ success: true, code, stdout: outContent, stderr: errContent });
    });
  });
}

async function getAdaptersAsync() {
  // Filtros de basura que NUNCA queremos ver
  // - loopback, tunnel, teredo, isatap, wan miniport: no son usables para cambiar IP
  // - hyper-v: interfaces internas del hypervisor (no las de VMs huésped)
  // - bluetooth pan: rara vez se usa para red
  // - nota: NO excluimos 'vmware', 'virtualbox', 'tap-' aquí para que la app funcione
  //   dentro de VMs donde la NIC de la VM ES de ese fabricante
  const bad = /(loopback|tunnel|teredo|isatap|wan miniport|bluetooth pan|hyper-v virtual switch|hyper-v virtual ethernet)/i;

  // Filtros adicionales si hay muchos adaptadores (para evitar VPNs virtuales tipo TAP-Windows)
  const badAggressive = /(tap-windows|tap adapter|npcap|pptp|sstp|l2tp|openvpn|wireguard|tailscale|zerotier)/i;

  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter(a => { if (!a.name || seen.has(a.name)) return false; seen.add(a.name); return true; });
  };

  // Intento 1 — Get-NetAdapter con filtro RELAJADO: solo Status=Up, sin descartar Virtual
  try {
    const { stdout } = await execAsync(
      'powershell -NoProfile -Command "Get-NetAdapter | Where-Object {$_.Status -eq \'Up\'} | Select-Object Name,InterfaceDescription,MediaType,Virtual,HardwareInterface | ConvertTo-Json -Compress"',
      5000
    );
    const raw = (stdout || '').trim();
    if (raw) {
      let list = JSON.parse(raw);
      if (!Array.isArray(list)) list = [list];

      let filtered = list.filter(a =>
        a && a.Name &&
        !bad.test(a.Name) && !bad.test(a.InterfaceDescription || '')
      );

      // Si hay más de 2 adaptadores, aplicar filtro agresivo para quitar VPNs virtuales
      if (filtered.length > 2) {
        const strong = filtered.filter(a =>
          !badAggressive.test(a.Name) && !badAggressive.test(a.InterfaceDescription || '')
        );
        // Solo aplicar si nos sigue dejando algo
        if (strong.length > 0) filtered = strong;
      }

      const result = dedup(filtered.map(a => ({
        name: a.Name,
        description: a.InterfaceDescription || '',
        mediaType: a.MediaType || '',
      })));

      if (result.length > 0) return result;
    }
  } catch {}

  // Intento 2 — netsh como fallback
  try {
    const { stdout } = await execAsync('netsh interface show interface', 3000);
    const lines = stdout.split('\n');
    const adapters = [];
    for (const l of lines) {
      if (!/connected|conectado/i.test(l)) continue;
      if (/disconnected|desconectado/i.test(l)) continue;
      const parts = l.trim().split(/\s{2,}/);
      const name = parts[parts.length - 1]?.trim();
      if (name && name.length > 0 && !bad.test(name)) {
        adapters.push({ name, description: '', mediaType: '' });
      }
    }
    return dedup(adapters);
  } catch {}

  // Intento 3 — ipconfig /all como último recurso (para entornos muy restringidos)
  try {
    const { stdout } = await execAsync('ipconfig /all', 3000);
    const adapters = [];
    const blocks = stdout.split(/\r?\n(?=[A-ZÁÉÍÓÚ].*adapter|Adaptador)/);
    for (const block of blocks) {
      const headerMatch = block.match(/(?:adapter|Adaptador)\s+([^:]+):/i);
      if (!headerMatch) continue;
      const name = headerMatch[1].trim();
      if (!name || bad.test(name)) continue;
      // Solo si tiene IPv4 asignada
      if (/IPv4|IP Address|Dirección IPv4/i.test(block)) {
        adapters.push({ name, description: '', mediaType: '' });
      }
    }
    return dedup(adapters);
  } catch { return []; }
}

// Cache de IP actual
const ipCache = new Map();
const CACHE_MS = 2000;

async function getIpConfigAsync(adapter) {
  if (!adapter) return { success: false };
  const cached = ipCache.get(adapter);
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.data;

  try {
    const safe = psEscape(adapter);
    const script = `
      $cfg = Get-NetIPConfiguration -InterfaceAlias '${safe}' -ErrorAction Stop;
      $ipInfo = $cfg.IPv4Address | Select-Object -First 1;
      $dhcp = (Get-NetIPInterface -InterfaceAlias '${safe}' -AddressFamily IPv4 -ErrorAction Stop).Dhcp;
      $result = @{
        ip = $ipInfo.IPAddress;
        prefix = $ipInfo.PrefixLength;
        gateway = ($cfg.IPv4DefaultGateway | Select-Object -First 1).NextHop;
        dns = ($cfg.DNSServer | Where-Object {$_.AddressFamily -eq 2}).ServerAddresses;
        dhcp = ($dhcp -eq 'Enabled');
      };
      $result | ConvertTo-Json -Compress
    `.replace(/\s+/g, ' ').trim();

    const { stdout } = await execAsync(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, 5000);
    const raw = stdout.trim();
    if (!raw) { ipCache.delete(adapter); return { success: false }; }
    const data = JSON.parse(raw);
    const result = {
      success: true,
      ip: data.ip || null,
      prefix: data.prefix || null,
      gateway: data.gateway || null,
      dns: Array.isArray(data.dns) ? data.dns : (data.dns ? [data.dns] : []),
      dhcp: !!data.dhcp,
    };
    ipCache.set(adapter, { data: result, ts: Date.now() });
    return result;
  } catch {
    // El adaptador puede haber desaparecido (cambio de red). No cachear fallos.
    ipCache.delete(adapter);
    return { success: false };
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

ipcMain.handle('apply-ip', async (_, { adapter, ip, mask, gateway, dns, dns2, profileName }) => {
  if (!adapter || !ip || !mask) return { success: false, error: 'Faltan datos requeridos' };
  const safeAdapter = adapter.replace(/"/g, '');

  const commands = [];
  let ipCmd = `netsh interface ip set address name="${safeAdapter}" static ${ip} ${mask}`;
  if (gateway) ipCmd += ` ${gateway} 1`;
  commands.push(ipCmd);
  if (dns) {
    commands.push(`netsh interface ip set dns name="${safeAdapter}" static ${dns} primary`);
    if (dns2) commands.push(`netsh interface ip add dns name="${safeAdapter}" ${dns2} index=2`);
  } else {
    commands.push(`netsh interface ip set dns name="${safeAdapter}" source=dhcp`);
  }

  try {
    const r = await runElevatedBatch(commands);
    invalidateCache(adapter);
    const ok = r.success;

    pushHistory({ action: 'apply', adapter, ip, profileName: profileName || null, success: ok, error: ok ? null : r.stderr });

    if (ok) {
      buildTrayMenu();
      if (settings.showNotifications && Notification.isSupported()) {
        new Notification({ title: 'IP Switcher', body: `IP ${ip} aplicada en "${adapter}"${profileName ? ' · ' + profileName : ''}`, silent: true }).show();
      }
      return { success: true };
    }
    return { success: false, error: r.stderr };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('set-dhcp', async (_, adapter) => {
  if (!adapter) return { success: false, error: 'Adaptador no especificado' };
  const safeAdapter = adapter.replace(/"/g, '');
  try {
    const r = await runElevatedBatch([
      `netsh interface ip set address name="${safeAdapter}" source=dhcp`,
      `netsh interface ip set dns name="${safeAdapter}" source=dhcp`,
    ]);
    invalidateCache(adapter);
    pushHistory({ action: 'dhcp', adapter, success: r.success, error: r.success ? null : r.stderr });
    if (r.success) {
      buildTrayMenu();
      if (settings.showNotifications && Notification.isSupported()) {
        new Notification({ title: 'IP Switcher', body: `"${adapter}" vuelto a DHCP`, silent: true }).show();
      }
      return { success: true };
    }
    return { success: false, error: r.stderr };
  } catch (err) { return { success: false, error: err.message }; }
});

ipcMain.handle('get-current-ip', async (_, adapter) => {
  const cfg = await getIpConfigAsync(adapter);
  return { success: cfg.success, ip: cfg.ip || null };
});

ipcMain.handle('get-ip-config', (_, adapter) => getIpConfigAsync(adapter));

// ─── Capturar configuración actual como perfil ──────────────────────────────
ipcMain.handle('capture-current', async (_, adapter) => {
  const cfg = await getIpConfigAsync(adapter);
  if (!cfg.success || !cfg.ip) return { success: false, error: 'No hay IP detectada' };

  // Convertir prefix a máscara (ej: 24 → 255.255.255.0)
  const prefixToMask = (prefix) => {
    if (!prefix || prefix < 0 || prefix > 32) return '255.255.255.0';
    const bits = '1'.repeat(prefix) + '0'.repeat(32 - prefix);
    return [0, 8, 16, 24].map(i => parseInt(bits.slice(i, i + 8), 2)).join('.');
  };

  return {
    success: true,
    data: {
      ip: cfg.ip,
      mask: prefixToMask(cfg.prefix),
      gateway: cfg.gateway || '',
      dns: cfg.dns?.[0] || '',
      dns2: cfg.dns?.[1] || '',
    },
  };
});

// ─── Ping test ───────────────────────────────────────────────────────────────
ipcMain.handle('ping-test', async (_, { gateway, dns }) => {
  const pingOne = async (host) => {
    if (!host) return null;
    try {
      const { stdout } = await execAsync(`ping -n 2 -w 1500 ${host}`, 6000);
      const match = stdout.match(/Average\s*=\s*(\d+)\s*ms|Media\s*=\s*(\d+)\s*ms|promedio\s*=\s*(\d+)\s*ms/i);
      if (match) return { success: true, latency: parseInt(match[1] || match[2] || match[3], 10) };
      if (/TTL=|bytes=/i.test(stdout)) return { success: true, latency: null };
      return { success: false };
    } catch { return { success: false }; }
  };

  const [gwResult, dnsResult, internetResult] = await Promise.all([
    pingOne(gateway),
    pingOne(dns),
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

// Parsea salida de `arp -a` en Windows
function parseArpTable() {
  return new Promise((resolve) => {
    exec('arp -a', { windowsHide: true, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(new Map());
      const map = new Map();
      const lines = stdout.split('\n');
      for (const line of lines) {
        const m = line.match(/\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f-]{17})\s+(\w+)/i);
        if (m) {
          const ip = m[1];
          const mac = m[2].replace(/-/g, ':').toUpperCase();
          if (mac !== 'FF:FF:FF:FF:FF:FF' && !ip.endsWith('.255') && !ip.startsWith('224.') && !ip.startsWith('239.')) {
            map.set(ip, mac);
          }
        }
      }
      resolve(map);
    });
  });
}

// Resolver hostname inverso (rápido, timeout corto)
function resolveHostname(ip) {
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -Command "try { (Resolve-DnsName -Name '${ip}' -DnsOnly -QuickTimeout -ErrorAction Stop).NameHost } catch {}"`,
      { windowsHide: true, timeout: 1500 },
      (err, stdout) => {
        const name = (stdout || '').trim();
        resolve(name && !name.match(/^\d+\.\d+\.\d+\.\d+$/) ? name : null);
      }
    );
  });
}

// Ping a una IP individual
function pingHost(ip, timeout = 800) {
  return new Promise((resolve) => {
    exec(`ping -n 1 -w ${timeout} ${ip}`, { windowsHide: true, timeout: timeout + 500 }, (err, stdout) => {
      if (err) return resolve(false);
      resolve(/TTL=|bytes=/i.test(stdout));
    });
  });
}

// Ping a una IP con latencia (devuelve {alive, latency})
function pingHostWithLatency(ip, timeout = 1200) {
  return new Promise((resolve) => {
    exec(`ping -n 1 -w ${timeout} ${ip}`, { windowsHide: true, timeout: timeout + 500 }, (err, stdout) => {
      if (err) return resolve({ alive: false, latency: null });
      const alive = /TTL=|bytes=/i.test(stdout);
      if (!alive) return resolve({ alive: false, latency: null });
      const m = stdout.match(/[=<]\s*(\d+)\s*ms/);
      const latency = m ? parseInt(m[1], 10) : null;
      resolve({ alive: true, latency });
    });
  });
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
    const items = watchProfile.watchlist;

    await Promise.all(items.map(async (item) => {
      if (!item.ip) return;
      const { alive, latency } = await pingHostWithLatency(item.ip, 1200);
      const prev = watchState.get(item.id);
      const now = Date.now();
      const next = {
        id: item.id,
        ip: item.ip,
        label: item.label || '',
        alive,
        latency,
        lastCheck: now,
        lastSeen: alive ? now : (prev?.lastSeen || null),
      };
      watchState.set(item.id, next);

      // Transición de estado → notificar si está habilitado
      if (prev && prev.alive !== alive && settings.watchNotifications && Notification.isSupported()) {
        const name = item.label || item.ip;
        new Notification({
          title: alive ? 'Equipo conectado' : 'Equipo caído',
          body: alive
            ? `${name} (${item.ip}) vuelve a responder${latency != null ? ` · ${latency}ms` : ''}`
            : `${name} (${item.ip}) no responde`,
          silent: true,
        }).show();
      }
    }));

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
  if (!profile || !profile.watchlist || profile.watchlist.length === 0) return;
  watchProfile = profile;

  // Inicializa estado: todos "desconocidos" de entrada
  for (const item of profile.watchlist) {
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


function getSubnet24(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const base = parts.slice(0, 3).join('.');
  return Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
}

let activeScanId = null;

async function scanNetwork(baseIp, webContents) {
  const scanId = Date.now().toString(36);
  activeScanId = scanId;

  const ips = getSubnet24(baseIp);
  if (!ips) {
    webContents?.send('scan-complete', { success: false, error: 'IP base inválida' });
    return;
  }

  const send = (event, payload) => {
    if (activeScanId === scanId && webContents && !webContents.isDestroyed()) {
      webContents.send(event, payload);
    }
  };

  send('scan-start', { total: ips.length, base: baseIp });

  // FASE 1 — ARP inmediato
  const arpMap = await parseArpTable();
  const seen = new Map(); // ip -> { ip, mac, vendor, hostname, source }

  for (const [ip, mac] of arpMap.entries()) {
    if (!ips.includes(ip)) continue; // solo los del /24
    const entry = { ip, mac, vendor: lookupVendor(mac), hostname: null, source: 'arp' };
    seen.set(ip, entry);
    send('scan-device', entry);
  }

  // FASE 2 — Ping sweep paralelo
  let done = 0;
  await Promise.all(ips.map(async (ip) => {
    if (activeScanId !== scanId) return;
    const alive = await pingHost(ip, 800);
    done++;
    send('scan-progress', { done, total: ips.length });

    if (alive && !seen.has(ip)) {
      // Marca como vivo sin MAC aún
      const entry = { ip, mac: null, vendor: null, hostname: null, source: 'ping' };
      seen.set(ip, entry);
      send('scan-device', entry);
    }
  }));

  if (activeScanId !== scanId) return;

  // FASE 3 — Re-leer ARP para capturar MACs de los pings que respondieron
  const arpMap2 = await parseArpTable();
  for (const [ip, mac] of arpMap2.entries()) {
    if (!ips.includes(ip)) continue;
    const existing = seen.get(ip);
    if (existing && !existing.mac) {
      existing.mac = mac;
      existing.vendor = lookupVendor(mac);
      send('scan-device-update', existing);
    } else if (!existing) {
      const entry = { ip, mac, vendor: lookupVendor(mac), hostname: null, source: 'arp-late' };
      seen.set(ip, entry);
      send('scan-device', entry);
    }
  }

  // FASE 4 — Resolver hostnames (en paralelo, limitados a los encontrados)
  const foundIps = [...seen.keys()];
  await Promise.all(foundIps.slice(0, 40).map(async (ip) => {
    if (activeScanId !== scanId) return;
    const name = await resolveHostname(ip);
    if (name) {
      const existing = seen.get(ip);
      if (existing) {
        existing.hostname = name;
        send('scan-device-update', existing);
      }
    }
  }));

  if (activeScanId === scanId) {
    send('scan-complete', { success: true, count: seen.size });
  }
}

ipcMain.handle('scan-network', (e, baseIp) => {
  scanNetwork(baseIp, e.sender);
  return { started: true };
});

ipcMain.handle('cancel-scan', () => {
  activeScanId = null;
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
