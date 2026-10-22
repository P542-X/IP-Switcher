import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
const DEFAULT_PROFILES = [
  { id: "1", name: "Oficina", ip: "192.168.1.100", mask: "255.255.255.0", gateway: "192.168.1.1", dns: "8.8.8.8", dns2: "8.8.4.4", ports: [{ port: "80", label: "HTTP" }, { port: "443", label: "HTTPS" }, { port: "22", label: "SSH" }], color: "#10b981" },
  { id: "2", name: "Casa", ip: "192.168.0.50", mask: "255.255.255.0", gateway: "192.168.0.1", dns: "1.1.1.1", dns2: "", ports: [{ port: "3000", label: "Dev" }, { port: "5432", label: "PostgreSQL" }], color: "#8b5cf6" },
];
const PALETTE = [
  "#10b981", "#059669", "#14b8a6", "#06b6d4", "#0ea5e9", "#3b82f6",
  "#6366f1", "#8b5cf6", "#a855f7", "#d946ef", "#ec4899", "#f43f5e",
  "#ef4444", "#f97316", "#f59e0b", "#eab308", "#84cc16", "#22c55e",
  "#64748b", "#78716c", "#0891b2", "#be185d", "#7c3aed", "#e11d48",
];
const DEFAULT_ACCENT = "#10b981";
const generateId = () => Date.now().toString(36) + Math.random().toString(36).slice(2);

// ─── VALIDADORES ─────────────────────────────────────────────────────────────
const isValidIp = (s) => {
  if (!s) return false;
  const parts = String(s).trim().split(".");
  if (parts.length !== 4) return false;
  // Antes se aceptaban octetos como "01" o "007": netsh los rechaza o los
  // interpreta de otra forma, así que el perfil se guardaba con una IP que
  // luego no se podía aplicar nunca.
  return parts.every(p => /^(0|[1-9][0-9]{0,2})$/.test(p) && +p <= 255);
};
const ipToInt = (s) => String(s).trim().split(".").reduce((a, o) => ((a << 8) + (+o)) >>> 0, 0) >>> 0;
const isValidMask = (s) => {
  if (!isValidIp(s)) return false;
  const bin = String(s).split(".").map(p => (+p).toString(2).padStart(8, "0")).join("");
  return /^1*0*$/.test(bin) && bin.includes("1");
};
const maskToPrefix = (m) => (isValidMask(m) ? ipToInt(m).toString(2).split("1").length - 1 : null);
// Dirección de red y de broadcast: Windows no las admite como IP de host, y al
// aplicarlas la interfaz se quedaba sin red.
const ipRoleInSubnet = (ip, mask) => {
  if (!isValidIp(ip) || !isValidMask(mask)) return "unknown";
  if (maskToPrefix(mask) >= 31) return "host";
  const m = ipToInt(mask);
  const v = ipToInt(ip);
  if (((v & ~m) >>> 0) === 0) return "network";
  if (((v & ~m) >>> 0) === ((~m) >>> 0)) return "broadcast";
  return "host";
};
const prefixToMaskStr = (prefix) => {
  const p = parseInt(prefix, 10);
  if (!(p >= 0 && p <= 32)) return null;
  const n = p === 0 ? 0 : (0xFFFFFFFF << (32 - p)) >>> 0;
  return [24, 16, 8, 0].map(sh => (n >>> sh) & 255).join(".");
};
const isValidHex = (s) => /^#[0-9a-fA-F]{6}$/.test(s);

const formatTime = (ts) => {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (sameDay) return `${hh}:${mm}`;
  return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")} ${hh}:${mm}`;
};

// ─── ICONS ───────────────────────────────────────────────────────────────────
const Icons = {
  Network: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><circle cx="12" cy="5" r="3"/><circle cx="5" cy="19" r="3"/><circle cx="19" cy="19" r="3"/><line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="13" x2="5" y2="16"/><line x1="12" y1="13" x2="19" y2="16"/></svg>,
  Plus: ({ size = 14 }) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Edit: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Trash: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>,
  Copy: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>,
  Check: () => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>,
  Minimize: () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="5" y1="19" x2="19" y2="19"/></svg>,
  Maximize: () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>,
  Close: () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Refresh: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>,
  ArrowLeft: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  Search: () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  MoreV: () => <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/></svg>,
  Duplicate: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2"/></svg>,
  Zap: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  Download: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  Upload: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  History: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 102.13-9.36L1 10"/><path d="M12 7v5l4 2"/></svg>,
  Settings: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z"/></svg>,
  Info: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>,
  Capture: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12"/><polyline points="7 8 12 3 17 8"/><path d="M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7"/></svg>,
  Radar: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19.07 4.93A10 10 0 006.99 3.34"/><path d="M4 6h.01"/><path d="M2.29 9.62A10 10 0 1021.31 8.35"/><path d="M16.24 7.76a6 6 0 10-8.49 8.49"/><path d="M12 12l5 5"/></svg>,
  Chevron: () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>,
  Eye: () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
};

// ═══ APP ═══════════════════════════════════════════════════════════════════
export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState("list");
  const [editingId, setEditingId] = useState(null);
  const [copied, setCopied] = useState(null);
  const [toast, setToast] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [dhcpConfirm, setDhcpConfirm] = useState(false);
  const [adapters, setAdapters] = useState([]);
  const [selectedAdapter, setSelectedAdapter] = useState("");
  const [applying, setApplying] = useState(false);
  const [ipConfig, setIpConfig] = useState(null);
  const [form, setForm] = useState({ name: "", ip: "", mask: "255.255.255.0", gateway: "", dns: "8.8.8.8", dns2: "", ports: [{ port: "", label: "" }], watchlist: [], color: DEFAULT_ACCENT });
  const [search, setSearch] = useState("");
  const [openMenu, setOpenMenu] = useState(null); // profile id con menú abierto
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [quickIndex, setQuickIndex] = useState(0);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pingModal, setPingModal] = useState(null); // { profile, results, testing }
  const [scanOpen, setScanOpen] = useState(false);
  const [scanBaseIp, setScanBaseIp] = useState("");
  const [scanPrefix, setScanPrefix] = useState(24);
  const [scanRange, setScanRange] = useState({ network: null, prefix: 24 });
  const [scanDevices, setScanDevices] = useState([]); // [{ip, mac, vendor, hostname, source}]
  const [scanProgress, setScanProgress] = useState({ done: 0, total: 0 });
  const [scanStatus, setScanStatus] = useState("idle"); // idle | running | done | error
  const [scanError, setScanError] = useState(null);
  // Watcher (monitor de equipos del perfil activo)
  const [watchItems, setWatchItems] = useState([]);      // estado actual recibido del main
  const [watchExpanded, setWatchExpanded] = useState(true);
  const [watchTicking, setWatchTicking] = useState(false);
  const [settings, setSettings] = useState({
    minimizeToTray: true,
    closeToTray: true,
    startMinimized: false,
    startWithWindows: false,
    showNotifications: true,
    watchNotifications: true,
    watchInterval: 15,
  });
  const [history, setHistory] = useState([]);
  const [appInfo, setAppInfo] = useState(null);

  const toastTimerRef = useRef(null);
  const selectedAdapterRef = useRef("");
  const searchRef = useRef(null);
  const quickInputRef = useRef(null);
  const isElectron = !!window.electronAPI;

  // ─── Toast ───────────────────────────────────────────────────────────────
  const showToast = useCallback((msg, ok = true) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ msg, ok });
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);
  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current); }, []);

  // ─── Refrescar IP ────────────────────────────────────────────────────────
  const refreshIpConfig = useCallback(async (adapter) => {
    if (!adapter || !isElectron) return;
    try {
      const cfg = await window.electronAPI.getIpConfig(adapter);
      setIpConfig(cfg?.success ? cfg : null);
    } catch { setIpConfig(null); }
  }, [isElectron]);

  // ─── Carga inicial ───────────────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      let data = null;
      if (isElectron) {
        data = await window.electronAPI.loadProfiles();
        try { const s = await window.electronAPI.getSettings(); if (s) setSettings(prev => ({ ...prev, ...s })); } catch {}
        try { setAppInfo(await window.electronAPI.getAppInfo()); } catch {}
      } else {
        try { const s = localStorage.getItem("ip-switcher"); if (s) data = JSON.parse(s); } catch {}
      }
      if (Array.isArray(data)) {
        data = data.map(p => { const { active, ...rest } = p; return { ...rest, color: rest.color || DEFAULT_ACCENT }; });
      }
      setProfiles(data || DEFAULT_PROFILES);

      if (isElectron) {
        try {
          const adps = await window.electronAPI.getAdapters();
          setAdapters(adps || []);
          if (adps?.length > 0) {
            selectedAdapterRef.current = adps[0].name;
            setSelectedAdapter(adps[0].name);
          }
        } catch {}
      }
      setLoaded(true);
    }
    init();
  }, [isElectron]);

  // Función reutilizable de refresco de adaptadores.
  // Devuelve el adaptador efectivo: antes quien la llamaba leía `selectedAdapter`
  // del closure, que seguía teniendo el valor anterior aunque aquí se hubiese
  // cambiado, y la IP se aplicaba a un adaptador que ya no existía.
  const refreshAdapters = useCallback(async () => {
    if (!isElectron) return null;
    try {
      const adps = await window.electronAPI.getAdapters();
      const list = adps || [];
      setAdapters(list);

      const prev = selectedAdapterRef.current;
      const effective = (prev && list.some(a => a.name === prev))
        ? prev
        : (list[0]?.name || "");
      if (effective !== prev) {
        selectedAdapterRef.current = effective;
        setSelectedAdapter(effective);
      }
      return effective;
    } catch { return selectedAdapterRef.current || null; }
  }, [isElectron]);

  // El ref va siempre en paralelo al estado para poder leerlo sin esperar a React
  useEffect(() => { selectedAdapterRef.current = selectedAdapter; }, [selectedAdapter]);

  // Polling de IP actual. Ya no se detiene fuera de la vista de lista: el
  // escáner y el formulario también usan ipConfig (máscara y gateway reales).
  useEffect(() => {
    if (!selectedAdapter || !isElectron) return;
    refreshIpConfig(selectedAdapter);
    const id = setInterval(() => { if (!document.hidden) refreshIpConfig(selectedAdapter); }, 10000);
    return () => clearInterval(id);
  }, [selectedAdapter, isElectron, refreshIpConfig]);


  // Polling de adaptadores (detecta cambios de red: WiFi→Ethernet, cable conectado/desconectado, VPN up/down)
  useEffect(() => {
    if (!isElectron) return;
    const id = setInterval(() => {
      if (!document.hidden) refreshAdapters();
    }, 8000);
    return () => clearInterval(id);
  }, [isElectron, refreshAdapters]);

  // Re-detectar adaptadores cuando la ventana gana foco (el usuario acaba de volver al PC)
  useEffect(() => {
    if (!isElectron) return;
    const onFocus = () => refreshAdapters();
    window.addEventListener('focus', onFocus);
    const onVisibility = () => { if (!document.hidden) refreshAdapters(); };
    document.addEventListener('visibilitychange', onVisibility);
    const onOnline = () => refreshAdapters();
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onOnline);
    };
  }, [isElectron, refreshAdapters]);

  const save = useCallback(async (updated) => {
    setProfiles(updated);
    if (isElectron) await window.electronAPI.saveProfiles(updated);
    else { try { localStorage.setItem("ip-switcher", JSON.stringify(updated)); } catch {} }
  }, [isElectron]);

  // ─── Perfil activo ───────────────────────────────────────────────────────
  const currentIp = ipConfig?.ip || null;
  const currentIps = useMemo(
    () => (ipConfig?.ips?.length ? ipConfig.ips : (currentIp ? [currentIp] : [])),
    [ipConfig, currentIp]
  );
  const isDhcp = !!ipConfig?.dhcp;
  // Se compara contra todas las direcciones IPv4 del adaptador: si quedaba una
  // segunda IP o una APIPA, el perfil recién aplicado no se reconocía como
  // activo y la tarjeta seguía mostrando "IP estática sin perfil guardado".
  const activeProfile = useMemo(
    () => (currentIps.length ? profiles.find(p => currentIps.includes(p.ip)) : null) || null,
    [currentIps, profiles]
  );

  // Acento global
  useEffect(() => {
    const color = activeProfile?.color || DEFAULT_ACCENT;
    document.documentElement.style.setProperty("--accent", color);
  }, [activeProfile]);

  // Arrancar/parar watcher según perfil activo
  // Re-ejecuta cuando cambia el perfil activo o cuando cambia su watchlist
  const activeWatchlistKey = useMemo(
    () => activeProfile?.watchlist ? `${activeProfile.id}:${JSON.stringify(activeProfile.watchlist)}` : null,
    [activeProfile]
  );
  useEffect(() => {
    if (!isElectron) return;
    if (activeProfile && activeProfile.watchlist?.length > 0) {
      window.electronAPI.watchStart(activeProfile).catch(() => {});
    } else {
      window.electronAPI.watchStop().catch(() => {});
      setWatchItems([]);
    }
  }, [isElectron, activeWatchlistKey, activeProfile]);

  // Listener de actualizaciones del watcher
  useEffect(() => {
    if (!isElectron) return;
    const off = window.electronAPI.onWatchUpdate((data) => {
      // Solo aceptar si coincide con el perfil activo actual
      if (data.profileId && activeProfile && data.profileId !== activeProfile.id) return;
      setWatchItems(data.items || []);
    });
    return () => off?.();
  }, [isElectron, activeProfile]);

  const refreshWatchNow = async () => {
    if (!isElectron || watchTicking) return;
    setWatchTicking(true);
    try { await window.electronAPI.watchTickNow(); }
    catch {}
    finally { setTimeout(() => setWatchTicking(false), 400); }
  };

  // ─── Acciones ────────────────────────────────────────────────────────────
  const activateProfileById = useCallback(async (id) => {
    const p = profiles.find(x => x.id === id);
    if (!p) return;
    if (!isElectron) { showToast("Modo navegador: solo simulación", false); return; }

    // El adaptador se toma de lo que devuelve el refresco, no del closure.
    const currentAdapter = (await refreshAdapters()) || selectedAdapterRef.current;
    if (!currentAdapter) { showToast("No hay adaptador activo. Conecta el cable o WiFi.", false); return; }

    setApplying(true);
    try {
      const result = await window.electronAPI.applyIp({
        adapter: currentAdapter, ip: p.ip, mask: p.mask,
        gateway: p.gateway || "", dns: p.dns || "", dns2: p.dns2 || "",
        profileName: p.name,
      });
      if (result.success) {
        showToast(
          `IP ${p.ip} aplicada en "${currentAdapter}"${result.warning ? " ⚠ " + result.warning : ""}`,
          !result.warning
        );
        // El proceso principal ya ha confirmado que el adaptador tiene la IP y
        // devuelve la configuración leída, así que la pantalla se actualiza al
        // instante en vez de esperar al sondeo de 10 s. Los refrescos extra son
        // para el gateway y el DNS, que Windows publica un poco más tarde.
        if (result.config?.success) setIpConfig(result.config);
        refreshIpConfig(currentAdapter);
        setTimeout(() => refreshIpConfig(currentAdapter), 1500);
        setTimeout(() => refreshIpConfig(currentAdapter), 4000);
      } else if (result.cancelled) {
        showToast("Cancelado: cambiar la IP necesita permisos de administrador", false);
      } else {
        // Refrescar adaptadores por si el error viene de que el adaptador desapareció
        refreshAdapters();
        showToast(`Error: ${result.error}`, false);
      }
    } catch (err) {
      refreshAdapters();
      showToast(`Error: ${err.message}`, false);
    } finally { setApplying(false); }
  }, [profiles, isElectron, showToast, refreshIpConfig, refreshAdapters]);

  const applyDhcp = useCallback(async () => {
    setDhcpConfirm(false);
    if (!isElectron) { showToast("Adaptador no disponible", false); return; }
    const currentAdapter = (await refreshAdapters()) || selectedAdapterRef.current;
    if (!currentAdapter) { showToast("No hay adaptador activo.", false); return; }
    setApplying(true);
    try {
      const result = await window.electronAPI.setDhcp(currentAdapter);
      if (result.success) {
        showToast(
          `"${currentAdapter}" vuelto a DHCP${result.warning ? " ⚠ " + result.warning : ""}`,
          !result.warning
        );
        if (result.config?.success) setIpConfig(result.config);
        refreshIpConfig(currentAdapter);
        setTimeout(() => refreshIpConfig(currentAdapter), 1500);
        setTimeout(() => refreshIpConfig(currentAdapter), 4000);
      } else if (result.cancelled) {
        showToast("Cancelado: volver a DHCP necesita permisos de administrador", false);
      } else {
        refreshAdapters();
        showToast(`Error: ${result.error}`, false);
      }
    } catch (err) {
      refreshAdapters();
      showToast(`Error: ${err.message}`, false);
    }
    finally { setApplying(false); }
  }, [isElectron, showToast, refreshIpConfig, refreshAdapters]);

  const deleteProfile = async (id) => {
    const p = profiles.find(x => x.id === id);
    await save(profiles.filter(x => x.id !== id));
    setDeleteConfirm(null);
    showToast(`"${p?.name}" eliminado`);
  };

  const duplicateProfile = async (id) => {
    const p = profiles.find(x => x.id === id);
    if (!p) return;
    const base = p.name.replace(/\s*\(copia(\s*\d+)?\)\s*$/i, "");
    let name = `${base} (copia)`;
    let n = 2;
    while (profiles.some(x => x.name.toLowerCase() === name.toLowerCase())) {
      name = `${base} (copia ${n})`;
      n++;
    }
    const copy = {
      ...p,
      id: generateId(),
      name,
      watchlist: (p.watchlist || []).map(w => ({ ...w, id: generateId() })),
    };
    await save([...profiles, copy]);
    showToast(`"${name}" creado`);
  };

  const captureCurrent = async () => {
    if (!isElectron || !selectedAdapter) { showToast("Adaptador no disponible", false); return; }
    try {
      const r = await window.electronAPI.captureCurrent(selectedAdapter);
      if (!r.success) { showToast(r.error || "No se pudo leer la configuración", false); return; }
      setEditingId(null);
      setForm({
        name: "Capturado " + new Date().toLocaleTimeString().slice(0, 5),
        ip: r.data.ip, mask: r.data.mask,
        gateway: r.data.gateway, dns: r.data.dns, dns2: r.data.dns2,
        ports: [{ port: "", label: "" }],
        watchlist: [],
        color: PALETTE[profiles.length % PALETTE.length],
      });
      setView("form");
      showToast("Config capturada. Revisa y guarda.");
    } catch (err) { showToast(`Error: ${err.message}`, false); }
  };

  const runPingTest = async (profile) => {
    if (!isElectron) return;
    setPingModal({ profile, results: null, testing: true });
    try {
      const results = await window.electronAPI.pingTest({ gateway: profile.gateway, dns: profile.dns });
      setPingModal({ profile, results, testing: false });
    } catch (err) {
      setPingModal({ profile, results: { error: err.message }, testing: false });
    }
  };

  const exportProfiles = async () => {
    if (!isElectron) { showToast("Solo disponible en la app", false); return; }
    try {
      const r = await window.electronAPI.exportProfiles(profiles);
      if (r.success) showToast(`Exportado: ${r.path.split(/[\\/]/).pop()}`);
      else if (!r.canceled) showToast(`Error: ${r.error}`, false);
    } catch (err) { showToast(`Error: ${err.message}`, false); }
  };

  const importProfiles = async () => {
    if (!isElectron) { showToast("Solo disponible en la app", false); return; }
    try {
      const r = await window.electronAPI.importProfiles();
      if (r.canceled) return;
      if (!r.success) { showToast(`Error: ${r.error}`, false); return; }
      // merge: añadir nuevos con IDs frescos, evitar duplicados de nombre
      const existingNames = new Set(profiles.map(p => p.name.toLowerCase()));
      const toAdd = r.profiles
        .filter(p => p && p.name && p.ip && p.mask)
        .map(p => {
          let name = p.name;
          let n = 2;
          while (existingNames.has(name.toLowerCase())) { name = `${p.name} (${n++})`; }
          existingNames.add(name.toLowerCase());
          const { active, ...rest } = p;
          return { ...rest, id: generateId(), name, color: rest.color || DEFAULT_ACCENT };
        });
      if (toAdd.length === 0) { showToast("No había perfiles válidos", false); return; }
      await save([...profiles, ...toAdd]);
      showToast(`${toAdd.length} perfil${toAdd.length > 1 ? "es" : ""} importado${toAdd.length > 1 ? "s" : ""}`);
    } catch (err) { showToast(`Error: ${err.message}`, false); }
  };

  const openNew = () => {
    setEditingId(null);
    setForm({ name: "", ip: "", mask: "255.255.255.0", gateway: "", dns: "8.8.8.8", dns2: "", ports: [{ port: "", label: "" }], watchlist: [], color: PALETTE[profiles.length % PALETTE.length] });
    setView("form");
  };

  const openEdit = (p) => {
    setEditingId(p.id);
    setForm({
      name: p.name, ip: p.ip, mask: p.mask,
      gateway: p.gateway || "", dns: p.dns || "", dns2: p.dns2 || "",
      ports: p.ports?.length ? p.ports : [{ port: "", label: "" }],
      watchlist: p.watchlist || [],
      color: p.color || DEFAULT_ACCENT,
    });
    setView("form");
  };

  // Comprueba si dos IPs están en la misma subred según una máscara
  const sameSubnet = (ip1, ip2, mask) => {
    if (!isValidIp(ip1) || !isValidIp(ip2) || !isValidMask(mask)) return true; // no bloquear en caso de duda
    const toInt = (s) => s.split(".").reduce((acc, o) => (acc << 8) + parseInt(o, 10), 0) >>> 0;
    return (toInt(ip1) & toInt(mask)) === (toInt(ip2) & toInt(mask));
  };

  const saveForm = async () => {
    const name = form.name.trim();
    const ip = form.ip.trim();
    const mask = form.mask.trim();
    const gateway = form.gateway.trim();
    const dns = form.dns.trim();
    const dns2 = form.dns2.trim();

    if (!name) return showToast("El nombre es obligatorio", false);
    if (!isValidIp(ip)) return showToast("IP inválida", false);
    if (!isValidMask(mask)) return showToast("Máscara inválida", false);
    const ipRole = ipRoleInSubnet(ip, mask);
    if (ipRole === "network") return showToast(`${ip} es la dirección de red de /${maskToPrefix(mask)}; Windows no la admite`, false);
    if (ipRole === "broadcast") return showToast(`${ip} es la dirección de broadcast de /${maskToPrefix(mask)}; Windows no la admite`, false);
    if (gateway && !isValidIp(gateway)) return showToast("Gateway inválido", false);
    if (dns && !isValidIp(dns)) return showToast("DNS primario inválido", false);
    if (dns2 && !isValidIp(dns2)) return showToast("DNS secundario inválido", false);

    const dup = profiles.find(p => p.name.trim().toLowerCase() === name.toLowerCase() && p.id !== editingId);
    if (dup) return showToast(`Ya existe un perfil llamado "${name}"`, false);

    // Validar que gateway esté en la misma subred que la IP (advertencia suave, no bloquea)
    if (gateway && !sameSubnet(ip, gateway, mask)) {
      showToast(`⚠ Aviso: el gateway ${gateway} no está en la subred de ${ip}/${mask}`, false);
    }

    // Validar y limpiar watchlist (solo filas con IP válida)
    const watchlistRaw = (form.watchlist || []);
    for (const w of watchlistRaw) {
      if (w.ip && w.ip.trim() && !isValidIp(w.ip.trim())) {
        return showToast(`IP de vigilancia inválida: ${w.ip}`, false);
      }
    }
    const watchlist = watchlistRaw
      .map(w => ({
        id: w.id || generateId(),
        ip: (w.ip || "").trim(),
        label: (w.label || "").trim(),
      }))
      .filter(w => w.ip);

    const ports = form.ports.map(p => ({ port: p.port.trim(), label: p.label.trim() })).filter(p => p.port);
    const cleanForm = { name, ip, mask, gateway, dns, dns2, ports, watchlist, color: form.color };

    if (editingId) {
      const original = profiles.find(p => p.id === editingId);
      await save(profiles.map(p => p.id === editingId ? { ...p, ...cleanForm } : p));
      if (original && ipConfig?.ip === original.ip && original.ip !== ip) {
        showToast(`Perfil actualizado. Re-aplica para surtir efecto.`);
      } else { showToast("Perfil actualizado"); }
    } else {
      await save([...profiles, { id: generateId(), ...cleanForm }]);
      showToast("Perfil creado");
    }
    setView("list");
  };

  const copyText = async (text, key) => {
    try { await navigator.clipboard.writeText(text); } catch {}
    setCopied(key);
    setTimeout(() => setCopied(null), 1500);
  };

  const updatePort = (idx, field, val) => {
    const p = [...form.ports];
    p[idx] = { ...p[idx], [field]: val };
    setForm(f => ({ ...f, ports: p }));
  };

  const openExtLink = (url) => {
    if (isElectron && window.electronAPI.openExternal) window.electronAPI.openExternal(url);
    else window.open(url, "_blank", "noopener");
  };

  const openSettings = async () => {
    if (isElectron) {
      try { const s = await window.electronAPI.getSettings(); if (s) setSettings(prev => ({ ...prev, ...s })); } catch {}
    }
    setSettingsOpen(true);
  };

  const updateSetting = async (key, value) => {
    if (!isElectron) return;
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    try { await window.electronAPI.saveSettings(updated); }
    catch (err) { showToast(`Error guardando: ${err.message}`, false); }
  };

  const openHistory = async () => {
    if (isElectron) {
      try { setHistory(await window.electronAPI.getHistory()); } catch {}
    }
    setHistoryOpen(true);
  };

  const clearHistoryList = async () => {
    if (!isElectron) return;
    try { await window.electronAPI.clearHistory(); setHistory([]); showToast("Historial borrado"); }
    catch (err) { showToast(`Error: ${err.message}`, false); }
  };

  // ─── Perfiles filtrados por búsqueda ─────────────────────────────────────
  const filteredProfiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.ip.includes(q) ||
      (p.gateway || "").includes(q)
    );
  }, [profiles, search]);

  const quickFiltered = useMemo(() => {
    const q = quickQuery.trim().toLowerCase();
    if (!q) return profiles;
    return profiles.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.ip.includes(q)
    );
  }, [profiles, quickQuery]);

  // Cerrar quick switcher al cambiar de perfiles filtrados
  useEffect(() => { setQuickIndex(0); }, [quickQuery]);

  // ─── LISTENERS tray / global shortcut ────────────────────────────────────
  useEffect(() => {
    if (!isElectron) return;
    const offActivate = window.electronAPI.onTrayActivateProfile((id) => {
      activateProfileById(id);
    });
    const offDhcp = window.electronAPI.onTrayApplyDhcp(() => applyDhcp());
    const offQuick = window.electronAPI.onOpenQuickSwitcher(() => {
      setQuickQuery("");
      setQuickIndex(0);
      setQuickOpen(true);
    });
    return () => { offActivate?.(); offDhcp?.(); offQuick?.(); };
  }, [isElectron, activateProfileById, applyDhcp]);

  // Focus del input del quick switcher al abrirlo
  useEffect(() => {
    if (quickOpen) setTimeout(() => quickInputRef.current?.focus(), 50);
  }, [quickOpen]);

  // ─── ESCÁNER DE RED ──────────────────────────────────────────────────────
  // Base y máscara del barrido. Antes se asumía siempre /24; ahora se usa el
  // prefijo real del adaptador seleccionado.
  const selectedAdapterInfo = useMemo(
    () => adapters.find(a => a.name === selectedAdapter) || null,
    [adapters, selectedAdapter]
  );

  const inferScanBase = useCallback((preferred) => {
    const prefix = ipConfig?.prefix ?? selectedAdapterInfo?.prefix ?? 24;
    const pick = () => {
      if (preferred && isValidIp(preferred)) return preferred;
      if (form.gateway && isValidIp(form.gateway)) return form.gateway;
      if (ipConfig?.gateway && isValidIp(ipConfig.gateway)) return ipConfig.gateway;
      if (ipConfig?.ip && isValidIp(ipConfig.ip)) return ipConfig.ip;
      if (selectedAdapterInfo?.ip && isValidIp(selectedAdapterInfo.ip)) return selectedAdapterInfo.ip;
      return "192.168.1.1";
    };
    const gw = ipConfig?.gateway && isValidIp(ipConfig.gateway)
      ? ipConfig.gateway
      : (selectedAdapterInfo?.gateway || null);
    return { base: pick(), prefix, gateway: gw };
  }, [form.gateway, ipConfig, selectedAdapterInfo]);

  const startScan = useCallback(async (base, prefix, gateway) => {
    if (!isElectron || !isValidIp(base)) return;
    // Cancelar antes de relanzar: al pulsar "Re-escanear" el barrido anterior
    // seguía vivo lanzando pings y los dos se estorbaban, de ahí que saliera
    // incompleto o distinto en cada pasada.
    try { await window.electronAPI.cancelScan(); } catch {}
    setScanDevices([]);
    setScanProgress({ done: 0, total: 0 });
    setScanRange({ network: null, prefix: prefix ?? 24 });
    setScanStatus("running");
    setScanError(null);
    try {
      await window.electronAPI.scanNetwork({ baseIp: base, prefix, gateway: gateway || null });
    } catch (err) {
      setScanStatus("error");
      setScanError(err.message);
    }
  }, [isElectron]);

  const openScan = (preferred) => {
    if (!isElectron) { showToast("Solo disponible en la app", false); return; }
    const { base, prefix, gateway } = inferScanBase(preferred);
    setScanBaseIp(base);
    setScanPrefix(prefix);
    setScanDevices([]);
    setScanProgress({ done: 0, total: 0 });
    setScanRange({ network: null, prefix });
    setScanStatus("running");
    setScanError(null);
    setScanOpen(true);
    startScan(base, prefix, gateway);
  };

  const closeScan = async () => {
    if (isElectron) { try { await window.electronAPI.cancelScan(); } catch {} }
    setScanStatus("idle");
    setScanOpen(false);
  };

  // Listeners IPC del scanner
  useEffect(() => {
    if (!isElectron) return;
    const offStart = window.electronAPI.onScanStart((data) => {
      setScanProgress({ done: 0, total: data.total });
      setScanRange({ network: data.network || null, prefix: data.prefix ?? 24 });
    });
    const offDevice = window.electronAPI.onScanDevice((dev) => {
      setScanDevices(prev => {
        if (prev.some(d => d.ip === dev.ip)) return prev;
        return [...prev, { ...dev, _new: true }];
      });
      // quitar flag _new después
      setTimeout(() => {
        setScanDevices(prev => prev.map(d => d.ip === dev.ip ? { ...d, _new: false } : d));
      }, 500);
    });
    const offUpdate = window.electronAPI.onScanDeviceUpdate((dev) => {
      setScanDevices(prev => prev.map(d => d.ip === dev.ip ? { ...d, ...dev } : d));
    });
    const offProgress = window.electronAPI.onScanProgress((p) => {
      setScanProgress(p);
    });
    const offComplete = window.electronAPI.onScanComplete((data) => {
      setScanStatus(data.success ? "done" : "error");
      if (!data.success) setScanError(data.error);
    });
    return () => { offStart?.(); offDevice?.(); offUpdate?.(); offProgress?.(); offComplete?.(); };
  }, [isElectron]);

  // Equipos que han respondido de verdad. Los que solo estaban en la tabla ARP
  // caducada llegan con alive:false y ya no cuentan como encontrados.
  const scanAlive = useMemo(() => scanDevices.filter(d => d.alive !== false), [scanDevices]);

  // Usar una IP del scan → si estamos en form, rellena; si no, abre form nuevo
  const useScannedIp = (ip) => {
    setScanOpen(false);
    if (view === "form") {
      setForm(f => ({ ...f, ip }));
      showToast(`IP ${ip} puesta en el formulario`);
    } else {
      const parts = ip.split(".");
      const gateway = ipConfig?.gateway && isValidIp(ipConfig.gateway)
        ? ipConfig.gateway
        : `${parts[0]}.${parts[1]}.${parts[2]}.1`;
      setEditingId(null);
      setForm({
        name: "",
        ip,
        mask: prefixToMaskStr(scanRange.prefix ?? scanPrefix) || "255.255.255.0",
        gateway,
        dns: "8.8.8.8",
        dns2: "",
        ports: [{ port: "", label: "" }],
        watchlist: [],
        color: PALETTE[profiles.length % PALETTE.length],
      });
      setView("form");
    }
  };

  // El gateway real del adaptador si se conoce; si no, el .1 del rango
  const gatewayIp = useMemo(() => {
    if (ipConfig?.gateway && isValidIp(ipConfig.gateway)) return ipConfig.gateway;
    if (!scanBaseIp || !isValidIp(scanBaseIp)) return null;
    const parts = scanBaseIp.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.1`;
  }, [scanBaseIp, ipConfig]);

  // Siguiente IP libre del rango barrido. Cuentan como ocupadas TODAS las IPs
  // vistas, incluso las que no respondieron: puede ser un equipo apagado.
  const suggestFreeIp = useMemo(() => {
    if (!scanBaseIp || scanStatus === "idle") return null;
    const parts = scanBaseIp.split(".");
    if (parts.length !== 4) return null;
    const base = `${parts[0]}.${parts[1]}.${parts[2]}`;
    const occupied = new Set(scanDevices.map(d => d.ip));
    if (gatewayIp) occupied.add(gatewayIp);
    // Empezar desde .100, que suele ser rango libre para IPs estáticas
    for (let i = 100; i <= 200; i++) {
      const ip = `${base}.${i}`;
      if (!occupied.has(ip)) return ip;
    }
    for (let i = 2; i <= 254; i++) {
      const ip = `${base}.${i}`;
      if (!occupied.has(ip)) return ip;
    }
    return null;
  }, [scanBaseIp, scanDevices, scanStatus, gatewayIp]);

  const scanRangeLabel = useMemo(() => {
    const prefix = scanRange.prefix ?? scanPrefix ?? 24;
    if (scanRange.network) return `${scanRange.network}/${prefix}`;
    if (!isValidIp(scanBaseIp)) return "—";
    return `${scanBaseIp.split(".").slice(0, 3).join(".")}.0/${prefix}`;
  }, [scanRange, scanPrefix, scanBaseIp]);

  const ownIps = currentIps;


  useEffect(() => {
    const isTypingInInput = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

    const handler = (e) => {
      // Esc siempre funciona
      if (e.key === "Escape") {
        if (quickOpen)          { setQuickOpen(false); e.preventDefault(); return; }
        if (openMenu)           { setOpenMenu(null); e.preventDefault(); return; }
        if (scanOpen)           { closeScan(); e.preventDefault(); return; }
        if (pingModal)          { setPingModal(null); e.preventDefault(); return; }
        if (aboutOpen)          { setAboutOpen(false); e.preventDefault(); return; }
        if (settingsOpen)       { setSettingsOpen(false); e.preventDefault(); return; }
        if (historyOpen)        { setHistoryOpen(false); e.preventDefault(); return; }
        if (deleteConfirm)      { setDeleteConfirm(null); e.preventDefault(); return; }
        if (dhcpConfirm)        { setDhcpConfirm(false); e.preventDefault(); return; }
        if (view === "form")    { setView("list"); e.preventDefault(); return; }
      }

      const inInput = isTypingInInput(document.activeElement);
      const ctrlOrCmd = e.ctrlKey || e.metaKey;

      // Atajos de navegación (solo si no estás escribiendo en un input general)
      if (ctrlOrCmd && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuickQuery(""); setQuickIndex(0); setQuickOpen(true);
        return;
      }
      if (ctrlOrCmd && e.key.toLowerCase() === "f" && view === "list") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (ctrlOrCmd && e.key.toLowerCase() === "n" && !inInput) {
        e.preventDefault();
        openNew();
        return;
      }
      // Ctrl+1..9 → activar perfil N (solo si no estás escribiendo)
      if (ctrlOrCmd && /^[1-9]$/.test(e.key) && !inInput && view === "list") {
        const idx = parseInt(e.key, 10) - 1;
        const p = filteredProfiles[idx];
        if (p) { e.preventDefault(); activateProfileById(p.id); }
        return;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [quickOpen, openMenu, pingModal, aboutOpen, settingsOpen, historyOpen, deleteConfirm, dhcpConfirm, scanOpen, view, filteredProfiles, activateProfileById]);

  // ─── QUICK SWITCHER key handling ─────────────────────────────────────────
  const handleQuickKeyDown = (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setQuickIndex(i => Math.min(i + 1, quickFiltered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setQuickIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = quickFiltered[quickIndex];
      if (p) { setQuickOpen(false); activateProfileById(p.id); }
    }
  };

  // Cerrar menú al hacer click fuera
  useEffect(() => {
    if (!openMenu) return;
    const handler = () => setOpenMenu(null);
    setTimeout(() => document.addEventListener("click", handler), 0);
    return () => document.removeEventListener("click", handler);
  }, [openMenu]);

  if (!loaded) return <div className="loading-screen">INICIANDO…</div>;

  // ═══ RENDER ═════════════════════════════════════════════════════════════
  return (
    <div className="app">

      {/* ─── TITLE BAR ─────────────────────────────────────────────── */}
      <div className="titlebar">
        <div className="titlebar-left">
          <div className="app-icon"><Icons.Network /></div>
          <div>
            <span className="app-title"><span className="brand">IP</span>SWITCHER</span>
            <span className="app-signature">by Paulo Carrasco</span>
          </div>
        </div>

        {isElectron && adapters.length > 0 && (
          <div className="adapter-chip">
            <span className="pulse-dot" />
            <select value={selectedAdapter} onChange={e => { selectedAdapterRef.current = e.target.value; setSelectedAdapter(e.target.value); }}>
              {/* Se muestra la IP de cada adaptador: con varios activos (WSL,
                  VMware, VPN) no había forma de saber cuál se iba a cambiar. */}
              {adapters.map(a => (
                <option key={a.name} value={a.name} title={a.description || a.name}>
                  {a.name}{a.ip ? ` — ${a.ip}` : " — sin IP"}
                </option>
              ))}
            </select>
            {currentIp && <span className="current-ip">{currentIp}{isDhcp ? " · DHCP" : ""}</span>}
            <button className="refresh-btn" onClick={() => { refreshAdapters(); refreshIpConfig(selectedAdapter); }} title="Refrescar adaptadores"><Icons.Refresh /></button>
          </div>
        )}
        {isElectron && adapters.length === 0 && (
          <div className="adapter-chip" style={{ borderColor: "color-mix(in srgb, var(--warning) 40%, transparent)" }}>
            <span className="pulse-dot" style={{ background: "var(--warning)", boxShadow: "0 0 6px var(--warning)" }} />
            <span style={{ color: "var(--warning)" }}>Sin adaptador</span>
            <button className="refresh-btn" onClick={refreshAdapters} title="Reintentar detección"><Icons.Refresh /></button>
          </div>
        )}

        <div className="titlebar-tools">
          {isElectron && <button className="tool-btn" onClick={() => openScan()} title="Escanear red"><Icons.Radar /></button>}
          <button className="tool-btn" onClick={openHistory} title="Historial"><Icons.History /></button>
          <button className="tool-btn" onClick={openSettings} title="Ajustes"><Icons.Settings /></button>
          <button className="tool-btn" onClick={() => setAboutOpen(true)} title="Acerca de"><Icons.Info /></button>
        </div>

        {isElectron && (
          <div className="window-controls">
            <button className="window-control-btn" onClick={() => window.electronAPI.minimize()}><Icons.Minimize /></button>
            <button className="window-control-btn" onClick={() => window.electronAPI.maximize()}><Icons.Maximize /></button>
            <button className="window-control-btn close" onClick={() => window.electronAPI.close()}><Icons.Close /></button>
          </div>
        )}
      </div>

      {/* ─── BODY ─────────────────────────────────────────────────── */}
      <div className="app-body">

        {view === "list" && (
          <>
            {/* Active profile banner */}
            {isElectron && (
              <>
                {activeProfile ? (
                  <div className="active-banner">
                    <div className="active-eyebrow">
                      Perfil activo · Aplicado
                      {applying && <span style={{ marginLeft: 8, color: "var(--warning)" }}>· Aplicando…</span>}
                    </div>
                    <div className="active-name">{activeProfile.name}</div>
                    <div className="active-ip">{activeProfile.ip}</div>
                    <div className="active-meta">
                      {activeProfile.mask && <div className="meta-item"><span className="meta-label">Máscara</span><span className="meta-value">{activeProfile.mask}</span></div>}
                      {activeProfile.gateway && <div className="meta-item"><span className="meta-label">Gateway</span><span className="meta-value">{activeProfile.gateway}</span></div>}
                      {activeProfile.dns && <div className="meta-item"><span className="meta-label">DNS</span><span className="meta-value">{activeProfile.dns}{activeProfile.dns2 ? `, ${activeProfile.dns2}` : ""}</span></div>}
                    </div>

                    {activeProfile.ports?.length > 0 && (
                      <div className="port-row">
                        {activeProfile.ports.map((p, i) => (
                          <span key={i} className="port-tag" onClick={() => copyText(`${activeProfile.ip}:${p.port}`, `ap-${i}`)}>
                            <span className="port-num">:{p.port}</span>
                            {p.label && <span>{p.label}</span>}
                            {copied === `ap-${i}` ? <Icons.Check /> : <Icons.Copy />}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="active-actions">
                      <button className="btn btn-ghost btn-sm" onClick={() => setDhcpConfirm(true)} disabled={applying}>Volver a DHCP</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => runPingTest(activeProfile)}>
                        <Icons.Zap /> Probar conexión
                      </button>
                    </div>

                    {/* Monitor de equipos esperados */}
                    {activeProfile.watchlist && activeProfile.watchlist.length > 0 && (
                      <WatchSection
                        watchlist={activeProfile.watchlist}
                        items={watchItems}
                        expanded={watchExpanded}
                        onToggle={() => setWatchExpanded(v => !v)}
                        onRefresh={refreshWatchNow}
                        ticking={watchTicking}
                      />
                    )}
                  </div>
                ) : currentIp ? (
                  <div className="status-banner">
                    <div className="status-label">Estado del sistema</div>
                    <div className="status-content">
                      <div>
                        <div className="status-sub">{isDhcp ? "DHCP activo" : "IP estática sin perfil guardado"}</div>
                        <div className="status-ip">{currentIp}</div>
                      </div>
                      <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                        <button className="btn btn-ghost btn-sm" onClick={captureCurrent}>
                          <Icons.Capture /> Capturar como perfil
                        </button>
                        {!isDhcp && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setDhcpConfirm(true)} disabled={applying}>Volver a DHCP</button>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="status-banner neutral">
                    <div className="status-label">Sin conexión detectada</div>
                    <div className="status-sub">No se obtuvo IP en "{selectedAdapter || "—"}"</div>
                  </div>
                )}
              </>
            )}

            {isElectron && adapters.length === 0 && (
              <div className="warn-bar">⚠ No se detectaron adaptadores físicos activos.</div>
            )}

            {/* Search bar */}
            <div className="search-bar">
              <span className="search-icon"><Icons.Search /></span>
              <input
                ref={searchRef}
                className="search-input"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Buscar perfiles por nombre, IP o gateway…"
              />
              <span className="search-kbd">CTRL+F</span>
            </div>

            {/* Section head */}
            <div className="section-head">
              <div>
                <span className="section-head-label">Perfiles</span>
                <span className="section-head-count">{String(filteredProfiles.length).padStart(2, "0")}{search && ` / ${profiles.length}`}</span>
              </div>
              <div className="section-head-actions">
                {isElectron && <button className="btn btn-ghost btn-sm" onClick={captureCurrent} title="Guardar config actual como perfil"><Icons.Capture /> Capturar</button>}
                <button className="btn btn-ghost btn-sm" onClick={importProfiles} title="Importar JSON"><Icons.Upload /> Importar</button>
                <button className="btn btn-ghost btn-sm" onClick={exportProfiles} title="Exportar JSON"><Icons.Download /> Exportar</button>
                <button className="btn btn-primary btn-sm" onClick={openNew} title="Nuevo (Ctrl+N)">
                  <Icons.Plus size={12} /> Nuevo perfil
                </button>
              </div>
            </div>

            {/* Profiles grid */}
            <div className="profiles-grid">
              {filteredProfiles.map((p, idx) => {
                const isActive = activeProfile?.id === p.id;
                return (
                  <div key={p.id} className={`profile-card ${isActive ? "is-active" : ""}`} style={{ "--card-color": p.color, position: "relative" }}>
                    <div className="color-bar" />
                    {idx < 9 && !search && <span className="profile-shortcut">Ctrl+{idx + 1}</span>}
                    <div className="profile-card-header">
                      <span className="profile-dot" />
                      <span className="profile-name">{p.name}</span>
                      {isActive && <span className="badge badge-success">ACTIVO</span>}
                    </div>
                    <div className="profile-ip">{p.ip}</div>
                    <div className="profile-sub">
                      <span>/{p.mask}</span>
                      {p.gateway && <span>GW: {p.gateway}</span>}
                    </div>

                    {p.ports?.length > 0 && (
                      <div className="profile-ports">
                        {p.ports.map((pt, i) => (
                          <span key={i} className="port-tag" onClick={() => copyText(`${p.ip}:${pt.port}`, `${p.id}-${i}`)}>
                            <span className="port-num">:{pt.port}</span>
                            {pt.label && <span>{pt.label}</span>}
                            {copied === `${p.id}-${i}` ? <Icons.Check /> : <Icons.Copy />}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="profile-actions">
                      {!isActive ? (
                        <button className={`btn ${applying ? "btn-loading" : "btn-primary"} btn-sm btn-full`} onClick={() => activateProfileById(p.id)} disabled={applying}>
                          {applying ? <><span className="spinner" /> Aplicando…</> : "Activar + Aplicar"}
                        </button>
                      ) : (
                        <button className="btn btn-active btn-sm btn-full" disabled>Activo ✓</button>
                      )}
                      <button className="btn btn-ghost btn-sm btn-icon" onClick={() => openEdit(p)} title="Editar"><Icons.Edit /></button>
                      <div style={{ position: "relative" }}>
                        <button
                          className="btn btn-ghost btn-sm btn-icon"
                          onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === p.id ? null : p.id); }}
                          title="Más acciones"
                        >
                          <Icons.MoreV />
                        </button>
                        {openMenu === p.id && (
                          <div className="menu-popover" onClick={(e) => e.stopPropagation()}>
                            <button className="menu-item" onClick={() => { setOpenMenu(null); duplicateProfile(p.id); }}>
                              <Icons.Duplicate /> Duplicar
                            </button>
                            {isElectron && (
                              <button className="menu-item" onClick={() => { setOpenMenu(null); runPingTest(p); }}>
                                <Icons.Zap /> Probar conexión
                              </button>
                            )}
                            <div className="menu-sep" />
                            <button className="menu-item danger" onClick={() => { setOpenMenu(null); setDeleteConfirm(p.id); }}>
                              <Icons.Trash /> Eliminar
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {filteredProfiles.length === 0 && (
                <div className="empty-state">
                  {search ? `Sin resultados para "${search}"` : "No hay perfiles. Crea uno nuevo."}
                </div>
              )}
            </div>
          </>
        )}

        {/* ─── FORMULARIO ─────────────────────────────────────────── */}
        {view === "form" && (
          <div className="form-wrap">
            <button className="form-back" onClick={() => setView("list")}>
              <Icons.ArrowLeft /> Volver
            </button>
            <div className="form-title">{editingId ? "Editar perfil" : "Nuevo perfil"}</div>
            <div className="form-subtitle">Config · IPv4 Estática</div>

            <div className="input-group">
              <label className="input-label">Nombre del perfil</label>
              <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ej: Oficina principal" />
            </div>

            <div className="form-grid">
              <div className="input-group">
                <label className="input-label">Dirección IP</label>
                <input className="input" value={form.ip} onChange={e => setForm(f => ({ ...f, ip: e.target.value }))} placeholder="192.168.1.100" />
              </div>
              <div className="input-group">
                <label className="input-label">Máscara</label>
                <input className="input" value={form.mask} onChange={e => setForm(f => ({ ...f, mask: e.target.value }))} placeholder="255.255.255.0" />
              </div>
              <div className="input-group">
                <label className="input-label">Gateway</label>
                <input className="input" value={form.gateway} onChange={e => setForm(f => ({ ...f, gateway: e.target.value }))} placeholder="192.168.1.1" />
              </div>
              <div className="input-group">
                <label className="input-label">DNS primario</label>
                <input className="input" value={form.dns} onChange={e => setForm(f => ({ ...f, dns: e.target.value }))} placeholder="8.8.8.8" />
              </div>
              <div className="input-group full">
                <label className="input-label">DNS secundario</label>
                <input className="input" value={form.dns2} onChange={e => setForm(f => ({ ...f, dns2: e.target.value }))} placeholder="8.8.4.4 (opcional)" />
              </div>
            </div>

            {isElectron && (
              <div style={{ marginTop: -4, marginBottom: 4 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => openScan(form.gateway || form.ip)} title="Escanear red para ver qué IPs están libres">
                  <Icons.Radar /> Escanear red · sugerir IP libre
                </button>
              </div>
            )}

            <div className="divider" />

            <div className="input-group">
              <label className="input-label">Color del perfil</label>
              <div className="color-picker">
                <div className="color-swatches">
                  {PALETTE.map(c => (
                    <div
                      key={c}
                      className={`mini-swatch ${form.color.toLowerCase() === c.toLowerCase() ? "selected" : ""}`}
                      style={{ "--_c": c }}
                      onClick={() => setForm(f => ({ ...f, color: c }))}
                      title={c}
                    />
                  ))}
                </div>
                <div className="color-custom">
                  <input type="color" value={form.color} onChange={e => setForm(f => ({ ...f, color: e.target.value }))} />
                  <input
                    className="input color-hex"
                    value={form.color}
                    onChange={e => setForm(f => ({ ...f, color: e.target.value }))}
                    onBlur={e => { if (!isValidHex(e.target.value)) setForm(f => ({ ...f, color: DEFAULT_ACCENT })); }}
                    placeholder="#RRGGBB"
                  />
                </div>
              </div>
            </div>

            <div className="divider" />

            <div className="input-group">
              <label className="input-label">Puertos</label>
              {form.ports.map((p, i) => (
                <div key={i} className="port-list-item">
                  <input className="input" value={p.port} onChange={e => updatePort(i, "port", e.target.value)} placeholder="Puerto" />
                  <input className="input" value={p.label} onChange={e => updatePort(i, "label", e.target.value)} placeholder="Etiqueta (ej: HTTP)" />
                  <button className="port-delete-btn" onClick={() => setForm(f => ({ ...f, ports: f.ports.filter((_, j) => j !== i) }))} title="Quitar"><Icons.Trash /></button>
                </div>
              ))}
              <button className="add-port-btn" onClick={() => setForm(f => ({ ...f, ports: [...f.ports, { port: "", label: "" }] }))}>
                <Icons.Plus size={12} /> Añadir puerto
              </button>
            </div>

            <div className="divider" />

            <div className="input-group">
              <label className="input-label">
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <Icons.Eye /> Equipos a vigilar en esta red
                </span>
              </label>
              <div style={{ fontSize: 11, color: "var(--text-faint)", marginTop: -2, marginBottom: 10, fontFamily: "var(--font-mono)" }}>
                Cuando este perfil esté activo, se pingueará cada {settings.watchInterval || 15}s para saber qué equipos están vivos.
              </div>
              {(form.watchlist || []).length === 0 ? (
                <div style={{ padding: "16px 12px", textAlign: "center", color: "var(--text-faint)", fontSize: 11, fontFamily: "var(--font-mono)", background: "var(--bg-input)", border: "1px dashed var(--border-strong)", borderRadius: "var(--radius-sm)", marginBottom: 10 }}>
                  Sin equipos vigilados
                </div>
              ) : (
                <div className="watchlist-editor" style={{ marginBottom: 10 }}>
                  {(form.watchlist || []).map((w, i) => (
                    <div key={w.id || i} className="watchlist-item">
                      <input
                        className="input"
                        value={w.ip || ""}
                        onChange={e => {
                          const list = [...(form.watchlist || [])];
                          list[i] = { ...list[i], ip: e.target.value };
                          setForm(f => ({ ...f, watchlist: list }));
                        }}
                        placeholder="192.168.1.50"
                      />
                      <input
                        className="input"
                        value={w.label || ""}
                        onChange={e => {
                          const list = [...(form.watchlist || [])];
                          list[i] = { ...list[i], label: e.target.value };
                          setForm(f => ({ ...f, watchlist: list }));
                        }}
                        placeholder="Nombre (ej: NAS, impresora)"
                      />
                      <button
                        className="port-delete-btn"
                        onClick={() => {
                          const list = (form.watchlist || []).filter((_, j) => j !== i);
                          setForm(f => ({ ...f, watchlist: list }));
                        }}
                        title="Quitar"
                      ><Icons.Trash /></button>
                    </div>
                  ))}
                </div>
              )}
              <div className="watchlist-actions">
                <button
                  className="add-port-btn"
                  style={{ flex: 1 }}
                  onClick={() => setForm(f => ({
                    ...f,
                    watchlist: [...(f.watchlist || []), { id: generateId(), ip: "", label: "" }],
                  }))}
                >
                  <Icons.Plus size={12} /> Añadir equipo
                </button>
                {isElectron && (
                  <button
                    className="add-port-btn"
                    style={{ flex: 1 }}
                    onClick={() => openScan(form.gateway || form.ip)}
                    title="Usa el escáner para localizar equipos"
                  >
                    <Icons.Radar /> Detectar con escáner
                  </button>
                )}
              </div>
            </div>

            <div className="divider" />

            <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
              <button className="btn btn-secondary" onClick={() => setView("list")}>Cancelar</button>
              <button className="btn btn-primary btn-lg btn-full" onClick={saveForm}>
                {editingId ? "Guardar cambios" : "Crear perfil"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ─── FOOTER ──────────────────────────────────────────────── */}
      <div className="footer">
        <span>v{appInfo?.version || "1.0"}</span>
        <span>
          Hecho por{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); openExtLink("https://paulocarrasco.dev"); }}>Paulo Carrasco</a>
          <span className="sep"> · </span>
          paulocarrasco.dev
        </span>
      </div>

      {/* ═══ MODALES ═══ */}

      {/* Delete confirm */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">¿Eliminar perfil?</div>
            <div className="modal-body">Esta acción no se puede deshacer. La IP del sistema no cambiará.</div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeleteConfirm(null)}>Cancelar</button>
              <button className="btn btn-destructive" onClick={() => deleteProfile(deleteConfirm)}>Eliminar</button>
            </div>
          </div>
        </div>
      )}

      {/* DHCP confirm */}
      {dhcpConfirm && (
        <div className="modal-overlay" onClick={() => setDhcpConfirm(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">¿Volver a DHCP?</div>
            <div className="modal-body">Se quitará la IP estática de "{selectedAdapter}" y el router asignará una automáticamente. Requiere permisos de administrador.</div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDhcpConfirm(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={applyDhcp}>Aplicar DHCP</button>
            </div>
          </div>
        </div>
      )}

      {/* Ping modal */}
      {pingModal && (
        <div className="modal-overlay" onClick={() => setPingModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Probar conexión</div>
            <div className="modal-subtitle">{pingModal.profile.name} · {pingModal.profile.ip}</div>

            <div className="ping-grid">
              <PingRow label="Gateway" host={pingModal.profile.gateway || "(no definido)"}
                result={pingModal.results?.gateway} testing={pingModal.testing} />
              <PingRow label="DNS" host={pingModal.profile.dns || "(no definido)"}
                result={pingModal.results?.dns} testing={pingModal.testing} />
              <PingRow label="Internet" host="8.8.8.8"
                result={pingModal.results?.internet} testing={pingModal.testing} />
            </div>

            <div style={{ marginTop: 20 }}>
              <button className="btn btn-secondary btn-full" onClick={() => setPingModal(null)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* About */}
      {aboutOpen && (
        <div className="modal-overlay" onClick={() => setAboutOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="about-logo"><Icons.Network /></div>
            <div className="about-name">IP Switcher</div>
            <div className="about-version">v{appInfo?.version || "1.0.0"}</div>
            <div className="about-author">
              Desarrollado por <a href="#" onClick={(e) => { e.preventDefault(); openExtLink("https://paulocarrasco.dev"); }}>Paulo Carrasco</a>
            </div>
            {appInfo && (
              <div className="about-kv">
                <span className="k">Versión</span><span className="v">{appInfo.version}</span>
                <span className="k">Electron</span><span className="v">{appInfo.electron}</span>
                <span className="k">Node</span><span className="v">{appInfo.node}</span>
                <span className="k">Plataforma</span><span className="v">{appInfo.platform} {appInfo.arch}</span>
              </div>
            )}
            <div className="modal-body" style={{ fontSize: 11.5, textAlign: "center", margin: 0 }}>
              Gestor profesional de perfiles de IP estática.<br/>
              <a href="#" onClick={(e) => { e.preventDefault(); openExtLink("https://paulocarrasco.dev"); }} style={{ color: "var(--accent)", textDecoration: "none", fontWeight: 600 }}>paulocarrasco.dev</a>
            </div>
            <div style={{ marginTop: 16 }}>
              <button className="btn btn-secondary btn-full" onClick={() => setAboutOpen(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* Settings */}
      {settingsOpen && (
        <div className="modal-overlay" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Ajustes</div>
            <div className="modal-subtitle">Preferencias de la app</div>

            <SettingRow
              name="Iniciar con Windows"
              desc="Abrir IP Switcher automáticamente al encender el PC"
              value={settings.startWithWindows}
              onChange={v => updateSetting("startWithWindows", v)}
            />
            <SettingRow
              name="Iniciar minimizado"
              desc="Arrancar oculto en la bandeja del sistema"
              value={settings.startMinimized}
              onChange={v => updateSetting("startMinimized", v)}
            />
            <SettingRow
              name="Minimizar a bandeja"
              desc="Al minimizar, ocultar la ventana en la bandeja"
              value={settings.minimizeToTray}
              onChange={v => updateSetting("minimizeToTray", v)}
            />
            <SettingRow
              name="Cerrar a bandeja"
              desc="Al cerrar (X), ocultar en la bandeja en lugar de salir"
              value={settings.closeToTray}
              onChange={v => updateSetting("closeToTray", v)}
            />
            <SettingRow
              name="Notificaciones del sistema"
              desc="Mostrar notificaciones de Windows al cambiar de IP"
              value={settings.showNotifications}
              onChange={v => updateSetting("showNotifications", v)}
            />
            <SettingRow
              name="Avisos de monitor (equipos vigilados)"
              desc="Notificar cuando un equipo vigilado cae o vuelve a responder"
              value={settings.watchNotifications}
              onChange={v => updateSetting("watchNotifications", v)}
            />
            <div className="setting-row">
              <div className="setting-info">
                <div className="setting-name">Intervalo del monitor</div>
                <div className="setting-desc">Frecuencia de ping a los equipos vigilados</div>
              </div>
              <select
                value={settings.watchInterval || 15}
                onChange={e => updateSetting("watchInterval", parseInt(e.target.value, 10))}
                style={{
                  background: "var(--bg-input)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "5px 8px",
                  borderRadius: "var(--radius-sm)",
                  outline: "none",
                  cursor: "pointer",
                }}
              >
                <option value={5}>5 segundos</option>
                <option value={10}>10 segundos</option>
                <option value={15}>15 segundos (por defecto)</option>
                <option value={30}>30 segundos</option>
                <option value={60}>1 minuto</option>
                <option value={120}>2 minutos</option>
              </select>
            </div>

            <div style={{ marginTop: 20 }}>
              <button className="btn btn-secondary btn-full" onClick={() => setSettingsOpen(false)}>Cerrar</button>
            </div>

            <div style={{ marginTop: 16, padding: 12, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-mono)", fontSize: 10.5, color: "var(--text-faint)", lineHeight: 1.8 }}>
              <div style={{ color: "var(--text-dim)", marginBottom: 6, fontWeight: 600 }}>Atajos de teclado:</div>
              <div>Ctrl+N · Nuevo perfil</div>
              <div>Ctrl+F · Buscar</div>
              <div>Ctrl+K · Quick switcher</div>
              <div>Ctrl+Shift+Space · Quick switcher (global)</div>
              <div>Ctrl+1…9 · Activar perfil N</div>
              <div>Esc · Cerrar diálogos</div>
            </div>
          </div>
        </div>
      )}

      {/* History */}
      {historyOpen && (
        <div className="modal-overlay" onClick={() => setHistoryOpen(false)}>
          <div className="modal modal-wide" onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
              <div>
                <div className="modal-title">Historial</div>
                <div className="modal-subtitle" style={{ marginBottom: 0 }}>Últimas {history.length} acción{history.length === 1 ? "" : "es"}</div>
              </div>
              {history.length > 0 && (
                <button className="btn btn-danger btn-sm" onClick={clearHistoryList}>Borrar todo</button>
              )}
            </div>

            {history.length === 0 ? (
              <div className="history-empty">No hay registros.</div>
            ) : (
              <div className="history-list">
                {history.map((h, i) => (
                  <div key={i} className="history-row">
                    <span className="history-time">{formatTime(h.ts)}</span>
                    <span className="history-main">
                      {h.action === "apply" ? (
                        <><strong>{h.profileName || h.ip}</strong> → {h.ip} · {h.adapter}</>
                      ) : h.action === "dhcp" ? (
                        <><strong>DHCP</strong> · {h.adapter}</>
                      ) : (
                        <>{h.action}</>
                      )}
                      {!h.success && h.error && <span style={{ color: "var(--danger)", marginLeft: 8 }}>— {h.error}</span>}
                    </span>
                    <span className={`history-icon ${h.success ? "success" : "error"}`}>
                      {h.success ? "✓" : "✗"}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 20 }}>
              <button className="btn btn-secondary btn-full" onClick={() => setHistoryOpen(false)}>Cerrar</button>
            </div>
          </div>
        </div>
      )}

      {/* Scan modal */}
      {scanOpen && (
        <div className="modal-overlay" onClick={closeScan}>
          <div className="modal modal-wide scan-modal" onClick={e => e.stopPropagation()}>
            <div className="scan-header">
              <div>
                <div className="modal-title">Escáner de red</div>
                <div className="modal-subtitle" style={{ marginBottom: 0 }}>
                  Rango {scanRangeLabel}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                {scanStatus === "running" ? (
                  <button className="btn btn-ghost btn-sm" onClick={closeScan}>Cancelar</button>
                ) : (
                  <button className="btn btn-ghost btn-sm" onClick={() => startScan(scanBaseIp, scanRange.prefix ?? scanPrefix, gatewayIp)}><Icons.Refresh /> Re-escanear</button>
                )}
              </div>
            </div>

            <div className="scan-progress-wrap">
              <div className="scan-progress-top">
                <span className="scan-progress-label">
                  {scanStatus === "running"
                    ? <>Escaneando… <strong>{scanAlive.length}</strong> equipo{scanAlive.length === 1 ? "" : "s"} encontrado{scanAlive.length === 1 ? "" : "s"}</>
                    : scanStatus === "done"
                      ? <><strong>{scanAlive.length}</strong> equipo{scanAlive.length === 1 ? "" : "s"} en la red{scanDevices.length > scanAlive.length ? ` · ${scanDevices.length - scanAlive.length} sin respuesta` : ""}</>
                      : scanStatus === "error"
                        ? <span style={{ color: "var(--danger)" }}>Error: {scanError || "desconocido"}</span>
                        : "Preparando…"}
                </span>
                <span className="scan-progress-count">
                  {scanProgress.total > 0 ? `${scanProgress.done}/${scanProgress.total}` : ""}
                </span>
              </div>
              <div className="scan-progress-bar">
                <div className="scan-progress-fill" style={{ width: scanProgress.total > 0 ? `${(scanProgress.done / scanProgress.total) * 100}%` : "0%" }} />
              </div>
            </div>

            {scanDevices.length === 0 && scanStatus !== "running" ? (
              <div className="scan-list">
                <div className="scan-empty-row">
                  {scanStatus === "done" ? "Sin equipos detectados. La red puede estar vacía o los dispositivos tienen firewall." : "Barriendo el rango…"}
                </div>
              </div>
            ) : (
              <div className="scan-list">
                {[...scanDevices].sort((a, b) => {
                  const pa = a.ip.split(".").map(Number);
                  const pb = b.ip.split(".").map(Number);
                  return pa[3] - pb[3];
                }).map(d => {
                  const isGateway = d.ip === gatewayIp;
                  const isSelf = ownIps.includes(d.ip);
                  return (
                    <div key={d.ip} className={`scan-row ${d._new ? "new-device" : ""} ${d.alive === false ? "dead" : ""}`}>
                      <span className={`scan-ip ${isGateway ? "gateway" : ""} ${isSelf ? "self" : ""}`}>{d.ip}</span>
                      <span className={`scan-mac ${d.mac ? "" : "empty"}`}>{d.mac || "—"}</span>
                      <span className="scan-info">
                        <div className="scan-vendor">
                          {d.type
                            ? <span className={`scan-type ${d.type.startsWith("PLC") ? "plc" : ""}`}>{d.type}</span>
                            : (d.vendor || (d.mac ? "Desconocido" : "…"))}
                          {d.type && d.vendor && <span className="scan-vendor-sub"> · {d.vendor}</span>}
                        </div>
                        {d.hostname && <div className="scan-hostname">{d.hostname}</div>}
                        {(d.sysDescr || d.typeDetail) && (
                          <div className="scan-detail" title={d.sysDescr || d.typeDetail}>{d.sysDescr || d.typeDetail}</div>
                        )}
                        {d.services?.length > 0 && (
                          <div className="scan-services" title={`Puertos abiertos: ${d.openPorts.join(", ")}`}>
                            {d.services.slice(0, 4).join("  ")}{d.services.length > 4 ? `  +${d.services.length - 4}` : ""}
                          </div>
                        )}
                      </span>
                      <span className="scan-tags">
                        {isGateway && <span className="scan-tag gateway">GATEWAY</span>}
                        {isSelf && <span className="scan-tag self">TU EQUIPO</span>}
                        {d.alive === false && <span className="scan-tag dead" title="Estaba en la tabla ARP pero no responde">SIN RESPUESTA</span>}
                        {d.alive !== false && d.latency != null && <span className="scan-latency">{d.latency}ms</span>}
                        {!isSelf && !isGateway && view === "form" && (
                          <button
                            className="use-btn"
                            style={{ marginRight: 6 }}
                            onClick={() => {
                              // Añade al watchlist del form, evita duplicados
                              const already = (form.watchlist || []).some(w => w.ip === d.ip);
                              if (already) { showToast(`${d.ip} ya está en la lista`, false); return; }
                              setForm(f => ({
                                ...f,
                                watchlist: [...(f.watchlist || []), {
                                  id: generateId(),
                                  ip: d.ip,
                                  label: d.hostname || d.vendor || "",
                                }],
                              }));
                              showToast(`${d.ip} añadida a vigilancia`);
                            }}
                            title="Añadir a equipos vigilados"
                          >VIGILAR</button>
                        )}
                        {!isSelf && !isGateway && <button className="use-btn" onClick={() => useScannedIp(d.ip)}>USAR IP</button>}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {(scanStatus === "done" || scanStatus === "running") && (
              <div className="scan-summary">
                <span><strong>Gateway:</strong> {gatewayIp || "—"}</span>
                <span><strong>Tu IP:</strong> {currentIp || "—"}</span>
                {suggestFreeIp && (
                  <span><strong>Sugerida libre:</strong> <span style={{ color: "var(--accent)", cursor: "pointer", textDecoration: "underline" }} onClick={() => useScannedIp(suggestFreeIp)}>{suggestFreeIp}</span></span>
                )}
              </div>
            )}

            <div style={{ marginTop: 18, display: "flex", gap: 10 }}>
              <button className="btn btn-secondary btn-full" onClick={closeScan}>Cerrar</button>
              {suggestFreeIp && scanStatus === "done" && (
                <button className="btn btn-primary btn-full" onClick={() => useScannedIp(suggestFreeIp)}>
                  Usar {suggestFreeIp}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Quick switcher */}
      {quickOpen && (
        <div className="quick-overlay" onClick={() => setQuickOpen(false)}>
          <div className="quick-box" onClick={e => e.stopPropagation()}>
            <div className="quick-input-wrap">
              <Icons.Zap />
              <input
                ref={quickInputRef}
                className="quick-input"
                value={quickQuery}
                onChange={e => setQuickQuery(e.target.value)}
                onKeyDown={handleQuickKeyDown}
                placeholder="Activar perfil… escribe para filtrar"
              />
              <span className="quick-kbd">ESC</span>
            </div>

            {quickFiltered.length === 0 ? (
              <div className="quick-empty">Sin resultados</div>
            ) : (
              <div className="quick-list">
                {quickFiltered.map((p, i) => {
                  const isActive = activeProfile?.id === p.id;
                  return (
                    <div
                      key={p.id}
                      className={`quick-item ${i === quickIndex ? "selected" : ""}`}
                      style={{ "--_c": p.color }}
                      onClick={() => { setQuickOpen(false); activateProfileById(p.id); }}
                      onMouseEnter={() => setQuickIndex(i)}
                    >
                      <div className="quick-item-bar" />
                      <div className="quick-item-info">
                        <div className="quick-item-name">{p.name}</div>
                        <div className="quick-item-ip">{p.ip}{p.gateway && ` · ${p.gateway}`}</div>
                      </div>
                      {isActive && <span className="quick-item-badge">ACTIVO</span>}
                    </div>
                  );
                })}
              </div>
            )}

            <div className="quick-footer">
              <span><strong>↑↓</strong> navegar</span>
              <span><strong>↵</strong> activar</span>
              <span><strong>Esc</strong> cerrar</span>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className={`toast ${toast.ok ? "success" : "danger"}`}>
          <span className="icon">{toast.ok ? "✓" : "✗"}</span>
          {toast.msg}
        </div>
      )}
    </div>
  );
}

// ─── COMPONENTES AUXILIARES ─────────────────────────────────────────────────
function SettingRow({ name, desc, value, onChange }) {
  return (
    <div className="setting-row">
      <div className="setting-info">
        <div className="setting-name">{name}</div>
        <div className="setting-desc">{desc}</div>
      </div>
      <div className={`toggle ${value ? "on" : ""}`} onClick={() => onChange(!value)} />
    </div>
  );
}

function PingRow({ label, host, result, testing }) {
  const status = testing ? "pending" : (result?.success ? "success" : result ? "error" : "pending");
  const display = testing
    ? "…"
    : result?.success
      ? (result.latency !== null && result.latency !== undefined ? `${result.latency} ms` : "OK")
      : (result === null ? "—" : result ? "Timeout" : "—");
  return (
    <div className={`ping-row ${status}`}>
      <span className="ping-label">{label}</span>
      <span className="ping-host">{host}</span>
      <span className="ping-result">{testing ? <span className="spinner" /> : display}</span>
    </div>
  );
}

// Tiempo relativo: "hace 2s", "hace 1m", "hace 3h"
function timeAgo(ts) {
  if (!ts) return "nunca";
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return "ahora";
  if (diff < 60) return `hace ${diff}s`;
  if (diff < 3600) return `hace ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)}h`;
  return `hace ${Math.floor(diff / 86400)}d`;
}

function WatchSection({ watchlist, items, expanded, onToggle, onRefresh, ticking }) {
  // Mezclar definición del perfil con estado recibido
  const merged = watchlist.map(w => {
    const state = items.find(it => it.id === w.id);
    return {
      id: w.id,
      ip: w.ip,
      label: w.label || "",
      alive: state?.alive ?? null, // null = aún desconocido
      latency: state?.latency ?? null,
      lastSeen: state?.lastSeen ?? null,
      lastCheck: state?.lastCheck ?? null,
    };
  });

  const aliveCount = merged.filter(m => m.alive === true).length;
  const total = merged.length;
  const allKnown = merged.every(m => m.alive !== null);
  const summaryClass = !allKnown ? "dim" : aliveCount === total ? "ok" : aliveCount === 0 ? "bad" : "warn";

  // Trigger re-render cada 10s para refrescar "hace Xs"
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 10000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="watch-section">
      <div className="watch-head" onClick={onToggle}>
        <div className="watch-title">
          <Icons.Eye /> Monitor
        </div>
        <div className={`watch-summary ${summaryClass}`}>
          {allKnown ? `${aliveCount}/${total}` : `—/${total}`} {aliveCount === total && allKnown ? "online" : aliveCount === 0 && allKnown ? "sin respuesta" : "activos"}
        </div>
        <button
          className={`watch-refresh ${ticking ? "spinning" : ""}`}
          onClick={(e) => { e.stopPropagation(); onRefresh(); }}
          title="Forzar comprobación"
        >
          <Icons.Refresh />
        </button>
        <span className={`watch-chevron ${expanded ? "open" : ""}`}><Icons.Chevron /></span>
      </div>

      {expanded && (
        <div className="watch-list">
          {merged.length === 0 ? (
            <div className="watch-empty">Sin equipos vigilados</div>
          ) : (
            merged.map(m => {
              const cls = m.alive === true ? "alive" : m.alive === false ? "dead" : "unknown";
              return (
                <div key={m.id} className={`watch-row ${cls}`}>
                  <span className="watch-dot" />
                  <span className="watch-ip">{m.ip}</span>
                  <span className="watch-label">{m.label || <span style={{ color: "var(--text-ghost)" }}>—</span>}</span>
                  <span className="watch-latency">
                    {m.alive === true
                      ? (m.latency != null ? `${m.latency} ms` : "OK")
                      : m.alive === false ? "sin respuesta" : "…"}
                  </span>
                  <span className="watch-lastseen">
                    {m.lastCheck
                      ? (m.alive ? timeAgo(m.lastCheck) : `caído · visto ${timeAgo(m.lastSeen)}`)
                      : "esperando"}
                  </span>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
