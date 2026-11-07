import { APIError, Sandbox } from '@vercel/sandbox';
export { APIError };
import { readFile } from 'node:fs/promises';
import { token } from './auth.js';
import { validateName, validateScope, type Scope, type Workspace } from './state.js';
import { cloudName, type Identity } from './identity.js';

export const DEFAULT_IMAGE = 'vercel/sandbox/universal';
export const OWNER = 'rex-cloud-prototype-v1';
export interface Backend {
  get: typeof Sandbox.get; create: typeof Sandbox.create;
}
export function apiCode(e: unknown): string | undefined {
  const value = e as { json?: { error?: { code?: string }; code?: string } };
  return value?.json?.error?.code ?? value?.json?.code;
}
export function assertOwned(s: Pick<Sandbox, 'tags'>, scope: Partial<Identity>): void {
  if (s.tags?.launcher !== OWNER) throw new Error('This name belongs to a computer not created by rex-cloud. Choose another name.');
  if (scope.shared !== true && (s.tags?.owner !== scope.userId || s.tags?.sharing !== 'personal')) throw new Error('This computer belongs to another user or sharing mode. It was left unchanged.');
  if (scope.shared === true && s.tags?.sharing === 'personal') throw new Error('A personal computer cannot be opened as shared.');
}
export async function credentials(scope: Scope) { const { teamId, projectId } = validateScope(scope); return { teamId, projectId, token: await token() }; }
export async function findComputer(scope: Scope & Partial<Identity>, name: string, backend: Backend = Sandbox) {
  const s = await backend.get({ ...await credentials(scope), name: cloudName(scope, name), resume: false });
  assertOwned(s, scope);
  return s;
}
export async function ensureComputer(scope: Identity, name: string, opts: { create: boolean; image?: string; timeout: number | (() => Promise<number>); onProgress?: (action: 'creating' | 'resuming' | 'connecting') => void }, backend: Backend = Sandbox) {
  const auth = await credentials(scope), computerName = cloudName(scope, name);
  const timeout = () => typeof opts.timeout === 'function' ? opts.timeout() : Promise.resolve(opts.timeout);
  let s: Sandbox, created = false, resumed = false;
  try { s = await backend.get({ ...auth, name: computerName, resume: false }); }
  catch (e) {
    if (apiCode(e) !== 'not_found' || !opts.create) throw e;
    try {
      opts.onProgress?.('creating');
      s = await backend.create({ ...auth, name: computerName, image: opts.image ?? DEFAULT_IMAGE, timeout: await timeout(), resources: { vcpus: 2 }, tags: { launcher: OWNER, owner: scope.userId, sharing: scope.shared ? 'team' : 'personal', image: opts.image ?? DEFAULT_IMAGE }, persistent: true, keepLastSnapshots: { count: 1 } });
      created = true;
    } catch (error) {
      if (!(error instanceof APIError && error.response.status === 409)) throw error;
      s = await backend.get({ ...auth, name: computerName, resume: false });
    }
  }
  assertOwned(s, scope);
  if (opts.image && s.tags?.image !== opts.image) throw new Error('That computer already uses another image. Choose a new computer name to use this image.');
  if (!created && (!scope.shared || s.tags?.sharing === 'team') && (s.keepLastSnapshots?.count !== 1 || s.keepLastSnapshots.deleteEvicted === false)) await s.update({ keepLastSnapshots: { count: 1 } });
  if (s.status !== 'running') {
    if (!['stopped', 'failed', 'aborted'].includes(s.status)) throw new Error(`Computer is ${s.status}. Wait, then run open again.`);
    opts.onProgress?.('resuming');
    await s.update({ timeout: await timeout() });
    s = await backend.get({ ...auth, name: computerName, resume: true });
    assertOwned(s, scope);
    resumed = true;
  } else if (!created) opts.onProgress?.('connecting');
  return { sandbox: s, created, resumed };
}
export async function bootstrap(s: Sandbox, name: string, compatibility: { min: number; max: number }): Promise<Pick<Workspace, 'remoteSocket' | 'cwd' | 'sessionId' | 'blockId'>> {
  const script = await readFile(new URL('../assets/bootstrap.py', import.meta.url), 'utf8');
  const command = await s.currentSession().runCommand({ cmd: 'python3', args: ['-c', script, name, String(compatibility.min), String(compatibility.max)], cwd: s.cwd });
  const stdout = await command.stdout();
  if (command.exitCode !== 0) {
    const err = (await command.stderr()).slice(-1200);
    throw new Error(`Could not start Rex. Custom images need Python 3, CA certificates, Linux amd64 with glibc and Rex's PAM dependencies. ${err}`);
  }
  const data = JSON.parse(stdout);
  if (!data.remoteSocket?.startsWith('/') || !data.cwd?.startsWith('/') || !data.sessionId || !data.blockId) throw new Error('Rex returned incomplete startup information.');
  return data;
}
export function summary(s: Sandbox, name: string) {
  return { name, cloudName: s.name, vm: s.currentSession().sessionId, status: s.status, image: s.image, expiresAt: s.expiresAt?.toISOString(), snapshotId: s.currentSnapshotId };
}
export function friendlyError(e: unknown): string {
  if (e instanceof APIError) {
    const code = apiCode(e);
    if (e.response.status === 401 || e.response.status === 403) return 'Vercel could not authorize this operation. Check your team/project access or run rex-cloud login.';
    if (code === 'not_found') return 'Computer or resource scope not found. Check setup, or use start to create a new computer.';
    if (code === 'snapshot_not_found') return 'The saved snapshot is unavailable. The computer was preserved. Use another name or investigate the snapshot.';
    if (code === 'image_not_ready') return 'The image is still being prepared by Vercel. Retry when its status is Ready.';
    return `Vercel request failed (HTTP ${e.response.status}${code && /^[a-z_]+$/.test(code) ? `, ${code}` : ''}). Check scope, image and plan limits.`;
  }
  return e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, '[URL omitted]') : 'Operation failed.';
}
