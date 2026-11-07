import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkFile } from './state.js';

const exec = promisify(execFile);
export interface RexApp { path: string; build: number }
export function parseCompatibility(version: string): { min: number; max: number } {
  const match = /api:\s*revision\s+\d+\s+\(supports\s+(\d+)\s+to\s+(\d+)\)/.exec(version);
  if (!match || Number(match[1]) > Number(match[2])) throw new Error('Could not verify Rex protocol compatibility. Update the Rex CLI before starting cloud compute.');
  return { min: Number(match[1]), max: Number(match[2]) };
}
export async function rexCompatibility() {
  const { stdout } = await exec('rex', ['version'], { timeout: 5000 });
  return parseCompatibility(stdout);
}
export function newestApp(apps: RexApp[]): RexApp | undefined {
  return apps.filter(a => Number.isSafeInteger(a.build) && a.build >= 1758).sort((a, b) => b.build - a.build)[0];
}
export async function installedRex(): Promise<RexApp> {
  if (process.platform !== 'darwin') throw new Error('Run rex-cloud on your Mac. Cloud terminals run inside the Sandbox.');
  const apps: RexApp[] = [];
  for (const dir of ['/Applications', join(homedir(), 'Applications')]) {
    for (const name of ['Rex.app', 'Rex Beta.app']) {
      const path = join(dir, name);
      try {
        const { stdout } = await exec('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', join(path, 'Contents/Info.plist')], { timeout: 3000 });
        apps.push({ path, build: Number(stdout.trim()) });
      } catch {}
    }
  }
  const app = newestApp(apps);
  if (!app) throw new Error('Install a current Rex app in Applications (tested minimum: build 1758), then retry. Older copies opened from an installer may not accept cloud hosts.');
  return app;
}
export function foregroundMatches(output: string, app: RexApp): boolean {
  return output.includes(`"LSBundlePath"="${app.path}"`) && output.includes(`"CFBundleVersion"="${app.build}"`);
}
export async function openDesktop(app: RexApp): Promise<boolean> {
  await exec('/usr/bin/open', ['-a', app.path], { timeout: 10000 });
  const { stdout: front } = await exec('/usr/bin/lsappinfo', ['front'], { timeout: 3000 });
  const { stdout } = await exec('/usr/bin/lsappinfo', ['info', '-only', 'bundlepath,CFBundleVersion', front.trim()], { timeout: 3000 });
  return foregroundMatches(stdout, app);
}
export async function attached(socket: string): Promise<boolean | undefined> {
  try {
    const { stdout } = await exec('rex', ['--autostart=false', '--timeout', '3s', '-S', socket, 'client', 'ls', '--json'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const data = JSON.parse(stdout);
    if (!Array.isArray(data.clients)) return;
    return data.clients.some((c: { info?: { kind?: string }; connection_state?: string }) => c.info?.kind === 'app' && c.connection_state === 'connected');
  } catch { return; }
}
export const CLOUD_SOCKET = /^unix:\/\/\/tmp\/rex-cloud-\d+-[a-f0-9]{16}\//;
export interface HostEntry { host: { label: string; endpoints: string[]; icon?: string }; from: string; held: boolean }
export type HostRegistration = 'added' | 'updated' | 'current' | 'conflict' | 'unsupported';
/**
 * Register the computer as a Rex host named after it, so it appears in Rex by label instead of a pasted socket path.
 * Only hosts whose endpoint is a rex-cloud socket are ever changed. Failures never block the connection.
 */
export async function registerHost(name: string, socket: string,
  run: (args: string[]) => Promise<string> = async args => (await exec('rex', ['--autostart=false', '--timeout', '5s', ...args], { timeout: 10000, maxBuffer: 1024 * 1024 })).stdout,
  live: (path: string) => Promise<boolean> = path => checkFile(path, true).catch(() => true),
): Promise<HostRegistration> {
  const endpoint = `unix://${socket}`;
  let hosts: HostEntry[];
  try {
    const data = JSON.parse(await run(['hosts', '--json'])) as { hosts?: HostEntry[] };
    if (!Array.isArray(data.hosts)) return 'unsupported';
    hosts = data.hosts;
  } catch { return 'unsupported'; }
  const existing = hosts.find(h => h.host?.label?.toLowerCase() === name.toLowerCase());
  if (existing) {
    const endpoints = existing.host.endpoints ?? [];
    if (endpoints.includes(endpoint)) return 'current';
    // Only replace a stale rex-cloud socket. A socket that still exists belongs to another live bridge with the same
    // name (another account, --shared, or --state-dir), so it is left alone rather than silently repointed.
    if (!endpoints.every(e => CLOUD_SOCKET.test(e))) return 'conflict';
    for (const e of endpoints) if (await live(e.slice('unix://'.length))) return 'conflict';
    try { await run(['hosts', 'edit', existing.host.label, '--endpoint', endpoint]); return 'updated'; } catch { return 'unsupported'; }
  }
  try { await run(['hosts', 'add', name, endpoint, '--icon', 'cloud']); return 'added'; } catch { return 'unsupported'; }
}
export function label(ms: number): string {
  const minutes = Math.round(ms / 60000), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours && rest ? `${hours}h ${rest}m` : hours ? `${hours}h` : `${rest}m`;
}
export function stopTime(iso?: string, now = Date.now()): string {
  if (!iso) return 'not running';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown; run rex-cloud status';
  return `${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })} (${label(Math.max(0, date.getTime() - now))} remaining)`;
}
