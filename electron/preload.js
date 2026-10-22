const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Perfiles
  loadProfiles: () => ipcRenderer.invoke('load-profiles'),
  saveProfiles: (data) => ipcRenderer.invoke('save-profiles', data),

  // Red
  getAdapters: () => ipcRenderer.invoke('get-adapters'),
  applyIp: (config) => ipcRenderer.invoke('apply-ip', config),
  setDhcp: (adapter) => ipcRenderer.invoke('set-dhcp', adapter),
  getCurrentIp: (adapter) => ipcRenderer.invoke('get-current-ip', adapter),
  getIpConfig: (adapter) => ipcRenderer.invoke('get-ip-config', adapter),
  captureCurrent: (adapter) => ipcRenderer.invoke('capture-current', adapter),
  pingTest: (config) => ipcRenderer.invoke('ping-test', config),

  // Import/Export
  exportProfiles: (profiles) => ipcRenderer.invoke('export-profiles', profiles),
  importProfiles: () => ipcRenderer.invoke('import-profiles'),

  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // Historial
  getHistory: () => ipcRenderer.invoke('get-history'),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // Info
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),

  // Ventana
  minimize: () => ipcRenderer.send('minimize-window'),
  maximize: () => ipcRenderer.send('maximize-window'),
  close: () => ipcRenderer.send('close-window'),
  hideToTray: () => ipcRenderer.send('hide-to-tray'),
  quitApp: () => ipcRenderer.send('quit-app'),
  openExternal: (url) => ipcRenderer.send('open-external', url),

  // Escáner de red
  scanNetwork: (baseIp) => ipcRenderer.invoke('scan-network', baseIp),
  cancelScan: () => ipcRenderer.invoke('cancel-scan'),

  // Monitor / watcher (equipos esperados del perfil activo)
  watchStart: (profile) => ipcRenderer.invoke('watch-start', profile),
  watchStop: () => ipcRenderer.invoke('watch-stop'),
  watchStatus: () => ipcRenderer.invoke('watch-status'),
  watchTickNow: () => ipcRenderer.invoke('watch-tick-now'),
  onWatchUpdate: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('watch-update', listener);
    return () => ipcRenderer.removeListener('watch-update', listener);
  },
  onScanStart: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scan-start', listener);
    return () => ipcRenderer.removeListener('scan-start', listener);
  },
  onScanDevice: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scan-device', listener);
    return () => ipcRenderer.removeListener('scan-device', listener);
  },
  onScanDeviceUpdate: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scan-device-update', listener);
    return () => ipcRenderer.removeListener('scan-device-update', listener);
  },
  onScanProgress: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scan-progress', listener);
    return () => ipcRenderer.removeListener('scan-progress', listener);
  },
  onScanComplete: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('scan-complete', listener);
    return () => ipcRenderer.removeListener('scan-complete', listener);
  },

  // Eventos del tray / global shortcut (reciben desde main)
  onTrayActivateProfile: (cb) => {
    const listener = (_, id) => cb(id);
    ipcRenderer.on('tray-activate-profile', listener);
    return () => ipcRenderer.removeListener('tray-activate-profile', listener);
  },
  onTrayApplyDhcp: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('tray-apply-dhcp', listener);
    return () => ipcRenderer.removeListener('tray-apply-dhcp', listener);
  },
  onOpenQuickSwitcher: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('open-quick-switcher', listener);
    return () => ipcRenderer.removeListener('open-quick-switcher', listener);
  },
});
