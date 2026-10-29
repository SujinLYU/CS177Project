const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (value) => ipcRenderer.invoke(channel, value);
function subscribe(channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('A callback is required.');
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pipDesktop', Object.freeze({
  getConfig: invoke('pip:get-config'),
  openPanel: invoke('pip:open-panel'),
  hidePanel: invoke('pip:hide-panel'),
  quit: invoke('pip:quit'),
  getPetPosition: invoke('pip:pet-position'),
  movePet: invoke('pip:move-pet'),
  setStatus: invoke('pip:set-status'),
  requestMicrophone: invoke('pip:microphone'),
  beginSystemCapture: invoke('pip:begin-system-capture'),
  transcribe: invoke('pip:transcribe'),
  analyze: invoke('pip:analyze'),
  saveText: invoke('pip:save-text'),
  saveAudio: invoke('pip:save-audio'),
  onStatus: (callback) => subscribe('pip:status', callback),
  onSuspend: (callback) => subscribe('pip:suspend', callback),
}));
