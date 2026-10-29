import { packager } from '@electron/packager';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const electronPkg = JSON.parse(await readFile(join(root, 'node_modules/electron/package.json'), 'utf8'));
const stage = await mkdtemp(join(tmpdir(), 'pip-desktop-package-'));
try {
  // A positive allowlist prevents .env, personal recordings, test artifacts,
  // Git history and the local dependency tree from entering the distribution.
  for (const directory of ['desktop', 'extension/lib', 'extension/assets', 'extension/icons']) {
    await mkdir(join(stage, dirname(directory)), { recursive: true });
    await cp(join(root, directory), join(stage, directory), { recursive: true, filter: (source) => !source.split(/[\\/]/).some((part) => part.startsWith('.') || part === 'node_modules') });
  }
  await cp(join(root, 'server.mjs'), join(stage, 'server.mjs'));
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'pip-desktop', productName: 'Pip', version: pkg.version, private: true, type: 'module', main: 'desktop/main.cjs' }, null, 2));
  const outputs = await packager({
    dir: stage,
    out: join(root, 'dist'),
    name: 'Pip',
    executableName: 'Pip',
    platform: process.platform,
    arch: process.arch,
    electronVersion: electronPkg.version,
    appBundleId: 'com.pip.meeting-companion',
    appCategoryType: 'public.app-category.productivity',
    overwrite: true,
    asar: true,
    prune: false,
    extendInfo: {
      NSMicrophoneUsageDescription: 'Pip records your microphone only when you start a meeting, so it can transcribe your words.',
      NSAudioCaptureUsageDescription: 'Pip captures meeting sound from your computer only when you choose microphone + system audio and start recording.',
      NSScreenCaptureUsageDescription: 'Pip requests a display source to capture meeting audio. Screen images are never saved or uploaded.',
    },
  });
  for (const output of outputs) {
    if (process.platform === 'darwin') {
      const application = join(output, 'Pip.app');
      const signing = spawnSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', application], { encoding: 'utf8' });
      if (signing.status !== 0) throw new Error(`Local ad-hoc signing failed: ${signing.stderr}`);
      console.log(`Pip desktop app: ${application}`);
    } else console.log(`Pip desktop app: ${output}`);
  }
  console.log('API keys were not bundled. For packaged use, place .env next to Pip.app or in Pip’s user-data folder.');
} finally { await rm(stage, { recursive: true, force: true }); }
