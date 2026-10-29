import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const executable = require('electron');
const root = fileURLToPath(new URL('..', import.meta.url));
const env = { ...process.env };
// Some IDEs are themselves Electron apps and export this flag to terminals.
// It applies only to the child runtime; do not change the user's environment.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [root, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
child.on('error', (error) => { console.error(`Pip could not start: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 0; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!child.killed) child.kill(signal); });
