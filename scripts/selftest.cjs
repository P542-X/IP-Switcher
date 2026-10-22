// Autodiagnóstico: carga electron/main.js con Electron stubeado y ejecuta la
// lógica de red de verdad contra esta máquina (adaptadores, lectura de IP,
// vecinos ARP, ping, validadores). No cambia nada del sistema: no llega a
// ejecutar netsh ni pide UAC.
//
//   npm run selftest
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const Module = require('module');

const MAIN = path.join(__dirname, '..', 'electron', 'main.js');
const userData = path.join(os.tmpdir(), 'ipsw-test-userdata');
fs.mkdirSync(userData, { recursive: true });

const handlers = new Map();
const listeners = [];

const stub = {
  app: {
    getPath: () => userData,
    getVersion: () => '1.0.0-test',
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}), // nunca lista: no crea ventana ni tray
    on: (ev, fn) => listeners.push([ev, fn]),
    quit: () => {},
    setLoginItemSettings: () => {},
  },
  BrowserWindow: class { static getAllWindows() { return []; } },
  ipcMain: {
    handle: (name, fn) => handlers.set(name, fn),
    on: () => {},
  },
  shell: { openExternal: () => {} },
  Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} isDestroyed() { return true; } },
  Menu: { buildFromTemplate: (t) => t },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  Notification: class { static isSupported() { return false; } show() {} },
  nativeImage: { createFromBuffer: (b) => b },
  dialog: { showSaveDialog: async () => ({ canceled: true }), showOpenDialog: async () => ({ canceled: true }) },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return stub;
  return origLoad.apply(this, arguments);
};

const EXPORTS = [
  'berOid', 'berInteger', 'berTlv', 'berRead', 'berDecodeOid', 'snmpBuildGet',
  'snmpParseResponse', 'snmpGet', 'tcpProbe', 'classifyDevice', 'fingerprintDevice',
  'SERVICE_PROBES', 'OID_SYS_DESCR', 'OID_SYS_NAME', 'OID_SYS_OBJECT',
  'isValidIp', 'isValidMask', 'ipToInt', 'intToIp', 'maskToPrefix', 'prefixToMask',
  'ipRoleInSubnet', 'sameSubnet', 'mapPool', 'netshTarget', 'cidrHosts',
  'psJson', 'psAsync', 'getAdaptersAsync', 'readIpConfig', 'getIpConfigAsync',
  'getPrimaryIpInfo', 'readNeighbors', 'parseArpTable', 'getInterfaceIndex',
  'pingHostWithLatency', 'lookupVendor', 'resolveHostnameFast', 'resolveHostnamesWindows',
];
const src = fs.readFileSync(MAIN, 'utf8') +
  `\nmodule.exports.__t = { ${EXPORTS.join(', ')} };\n`;

const m = new Module(MAIN, null);
m.filename = MAIN;
m.paths = Module._nodeModulePaths(path.dirname(MAIN));
m._compile(src, MAIN);
const T = m.exports.__t;

// ─── Pruebas ────────────────────────────────────────────────────────────────
let fails = 0;
const ok = (cond, label, extra) => {
  if (cond) console.log('  OK   ' + label);
  else { fails++; console.log('  FALLO ' + label + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
};

(async () => {
  console.log('\n[1] Validadores');
  ok(T.isValidIp('192.168.1.10'), 'IP normal');
  ok(!T.isValidIp('192.168.1.256'), 'octeto > 255');
  ok(!T.isValidIp('192.168.01.10'), 'cero a la izquierda rechazado');
  ok(!T.isValidIp('192.168.1'), 'faltan octetos');
  ok(!T.isValidIp(''), 'vacía');
  ok(T.isValidMask('255.255.255.0'), 'máscara /24');
  ok(T.isValidMask('255.255.254.0'), 'máscara /23');
  ok(!T.isValidMask('255.0.255.0'), 'máscara no contigua');
  ok(!T.isValidMask('0.0.0.0'), 'máscara vacía');
  ok(T.maskToPrefix('255.255.255.0') === 24, '/24', T.maskToPrefix('255.255.255.0'));
  ok(T.maskToPrefix('255.255.240.0') === 20, '/20', T.maskToPrefix('255.255.240.0'));
  ok(T.prefixToMask(23) === '255.255.254.0', 'prefijo 23 → máscara', T.prefixToMask(23));
  ok(T.prefixToMask(8) === '255.0.0.0', 'prefijo 8 → máscara', T.prefixToMask(8));
  ok(T.ipRoleInSubnet('192.168.1.0', '255.255.255.0') === 'network', 'dirección de red');
  ok(T.ipRoleInSubnet('192.168.1.255', '255.255.255.0') === 'broadcast', 'broadcast');
  ok(T.ipRoleInSubnet('192.168.1.10', '255.255.255.0') === 'host', 'host válido');
  ok(T.ipRoleInSubnet('10.0.0.255', '255.255.254.0') === 'host', '.255 intermedio válido en /23');
  ok(T.ipRoleInSubnet('10.0.1.255', '255.255.255.0') === 'broadcast', '.255 broadcast en /24');
  ok(T.sameSubnet('192.168.1.5', '192.168.1.1', '255.255.255.0'), 'misma subred');
  ok(!T.sameSubnet('192.168.1.5', '192.168.2.1', '255.255.255.0'), 'subred distinta');

  console.log('\n[2] Rango de escaneo');
  const r24 = T.cidrHosts('192.168.1.50', 24);
  ok(r24.hosts.length === 254, '/24 → 254 hosts', r24.hosts.length);
  ok(r24.hosts[0] === '192.168.1.1' && r24.hosts[253] === '192.168.1.254', '/24 primero y último', [r24.hosts[0], r24.hosts[253]]);
  const r23 = T.cidrHosts('10.0.1.50', 23);
  ok(r23.hosts.length === 510, '/23 → 510 hosts', r23.hosts.length);
  ok(r23.hosts[0] === '10.0.0.1', '/23 empieza en .0.1', r23.hosts[0]);
  const r16 = T.cidrHosts('172.16.5.4', 16);
  ok(r16.prefix === 24 && r16.hosts.length === 254, '/16 se acota al /24', [r16.prefix, r16.hosts.length]);
  ok(T.cidrHosts('192.168.1.1', null).prefix === 24, 'sin prefijo → /24');
  ok(T.cidrHosts('no-una-ip', 24) === null, 'IP base inválida → null');
  ok(T.netshTarget(12, 'Wi-Fi') === '12', 'netsh usa el índice');
  ok(T.netshTarget(null, 'Conexión "raro" & tal') === '"Conexión raro & tal"', 'netsh sin índice entrecomilla', T.netshTarget(null, 'Conexión "raro" & tal'));

  console.log('\n[3] Pool de concurrencia');
  let inFlight = 0, peak = 0;
  const res = await T.mapPool([...Array(50).keys()], 8, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise(r => setTimeout(r, 5));
    inFlight--;
    return n * 2;
  });
  ok(peak <= 8, 'nunca más de 8 en vuelo', peak);
  ok(res.length === 50 && res[49] === 98, 'resultados en orden', [res.length, res[49]]);
  let count = 0;
  await T.mapPool([...Array(100).keys()], 4, async () => { count++; }, () => count >= 10);
  ok(count < 40, 'aborta pronto cuando se cancela', count);

  console.log('\n[4] PowerShell (UTF-8 + EncodedCommand)');
  const j = await T.psJson("ConvertTo-Json -InputObject @{ texto = 'Conexión de área local ñ'; n = 42 } -Compress");
  ok(j && j.n === 42, 'JSON de vuelta', j);
  ok(j && j.texto === 'Conexión de área local ñ', 'acentos intactos (antes llegaban corruptos)', j && j.texto);
  const q = await T.psJson("ConvertTo-Json -InputObject @{ s = 'comillas \" y & y ^ y %PATH%' } -Compress");
  ok(q && q.s.includes('"') && q.s.includes('&') && q.s.includes('%PATH%'), 'metacaracteres de cmd intactos', q);

  console.log('\n[5] Adaptadores de esta máquina');
  const adps = await T.getAdaptersAsync();
  ok(Array.isArray(adps) && adps.length > 0, 'se detecta al menos un adaptador', adps);
  console.log('       ' + JSON.stringify(adps, null, 1).replace(/\n/g, '\n       '));
  ok(adps.every(a => a.name && (a.index === null || Number.isInteger(a.index))), 'todos con nombre e índice');
  if (adps.length > 1) ok(adps[0].gateway || !adps.some(a => a.gateway), 'el primero es el que tiene gateway', adps.map(a => [a.name, a.gateway]));

  console.log('\n[6] Lectura de IP del primer adaptador');
  const cfg = await T.readIpConfig(adps[0].name);
  console.log('       ' + JSON.stringify(cfg));
  ok(cfg.success, 'lectura correcta');
  ok(Array.isArray(cfg.ips), 'devuelve todas las IPv4 del adaptador');
  ok(!cfg.ip || T.isValidIp(cfg.ip), 'IP principal válida');
  ok(cfg.ip === null || !cfg.ip.startsWith('169.254.'), 'nunca devuelve APIPA como principal');
  ok(cfg.mask === null || T.isValidMask(cfg.mask), 'máscara derivada del prefijo válida', cfg.mask);
  const idx = await T.getInterfaceIndex(adps[0].name);
  ok(Number.isInteger(idx), 'índice de interfaz resuelto', idx);
  const bad = await T.readIpConfig('Adaptador Que No Existe 999');
  ok(bad.success === false, 'adaptador inexistente → success:false sin excepción');

  console.log('\n[7] IP principal del equipo (tray)');
  const prim = await T.getPrimaryIpInfo();
  console.log('       ' + JSON.stringify(prim));
  ok(prim && T.isValidIp(prim.ip), 'IP principal detectada');
  ok(prim && !prim.ip.startsWith('169.254.'), 'no es APIPA');

  console.log('\n[8] Vecinos (Get-NetNeighbor con estado)');
  const nb = await T.readNeighbors();
  ok(nb instanceof Map, 'devuelve un Map');
  ok(nb.size > 0, 'hay vecinos en la tabla', nb.size);
  const sample = [...nb.entries()].slice(0, 5);
  console.log('       ' + JSON.stringify(sample));
  ok(sample.every(([ip, n]) => T.isValidIp(ip) && /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(n.mac)), 'IP y MAC normalizadas');
  ok([...nb.keys()].every(ip => Number(ip.split('.')[0]) < 224), 'sin multicast');
  ok([...nb.values()].some(n => n.state && n.state !== 'Unknown'), 'con estado real (Reachable/Stale/...)', [...new Set([...nb.values()].map(n => n.state))]);
  ok(T.lookupVendor('B8:27:EB:11:22:33') === 'Raspberry Pi', 'OUI reconocido');

  console.log('\n[9] Ping');
  const self = await T.pingHostWithLatency('127.0.0.1', 900);
  ok(self.alive === true, 'localhost responde', self);
  const dead = await T.pingHostWithLatency('192.0.2.123', 500);
  ok(dead.alive === false, 'IP de documentación no responde', dead);
  const inj = await T.pingHostWithLatency('127.0.0.1 & echo INYECTADO', 500);
  ok(inj.alive === false, 'IP inválida no llega a la shell (inyección bloqueada)', inj);

  console.log('\n[10] Handlers IPC registrados');
  const need = ['load-profiles', 'save-profiles', 'get-adapters', 'apply-ip', 'set-dhcp',
    'get-current-ip', 'get-ip-config', 'capture-current', 'ping-test', 'export-profiles',
    'import-profiles', 'get-settings', 'save-settings', 'get-history', 'clear-history',
    'watch-start', 'watch-stop', 'watch-status', 'watch-tick-now', 'scan-network',
    'cancel-scan', 'get-app-info'];
  const missing = need.filter(n => !handlers.has(n));
  ok(missing.length === 0, 'todos los handlers que usa el preload existen', missing);

  const applyBad = await handlers.get('apply-ip')(null, { adapter: 'X', ip: '192.168.1.0', mask: '255.255.255.0' });
  ok(applyBad.success === false && /red/.test(applyBad.error), 'apply-ip rechaza la dirección de red sin pedir UAC', applyBad);
  const applyBad2 = await handlers.get('apply-ip')(null, { adapter: 'X', ip: '192.168.1.5', mask: '255.0.255.0' });
  ok(applyBad2.success === false && /scara/.test(applyBad2.error), 'apply-ip rechaza máscara no contigua', applyBad2);
  const applyBad3 = await handlers.get('apply-ip')(null, { adapter: 'X', ip: '192.168.1.5', mask: '255.255.255.0', dns: 'ocho.ocho' });
  ok(applyBad3.success === false && /DNS/.test(applyBad3.error), 'apply-ip rechaza DNS inválido', applyBad3);
  const applyBad4 = await handlers.get('apply-ip')(null, { ip: '192.168.1.5', mask: '255.255.255.0' });
  ok(applyBad4.success === false, 'apply-ip sin adaptador', applyBad4);

  console.log('\n[11] Codificación BER');
  // 1.3.6.1.2.1.1.1.0 → 06 08 2b 06 01 02 01 01 01 00  (valor conocido del estándar)
  ok(T.berOid('1.3.6.1.2.1.1.1.0').toString('hex') === '06082b06010201010100',
    'OID sysDescr codificado según el estándar', T.berOid('1.3.6.1.2.1.1.1.0').toString('hex'));
  // sub-identificador > 127 debe ir en base 128: 1745 = 0x8D 0x51
  ok(T.berOid('1.3.6.1.4.1.9.1.1745').toString('hex').endsWith('8d51'),
    'sub-identificador grande en base 128', T.berOid('1.3.6.1.4.1.9.1.1745').toString('hex'));
  ok(T.berInteger(0).toString('hex') === '020100', 'entero 0');
  ok(T.berInteger(200).toString('hex') === '020200c8', 'entero 200 sin signo', T.berInteger(200).toString('hex'));
  ok(T.berDecodeOid(T.berOid('1.3.6.1.2.1.1.5.0').slice(2)) === '1.3.6.1.2.1.1.5.0', 'OID ida y vuelta');

  console.log('\n[12] Paquete SNMP GetRequest');
  const pkt = T.snmpBuildGet([T.OID_SYS_DESCR, T.OID_SYS_NAME], 'public', 12345);
  const seq = T.berRead(pkt, 0);
  ok(seq && seq.tag === 0x30, 'empieza por SEQUENCE');
  const ver = T.berRead(seq.value, 0);
  ok(ver.value[0] === 1, 'versión 1 (SNMPv2c)', ver.value[0]);
  const com = T.berRead(seq.value, ver.end);
  ok(com.value.toString() === 'public', 'comunidad', com.value.toString());
  const pdu = T.berRead(seq.value, com.end);
  ok(pdu.tag === 0xA0, 'PDU GetRequest (0xA0)', pdu && pdu.tag.toString(16));

  console.log('\n[13] Parseo de una respuesta');
  // Se construye un GetResponse válido y se comprueba que el parser lo lee
  const vb = (oid, str) => T.berTlv(0x30, Buffer.concat([T.berOid(oid), T.berTlv(0x04, Buffer.from(str, 'utf8'))]));
  const respPdu = T.berTlv(0xA2, Buffer.concat([
    T.berInteger(12345), T.berInteger(0), T.berInteger(0),
    T.berTlv(0x30, Buffer.concat([
      vb(T.OID_SYS_DESCR, 'Cisco IOS Software, C2960 Switch, Version 15.0'),
      vb(T.OID_SYS_NAME, 'SW-PLANTA-1'),
    ])),
  ]));
  const resp = T.berTlv(0x30, Buffer.concat([T.berInteger(1), T.berTlv(0x04, Buffer.from('public')), respPdu]));
  const parsed = T.snmpParseResponse(resp);
  ok(parsed !== null, 'respuesta parseada');
  ok(parsed?.varbinds[T.OID_SYS_DESCR]?.startsWith('Cisco IOS'), 'sysDescr recuperado', parsed?.varbinds[T.OID_SYS_DESCR]);
  ok(parsed?.varbinds[T.OID_SYS_NAME] === 'SW-PLANTA-1', 'sysName recuperado', parsed?.varbinds[T.OID_SYS_NAME]);
  ok(T.snmpParseResponse(Buffer.from([1, 2, 3])) === null, 'basura → null, sin excepción');
  ok(T.snmpParseResponse(Buffer.alloc(0)) === null, 'vacío → null');
  // Una respuesta larga obliga a la longitud BER de varios bytes
  const largo = 'X'.repeat(400);
  const respLargo = T.berTlv(0x30, Buffer.concat([T.berInteger(1), T.berTlv(0x04, Buffer.from('public')),
    T.berTlv(0xA2, Buffer.concat([T.berInteger(1), T.berInteger(0), T.berInteger(0),
      T.berTlv(0x30, vb(T.OID_SYS_DESCR, largo))]))]));
  ok(T.snmpParseResponse(respLargo)?.varbinds[T.OID_SYS_DESCR]?.length === 400, 'longitud BER larga (>127 bytes)');

  console.log('\n[14] Sondeo TCP');
  const srv = net.createServer(s => s.end());
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const puerto = srv.address().port;
  ok(await T.tcpProbe('127.0.0.1', puerto, 800) === true, `puerto abierto ${puerto} detectado`);
  srv.close();
  await new Promise(r => setTimeout(r, 200));
  ok(await T.tcpProbe('127.0.0.1', puerto, 800) === false, 'puerto cerrado detectado');
  const t0 = Date.now();
  ok(await T.tcpProbe('192.0.2.77', 102, 600) === false, 'IP inalcanzable no cuelga');
  ok(Date.now() - t0 < 2000, 'respeta el timeout', Date.now() - t0);

  console.log('\n[15] Clasificación');
  const c = (ports, extra = {}) => T.classifyDevice({ openPorts: ports, isGateway: false, snmp: null, ...extra });
  ok(c([102, 80]).type === 'PLC', 'puerto 102 → PLC', c([102, 80]));
  ok(c([102]).typeDetail?.includes('Siemens'), 'detalle Siemens en el 102', c([102]).typeDetail);
  ok(c([502]).type === 'PLC', 'Modbus → PLC');
  ok(c([44818]).type === 'PLC', 'EtherNet/IP → PLC');
  ok(c([4840]).type === 'SCADA / OPC UA', 'OPC UA');
  ok(c([5900, 80]).type === 'HMI / panel', 'VNC + web → HMI');
  ok(c([9100, 80]).type === 'Impresora', 'JetDirect → impresora');
  ok(c([80, 443], { isGateway: true }).type === 'Router', 'gateway → router');
  ok(c([23, 80]).type === 'Equipo de red', 'Telnet + web → equipo de red', c([23,80]));
  ok(c([22, 80]).type === 'Servidor / SSH', 'SSH + web → servidor, no se inventa switch', c([22,80]));
  ok(c([515]).type === null, '515 solo (TV LG) ya no es impresora', c([515]));
  ok(c([9100]).type === 'Impresora', '9100 sí es impresora');
  ok(c([3389, 445]).type === 'PC', 'RDP/SMB → PC');
  ok(c([]).type === null, 'sin puertos → sin tipo');
  const snmpSw = c([23, 80], { snmp: { sysDescr: 'Cisco IOS Software, C2960 Switch' } });
  ok(snmpSw.type === 'Switch gestionado', 'SNMP manda sobre la heurística', snmpSw);
  ok(c([102], { snmp: { sysDescr: 'SIMATIC S7-1200' } }).type === 'PLC', 'el protocolo industrial manda sobre SNMP');
  ok(c([102, 80]).services.join() === '102/S7comm,80/HTTP', 'servicios listados, los industriales primero', c([102, 80]).services);


  console.log('\n' + (fails === 0 ? 'TODO OK' : fails + ' PRUEBA(S) FALLIDA(S)'));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('EXCEPCIÓN:', e); process.exit(2); });
