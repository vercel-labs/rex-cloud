import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { chmod, unlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeServer } from './bridge.js';
import { checkFile, locations, privateDir, readJSON, writeJSON, withLock, type Workspace } from './state.js';

declare const REX_CLOUD_BUILD: string;
export function authContext(): string {
  return createHash('sha256').update(JSON.stringify([process.env.VERCEL_TOKEN ?? null, process.env.XDG_DATA_HOME ?? null])).digest('hex');
}
export interface HelperStatus { key: string; pid: number; build?: string; authContext?: string; lastError?: string }
export async function saveAccount(root: string, userId: string): Promise<number> {
  return withLock(root, 'account', async () => {
    const previous = await readJSON<{ userId: string }>(join(root, 'account.json'));
    let disconnected = 0;
    if (previous && previous.userId !== userId) {
      for (const filename of await readdir(root)) {
        if (!/^[a-f0-9]{16}\.json$/.test(filename)) continue;
        const work = await readJSON<Workspace>(join(root, filename));
        if (work?.userId === previous.userId && !work.shared) {
          const paths = locations(root, work, work.name);
          if (filename !== `${paths.key}.json`) throw new Error('Workspace identity mismatch during account change.');
          await withLock(root, paths.key, () => disconnect(root, work));
          disconnected++;
        }
      }
    }
    await writeJSON(join(root, 'account.json'), { userId });
    return disconnected;
  });
}
export async function control(path: string, command = 'status'): Promise<HelperStatus | undefined> {
  if (!await checkFile(path, true)) return undefined;
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let data = '', done = false;
    const finish = (e?: Error, value?: HelperStatus) => { if (done) return; done = true; socket.destroy(); e ? reject(e) : resolve(value); };
    socket.setTimeout(2000, () => finish(new Error('Local connection helper is not responding.')));
    socket.on('connect', () => socket.write(JSON.stringify({ command }) + '\n'));
    socket.on('data', b => { data += b; if (data.length > 4096) finish(new Error('Invalid helper response.')); });
    socket.on('end', () => { if (!data) { finish(); return; } try { finish(undefined, JSON.parse(data)); } catch { finish(new Error('Invalid helper response.')); } });
    socket.on('error', (e: NodeJS.ErrnoException) => ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(e.code ?? '') ? finish() : finish(e));
  });
}
async function clearStaleSocket(path: string): Promise<void> {
  if (!await checkFile(path, true)) return;
  const alive = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Cannot establish socket ownership.')); });
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', (e: NodeJS.ErrnoException) => ['ENOENT', 'ECONNREFUSED'].includes(e.code ?? '') ? resolve(false) : reject(e));
  });
  if (alive) throw new Error('A process already owns this local socket. Refusing to replace it.');
  await unlink(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
}
export async function ensureHelper(root: string, work: Workspace): Promise<HelperStatus> {
  const paths = locations(root, work, work.name);
  await privateDir(paths.dir);
  const existing = await control(paths.control);
  if (existing) {
    if (existing.key !== paths.key) throw new Error('Unexpected local helper identity.');
    if (existing.build === REX_CLOUD_BUILD && existing.authContext === authContext()) return existing;
    await disconnect(root, work);
  }
  await clearStaleSocket(paths.control); await clearStaleSocket(paths.socket);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./helper-main.js', import.meta.url)), root, paths.key], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], shell: false });
    const cancelStartup = () => { child.kill('SIGTERM'); };
    process.once('exit', cancelStartup);
    const timeout = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Local helper did not start. Cloud computer remains available; run open again.')); }, 15000);
    child.once('error', () => { process.removeListener('exit', cancelStartup); clearTimeout(timeout); reject(new Error('Could not start local helper.')); });
    child.once('exit', () => { process.removeListener('exit', cancelStartup); clearTimeout(timeout); reject(new Error('Local helper exited during startup.')); });
    child.once('message', message => {
      clearTimeout(timeout);
      process.removeListener('exit', cancelStartup);
      const status = message as HelperStatus;
      if (status.key !== paths.key) { child.kill('SIGTERM'); reject(new Error('Unexpected helper identity.')); return; }
      child.disconnect(); child.unref(); resolve(status);
    });
  });
}
export async function disconnect(root: string, work: Workspace): Promise<void> {
  const paths = locations(root, work, work.name);
  const status = await control(paths.control);
  if (!status) return;
  if (status.key !== paths.key) throw new Error('Unexpected local helper identity.');
  await control(paths.control, 'disconnect');
  for (let i = 0; i < 30; i++) {
    if (!await control(paths.control)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Helper is still shutting down. Retry disconnect.');
}
export async function serve(root: string, key: string) {
  process.umask(0o077);
  await privateDir(root);
  if (!/^[0-9a-f]{16}$/.test(key)) throw new Error('Invalid helper key.');
  const work = await readJSON<Workspace>(`${root}/${key}.json`);
  if (!work) throw new Error('Workspace configuration missing.');
  const paths = locations(root, work, work.name);
  if (paths.key !== key || paths.socket !== work.socket || paths.control !== work.control) throw new Error('Workspace configuration mismatch.');
  let lastError: string | undefined;
  const bridge = await bridgeServer(work, message => { lastError = message; });
  let stopping = false;
  const server = createServer(socket => {
    let data = '';
    socket.setTimeout(2000, () => socket.destroy()); socket.on('error', () => {});
    socket.on('data', b => {
      data += b;
      if (data.length > 1024) { socket.destroy(); return; }
      if (!data.includes('\n')) return;
      try {
        const { command } = JSON.parse(data.trim());
        if (!['status', 'disconnect'].includes(command)) { socket.destroy(); return; }
        socket.end(JSON.stringify({ key, pid: process.pid, build: REX_CLOUD_BUILD, authContext: authContext(), lastError }), () => { if (command === 'disconnect') void stop(); });
      } catch { socket.destroy(); }
    });
  });
  async function stop() {
    if (stopping) return; stopping = true;
    await bridge.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  }
  process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(paths.control, resolve); });
  await chmod(paths.control, 0o600);
  process.send?.({ key, pid: process.pid, build: REX_CLOUD_BUILD, authContext: authContext() });
}
