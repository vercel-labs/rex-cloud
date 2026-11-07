import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
export function stopTime(iso?: string, now = Date.now()): string {
  if (!iso) return 'not running';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'unknown; run rex-cloud status';
  return `${date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })} (${Math.max(0, Math.ceil((date.getTime() - now) / 60000))} min remaining)`;
}
