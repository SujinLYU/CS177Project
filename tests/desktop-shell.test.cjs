const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = readFileSync(path.join(__dirname, '../desktop/main.cjs'), 'utf8');

function shell() {
  const handlers = new Map();
  const calls = [];
  const permissions = {};
  const pending = new Promise(() => {});
  const electron = {
    app: { setName() {}, isPackaged: false, getPath: () => '/tmp/pip-shell-test', getVersion: () => 'test', requestSingleInstanceLock: () => true, on() {}, whenReady: () => pending, quit: () => calls.push('quit') },
    BrowserWindow: class {},
    desktopCapturer: { getSources: async () => { calls.push('enumerate-screens'); return [{ id: 'screen:1', name: 'Screen' }]; } },
    dialog: { showMessageBox: async () => { calls.push('quit-confirmation'); return { response: 0 }; } },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }) },
    session: { defaultSession: {
      setPermissionCheckHandler: (fn) => { permissions.check = fn; },
      setPermissionRequestHandler: (fn) => { permissions.request = fn; },
      setDisplayMediaRequestHandler: (fn) => { permissions.display = fn; },
    } },
    systemPreferences: { getMediaAccessStatus: () => 'not-determined', askForMediaAccess: async () => { calls.push('microphone-prompt'); return true; } },
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : name === 'node:fs' ? { existsSync: () => false } : require(name),
    __dirname: path.join(__dirname, '../desktop'), console, Buffer, URL,
    process: { env: {}, platform: 'darwin', execPath: '/tmp/Pip.app/Contents/MacOS/Pip' },
  });
  vm.runInContext(source, context);
  vm.runInContext(`
    function fakeWindow(url) {
      const mainFrame = { url };
      return { isDestroyed: () => false, webContents: { mainFrame, getURL: () => url, send() {} },
        hide() {}, show() {}, focus() {}, isMinimized: () => false,
        getPosition: () => [10,20], setPosition() {} };
    }
    petWindow = fakeWindow(PET_URL); panelWindow = fakeWindow(PANEL_URL);
    registerIPC(); configurePermissions();
  `, context);
  const pet = vm.runInContext('({ sender: petWindow.webContents, senderFrame: petWindow.webContents.mainFrame })', context);
  const panel = vm.runInContext('({ sender: panelWindow.webContents, senderFrame: panelWindow.webContents.mainFrame })', context);
  return { handlers, calls, permissions, context, pet, panel };
}

test('desktop startup does not ask for microphone or enumerate displays', () => {
  const { calls } = shell();
  assert.deepEqual(calls, []);
});

test('desktop IPC rejects unknown pages, subframes, and privileged pet requests', async () => {
  const { handlers, panel, pet } = shell();
  await assert.rejects(handlers.get('pip:get-config')({ sender: {}, senderFrame: { url: 'https://example.com' } }), /inside Pip/);
  await assert.rejects(handlers.get('pip:get-config')({ sender: panel.sender, senderFrame: { url: panel.senderFrame.url } }), /inside Pip/);
  await assert.rejects(handlers.get('pip:microphone')(pet), /inside Pip/);
  const config = await handlers.get('pip:get-config')(panel);
  assert.equal(config.aiConfigured, false);
  assert.equal(config.transcriptionModel, 'gpt-transcribe');
  assert.equal('apiKey' in config, false);
});

test('desktop capture requires a fresh single-use grant from meeting UI', async () => {
  const { handlers, panel, permissions, calls } = shell();
  const request = { frame: panel.senderFrame, audioRequested: true, videoRequested: true };
  let result;
  await permissions.display(request, (value) => { result = value; });
  assert.equal(result, null);
  assert.deepEqual(calls, []);
  await handlers.get('pip:begin-system-capture')(panel);
  await permissions.display(request, (value) => { result = value; });
  assert.equal(result.audio, 'loopback');
  assert.equal(result.video.id, 'screen:1');
  await permissions.display(request, (value) => { result = value; });
  assert.equal(result, null);
  assert.deepEqual(calls, ['enumerate-screens']);
});

test('desktop microphone grant is explicit and camera permission stays denied', async () => {
  const { handlers, panel, permissions, calls } = shell();
  assert.equal(permissions.check(panel.sender, 'media', 'file://', { mediaType: 'audio' }), false);
  assert.equal(await handlers.get('pip:microphone')(panel), true);
  assert.equal(permissions.check(panel.sender, 'media', 'file://', { mediaType: 'audio' }), true);
  assert.equal(permissions.check(panel.sender, 'media', 'file://', { mediaType: 'video' }), false);
  assert.deepEqual(calls, ['microphone-prompt']);
});

test('finished unsaved audio is protected by the quit confirmation', async () => {
  const { handlers, panel, pet, calls } = shell();
  await handlers.get('pip:set-status')(panel, { recording: false, transcribing: false, pendingCount: 3, hasUnsavedAudio: true });
  await handlers.get('pip:quit')(pet);
  assert.deepEqual(calls, ['quit-confirmation']);
});
