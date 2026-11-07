import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { lstatSync, unlinkSync } from 'node:fs';

export interface Scope { teamId: string; projectId: string }
export interface Workspace extends Scope {
  userId?: string; shared?: boolean;
  socketStyle?: 'named';
  name: string; cloudName: string; socket: string; control: string;
  remoteSocket: string; cwd: string; sessionId: string; blockId: string;
}
export function validateName(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(value)) throw new Error('Use a computer name starting with a lowercase letter, followed by up to 31 lowercase letters, numbers or hyphens.');
  return value;
}
export function validateScope(scope: Scope): Scope {
  if (!/^team_[A-Za-z0-9]+$/.test(scope.teamId) || !/^prj_[A-Za-z0-9]+$/.test(scope.projectId))
    throw new Error('Set your Vercel team and project IDs with rex-cloud setup --team team_… --project prj_….');
  return scope;
}
export function duration(value = '45m'): number {
  const m = /^(\d+)(m|h)$/.exec(value);
  const ms = m ? Number(m[1]) * (m[2] === 'h' ? 3600000 : 60000) : 0;
  if (!Number.isSafeInteger(ms) || ms < 60000 || ms > 86400000) throw new Error('Choose a timeout from 1m to 24h. Hobby supports up to 45m.');
  return ms;
}
export function stateRoot(value?: string): string {
  return resolve(value ?? process.env.REX_CLOUD_STATE_DIR ?? join(homedir(), '.local', 'state', 'rex-cloud'));
}
export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077))
    throw new Error(`Expected a private directory owned by you: ${path}`);
}
export async function checkFile(path: string, socket = false): Promise<boolean> {
  try {
    const s = await lstat(path);
    if (s.uid !== process.getuid?.() || s.isSymbolicLink() || (s.mode & 0o077) || (socket ? !s.isSocket() : !s.isFile()))
      throw new Error(`Refusing unsafe local path: ${path}`);
    return true;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function readJSON<T>(path: string): Promise<T | undefined> {
  if (!await checkFile(path)) return undefined;
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
export async function writeJSON(path: string, value: unknown): Promise<void> {
  await checkFile(path);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  try { await rename(tmp, path); } finally { await unlink(tmp).catch(() => {}); }
}
export function locations(root: string, scope: Scope & { socketStyle?: 'named'; userId?: string; shared?: boolean }, name: string) {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  const namespace = scope.userId && !scope.shared ? `/user/${scope.userId}` : '';
  const key = hash(`${scope.teamId}/${scope.projectId}/${validateName(name)}${namespace}`);
  const base = `/tmp/rex-cloud-${process.getuid?.()}-${hash(resolve(root))}`;
  const dir = scope.socketStyle === 'named' ? join(base, key) : base;
  return { key, dir, socket: join(dir, scope.socketStyle === 'named' ? `sandbox-${name}.sock` : `${key}.sock`), control: join(dir, `${key}.ctl`), record: join(root, `${key}.json`) };
}
export async function withLock<T>(root: string, key: string, fn: () => Promise<T>): Promise<T> {
  await privateDir(root);
  const path = join(root, `${key}.lock`);
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another command holds ${path}. Wait for it to finish. If it crashed, inspect this lock before removing it.`);
    throw e;
  }
  const owned = await file.stat();
  const release = () => {
    try { const current = lstatSync(path); if (current.ino === owned.ino && current.dev === owned.dev) unlinkSync(path); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  };
  const onExit = () => { try { release(); } catch {} };
  process.once('exit', onExit);
  try { await file.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); return await fn(); }
  finally { process.removeListener('exit', onExit); await file.close(); release(); }
}
