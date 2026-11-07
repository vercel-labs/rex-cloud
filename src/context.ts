import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { getConfigFilePath, getGlobalPathConfig } from '@vercel/cli-config';
import { validateScope, type Scope } from './state.js';

async function readConfig(path: string): Promise<any> {
  try {
    for (const entry of [dirname(path), path]) {
      const info = await lstat(entry);
      const reason = info.isSymbolicLink() ? 'it is a symbolic link'
        : info.uid !== process.getuid?.() ? 'it belongs to another user'
        : (info.mode & 0o022) ? 'it is writable by others' : undefined;
      if (reason) {
        process.stderr.write(`Ignoring Vercel context at ${JSON.stringify(path)} because ${reason}.\n`);
        return undefined;
      }
    }
    const value = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read Vercel context at ${path}. Repair the configuration or pass --team and --project explicitly.`);
  }
}

function linkedScope(value: any): Scope | undefined {
  try {
    if (typeof value.orgId !== 'string' || !/^[A-Za-z0-9_]+$/.test(value.orgId) || typeof value.projectId !== 'string' || !/^prj_[A-Za-z0-9]+$/.test(value.projectId)) throw new Error('Invalid link');
    if (!value.orgId.startsWith('team_')) return undefined;
    return validateScope({ teamId: value.orgId, projectId: value.projectId });
  }
  catch { throw new Error('The Vercel project link is invalid. Run vercel link again, or pass --team and --project explicitly.'); }
}

export async function linkedProject(cwd: string): Promise<Scope | undefined> {
  const direct = await readConfig(join(cwd, '.vercel', 'project.json'));
  if (direct) return linkedScope(direct);
  for (let dir = resolve(cwd); dir !== homedir(); dir = dirname(dir)) {
    const repo = await readConfig(join(dir, '.vercel', 'repo.json'));
    if (repo) {
      if (!Array.isArray(repo.projects) || repo.projects.some((p: any) => !p || typeof p.directory !== 'string'))
        throw new Error('Invalid Vercel repository link. Run vercel link --repo again.');
      const path = relative(dir, cwd);
      const matches = repo.projects.filter((p: any) => p.directory === '.' || path === p.directory || path.startsWith(`${p.directory}/`))
        .sort((a: any, b: any) => b.directory.split('/').length - a.directory.split('/').length);
      const candidates = matches.length ? matches.filter((p: any) => p.directory === matches[0].directory) : repo.projects;
      if (candidates.length !== 1) throw new Error('Multiple Vercel projects could apply here. Run from a linked app directory, or pass --team and --project explicitly.');
      const project = candidates[0];
      return linkedScope({ orgId: project.orgId ?? repo.orgId, projectId: project.id });
    }
    if (dirname(dir) === dir) break;
  }
}

export async function existingContext(partial: Partial<Scope>, cwd = process.cwd(), configPath = getConfigFilePath(getGlobalPathConfig()), env: NodeJS.ProcessEnv = process.env): Promise<Partial<Scope>> {
  if (partial.teamId && partial.projectId) return partial;
  if (env.VERCEL_ORG_ID || env.VERCEL_PROJECT_ID) {
    if (!env.VERCEL_ORG_ID || !env.VERCEL_PROJECT_ID) throw new Error('Set both VERCEL_ORG_ID and VERCEL_PROJECT_ID, or pass --team and --project explicitly.');
    if (!env.VERCEL_ORG_ID.startsWith('team_')) throw new Error('Sandbox requires a Vercel team. Set VERCEL_ORG_ID to a team_… ID and VERCEL_PROJECT_ID to a project in that team, or pass --team and --project explicitly.');
    const environment = validateScope({ teamId: env.VERCEL_ORG_ID, projectId: env.VERCEL_PROJECT_ID });
    if ((!partial.teamId || partial.teamId === environment.teamId) && (!partial.projectId || partial.projectId === environment.projectId)) return environment;
  }
  const linked = await linkedProject(cwd);
  if (linked && (!partial.teamId || partial.teamId === linked.teamId) && (!partial.projectId || partial.projectId === linked.projectId))
    return linked;
  if (partial.teamId) return partial;
  const config = await readConfig(configPath);
  if (config?.currentTeam != null && (typeof config.currentTeam !== 'string' || !/^team_[A-Za-z0-9]+$/.test(config.currentTeam)))
    throw new Error('The current Vercel team is invalid. Run vercel teams switch, or pass --team explicitly.');
  return { ...partial, ...(config?.currentTeam ? { teamId: config.currentTeam } : {}) };
}
