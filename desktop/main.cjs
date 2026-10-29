const { app, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, powerMonitor, screen, session, systemPreferences, Tray } = require('electron');
const { existsSync } = require('node:fs');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PET_FILE = path.join(__dirname, 'pet.html');
const PANEL_FILE = path.join(__dirname, 'meeting.html');
const PET_URL = pathToFileURL(PET_FILE).href;
const PANEL_URL = pathToFileURL(PANEL_FILE).href;
const PET_SIZE = { width: 170, height: 190 };
let petWindow;
let panelWindow;
let tray;
let quitApproved = false;
let quitDialogOpen = false;
let captureGrantUntil = 0;
let microphoneGrantUntil = 0;
let recordingStatus = { recording: false, pendingCount: 0, transcribing: false, hasUnsavedAudio: false };
let activeTranscriptions = 0;
let analysisRunning = false;

app.setName('Pip');
if (process.env.PIP_TEST_USER_DATA) app.setPath('userData', path.resolve(process.env.PIP_TEST_USER_DATA));

// Never bake secrets into the app bundle. In development use the project .env.
// For a packaged app, prefer userData/.env or a .env next to Pip.app.
const envCandidates = app.isPackaged
  ? [path.join(app.getPath('userData'), '.env'), path.join(path.dirname(path.dirname(path.dirname(process.execPath))), '..', '.env')]
  : [path.join(ROOT, '.env')];
let envPath = envCandidates[0];
for (const candidate of envCandidates) {
  if (!existsSync(candidate)) continue;
  try { process.loadEnvFile(candidate); envPath = candidate; break; }
  catch { console.warn('Pip could not read its .env file. Check the file format.'); }
}

const safeError = (error) => {
  const message = typeof error?.message === 'string' ? error.message : 'The operation could not be completed.';
  const secret = process.env.OPENAI_API_KEY;
  return new Error(secret ? message.split(secret).join('[redacted]') : message);
};

function senderIs(event, role = 'either') {
  if (role === 'either') return senderIs(event, 'panel') || senderIs(event, 'pet');
  const win = role === 'panel' ? panelWindow : petWindow;
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === (role === 'panel' ? PANEL_URL : PET_URL));
}

function handle(channel, role, action) {
  ipcMain.handle(channel, async (event, value) => {
    if (!senderIs(event, role)) throw new Error('This action is only available inside Pip.');
    try { return await action(value, event); }
    catch (error) { throw safeError(error); }
  });
}

function permissionStatus(type) {
  if (!['darwin', 'win32'].includes(process.platform)) return 'unknown';
  try { return systemPreferences.getMediaAccessStatus(type); }
  catch { return 'unknown'; }
}

function getConfig() {
  return {
    aiConfigured: Boolean(process.env.OPENAI_API_KEY?.trim()),
    transcriptionModel: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe',
    analysisModel: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    platform: process.platform,
    packaged: app.isPackaged,
    version: app.getVersion(),
    envPath,
    permissions: { microphone: permissionStatus('microphone'), screen: permissionStatus('screen'), systemAudio: 'check-input-meter' },
  };
}

function clampPosition(x, y) {
  const area = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  return {
    x: Math.max(area.x, Math.min(Math.round(x), area.x + area.width - PET_SIZE.width)),
    y: Math.max(area.y, Math.min(Math.round(y), area.y + area.height - PET_SIZE.height)),
  };
}

function broadcastStatus() {
  for (const win of [petWindow, panelWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('pip:status', recordingStatus);
  }
  if (tray) {
    tray.setToolTip(recordingStatus.recording ? 'Pip — meeting recording in progress' : 'Pip — your meeting companion');
    if (process.platform === 'darwin') tray.setTitle(recordingStatus.recording ? '●' : '');
  }
}

function secureWindow(win, expectedURL) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== expectedURL) event.preventDefault(); });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  win.webContents.on('did-finish-load', broadcastStatus);
}

function createWindows() {
  const area = screen.getPrimaryDisplay().workArea;
  const sharedPreferences = { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false };
  petWindow = new BrowserWindow({
    ...PET_SIZE,
    x: area.x + area.width - PET_SIZE.width - 28,
    y: area.y + area.height - PET_SIZE.height - 26,
    transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false,
    alwaysOnTop: true, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, show: false,
    webPreferences: sharedPreferences,
  });
  petWindow.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  secureWindow(petWindow, PET_URL);
  petWindow.once('ready-to-show', () => petWindow.show());
  petWindow.on('close', (event) => { if (!quitApproved) { event.preventDefault(); requestQuit(); } });
  petWindow.loadFile(PET_FILE);

  panelWindow = new BrowserWindow({
    width: 920, height: 790, minWidth: 720, minHeight: 600, show: false,
    backgroundColor: '#fafbf7', title: 'Pip · Meeting companion',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: sharedPreferences,
  });
  secureWindow(panelWindow, PANEL_URL);
  panelWindow.on('close', (event) => { if (!quitApproved) { event.preventDefault(); panelWindow.hide(); } });
  panelWindow.webContents.on('render-process-gone', () => {
    recordingStatus = { ...recordingStatus, recording: false, transcribing: false };
    captureGrantUntil = 0; microphoneGrantUntil = 0;
    broadcastStatus();
  });
  panelWindow.loadFile(PANEL_FILE);
}

function openPanel() {
  if (!panelWindow || panelWindow.isDestroyed()) return;
  if (panelWindow.isMinimized()) panelWindow.restore();
  panelWindow.show(); panelWindow.focus();
}

async function requestQuit() {
  if (quitDialogOpen) return;
  if (recordingStatus.recording || recordingStatus.transcribing || recordingStatus.hasUnsavedAudio || activeTranscriptions) {
    quitDialogOpen = true;
    openPanel();
    const result = await dialog.showMessageBox(panelWindow || petWindow, {
      type: 'question', title: 'Finish this meeting first?',
      message: recordingStatus.recording || recordingStatus.transcribing || activeTranscriptions ? 'A recording or transcription is still in progress.' : 'Your meeting audio has not been exported.',
      detail: 'Keep Pip open to finish and save it. Quitting stops capture and may lose audio that has not been exported.',
      buttons: ['Keep Pip open', 'Quit Pip'], defaultId: 0, cancelId: 0,
    });
    quitDialogOpen = false;
    if (result.response !== 1) { openPanel(); return; }
  }
  quitApproved = true;
  app.quit();
}

function configurePermissions() {
  const isPanel = (contents) => panelWindow && !panelWindow.isDestroyed() && contents === panelWindow.webContents && contents.getURL() === PANEL_URL;
  const canUseMedia = (permission, details = {}) => {
    if (permission === 'clipboard-sanitized-write') return true;
    if (permission === 'display-capture') return Date.now() < captureGrantUntil;
    if (permission === 'media') {
      if (details.mediaTypes?.some((type) => type !== 'audio')) return false;
      if (details.mediaType && !['audio', 'unknown'].includes(details.mediaType)) return false;
      return Date.now() < microphoneGrantUntil;
    }
    return false;
  };
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) => isPanel(contents) && canUseMedia(permission, details));
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(Boolean(isPanel(contents) && (!details.requestingUrl || details.requestingUrl === PANEL_URL) && canUseMedia(permission, details)));
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    const authorized = request.frame && panelWindow && !panelWindow.isDestroyed() && request.frame === panelWindow.webContents.mainFrame && request.frame.url === PANEL_URL && request.audioRequested && Date.now() < captureGrantUntil;
    captureGrantUntil = 0;
    if (!authorized) { callback(null); return; }
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      if (!sources.length) { callback(null); return; }
      // Chromium requires a display source for loopback capture. The renderer
      // uses only audio; screen frames are never recorded, stored or uploaded.
      callback({ video: sources[0], audio: 'loopback' });
    } catch { callback(null); }
  }, { useSystemPicker: false });
}

function audioBytes(audio, maximum = 25 * 1024 * 1024) {
  if (!(audio instanceof ArrayBuffer) || audio.byteLength < 44 || audio.byteLength > maximum) throw new Error('The audio data is missing or too large.');
  const bytes = Buffer.from(audio);
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Pip expects a WAV recording.');
  return bytes;
}

function safeName(value, fallback, extension) {
  if (typeof value !== 'string') return fallback;
  const name = path.basename(value).replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 120);
  return !name ? fallback : name.endsWith(extension) ? name : `${name}${extension}`;
}

function registerIPC() {
  handle('pip:get-config', 'either', getConfig);
  handle('pip:open-panel', 'either', () => { openPanel(); return true; });
  handle('pip:hide-panel', 'panel', () => { panelWindow.hide(); return true; });
  handle('pip:quit', 'either', requestQuit);
  handle('pip:pet-position', 'pet', () => { const [x, y] = petWindow.getPosition(); return { x, y }; });
  handle('pip:move-pet', 'pet', (point) => {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('Invalid pet position.');
    const position = clampPosition(point.x, point.y);
    petWindow.setPosition(position.x, position.y, false);
    return position;
  });
  handle('pip:set-status', 'panel', (value) => {
    if (!value || typeof value.recording !== 'boolean' || typeof value.transcribing !== 'boolean' || !Number.isFinite(value.pendingCount) || (value.hasUnsavedAudio !== undefined && typeof value.hasUnsavedAudio !== 'boolean')) throw new Error('Invalid meeting status.');
    recordingStatus = { recording: value.recording, transcribing: value.transcribing, hasUnsavedAudio: Boolean(value.hasUnsavedAudio), pendingCount: Math.max(0, Math.min(999, Math.floor(value.pendingCount))) };
    broadcastStatus(); return recordingStatus;
  });
  handle('pip:microphone', 'panel', async () => {
    let allowed = true;
    if (process.platform === 'darwin') allowed = await systemPreferences.askForMediaAccess('microphone');
    microphoneGrantUntil = allowed ? Date.now() + 60000 : 0;
    return allowed;
  });
  handle('pip:begin-system-capture', 'panel', () => { captureGrantUntil = Date.now() + 30000; return true; });
  handle('pip:transcribe', 'panel', async (value) => {
    if (!value || value.mimeType !== 'audio/wav') throw new Error('Only WAV audio can be transcribed.');
    audioBytes(value.audio);
    if (value.language != null && (typeof value.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(value.language))) throw new Error('Choose a valid transcription language.');
    if (activeTranscriptions >= 2) throw new Error('Two transcription requests are already running. Try again after they finish.');
    activeTranscriptions += 1;
    try {
      const { transcribeAudio } = await import('./transcription.mjs');
      return await transcribeAudio({ audio: value.audio, mimeType: value.mimeType, language: value.language, apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-transcribe' });
    } finally { activeTranscriptions -= 1; }
  });
  handle('pip:analyze', 'panel', async (value) => {
    if (!value || !['demo', 'ai'].includes(value.mode)) throw new Error('Choose demo or AI analysis.');
    const { analyzeTranscript, validateTranscript } = await import('../extension/lib/analyzer.mjs');
    const transcript = validateTranscript(value.transcript);
    if (value.mode === 'demo') return analyzeTranscript(transcript);
    if (analysisRunning) throw new Error('An analysis is already running.');
    analysisRunning = true;
    try {
      const { analyzeWithAI } = await import('../server.mjs');
      return await analyzeWithAI(transcript, { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-4o-mini', fetchImpl: fetch });
    } finally { analysisRunning = false; }
  });
  handle('pip:save-text', 'panel', async (value) => {
    if (!value || typeof value.text !== 'string' || value.text.length > 2000000) throw new Error('The text is missing or too large.');
    const result = await dialog.showSaveDialog(panelWindow, { title: 'Save meeting text', defaultPath: safeName(value.suggestedName, 'pip-meeting.txt', '.txt'), filters: [{ name: 'Text', extensions: ['txt'] }] });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, value.text, { encoding: 'utf8', mode: 0o600 });
    return { saved: true };
  });
  handle('pip:save-audio', 'panel', async (value) => {
    const bytes = audioBytes(value?.audio, 240 * 1024 * 1024);
    const result = await dialog.showSaveDialog(panelWindow, { title: 'Save meeting audio', defaultPath: safeName(value.suggestedName, 'pip-meeting.wav', '.wav'), filters: [{ name: 'WAV audio', extensions: ['wav'] }] });
    if (result.canceled || !result.filePath) return { saved: false };
    await writeFile(result.filePath, bytes, { mode: 0o600 });
    return { saved: true };
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openPanel);
  app.on('before-quit', (event) => { if (!quitApproved) { event.preventDefault(); requestQuit(); } });
  app.on('activate', openPanel);
  app.on('window-all-closed', () => { if (quitApproved) app.quit(); });
  app.whenReady().then(() => {
    createWindows(); configurePermissions(); registerIPC();
    const trayImage = nativeImage.createFromPath(path.join(ROOT, 'extension', 'icons', 'pip-32.png')).resize({ width: 18, height: 18 });
    tray = new Tray(trayImage);
    tray.setToolTip('Pip — your meeting companion');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Open meeting', click: openPanel }, { label: 'Show Pip', click: () => petWindow.show() }, { type: 'separator' }, { label: 'Quit Pip', click: requestQuit }]));
    tray.on('click', openPanel);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Pip', submenu: [{ label: 'Open meeting', click: openPanel }, { type: 'separator' }, { label: 'Quit Pip', accelerator: 'CmdOrCtrl+Q', click: requestQuit }] },
      { role: 'editMenu' },
      { label: 'Window', submenu: [{ role: 'minimize' }, { label: 'Show Pip', click: () => petWindow.show() }] },
    ]));
    screen.on('display-removed', () => { const [x, y] = petWindow.getPosition(); const next = clampPosition(x, y); petWindow.setPosition(next.x, next.y); });
    powerMonitor.on('suspend', () => { if (panelWindow && !panelWindow.isDestroyed()) panelWindow.webContents.send('pip:suspend'); });
  }).catch((error) => { console.error(safeError(error).message); quitApproved = true; app.quit(); });
}
