import { createInterface } from 'node:readline/promises';
import { stdin, stderr } from 'node:process';
import { authenticate, token } from './auth.js';
import { validateScope, type Scope } from './state.js';
import { existingContext } from './context.js';

export interface Choice { id: string; name: string }
export class ProjectAccessError extends Error {}
export const display = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 160);
export async function listChoices(kind: 'teams' | 'projects', teamId?: string, request: typeof fetch = fetch, search?: string): Promise<Choice[]> {
  const url = new URL(kind === 'teams' ? 'https://api.vercel.com/v2/teams' : 'https://api.vercel.com/v10/projects');
  url.searchParams.set('limit', '100');
  if (teamId) url.searchParams.set('teamId', teamId);
  if (search) url.searchParams.set('search', search);
  const choices = new Map<string, Choice>(), cursors = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const response = await request(url.toString(), { headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Could not list Vercel ${kind} (HTTP ${response.status}). Check access or run rex-cloud login.`);
    const data = await response.json() as Record<string, unknown> & { pagination?: { next?: string | number | null } };
    const entries = data[kind];
    if (!Array.isArray(entries)) throw new Error(`Vercel returned an unexpected ${kind} list.`);
    for (const item of entries) {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') throw new Error(`Vercel returned an invalid ${kind} entry.`);
      choices.set(item.id, { id: item.id, name: display(item.name) });
    }
    const next = data.pagination?.next;
    if (next == null) return [...choices.values()];
    if (!['string', 'number'].includes(typeof next) || cursors.has(String(next))) throw new Error('Vercel pagination did not advance. Retry setup.');
    cursors.add(String(next));
    url.searchParams.delete('from'); url.searchParams.delete('until');
    url.searchParams.set(typeof next === 'number' || kind === 'teams' ? 'until' : 'from', String(next));
  }
  throw new Error('Too many results. Configure explicit team/project IDs with rex-cloud setup.');
}

export function selection(answer: string, choices: Choice[]): Choice | undefined {
  if (!/^\d+$/.test(answer.trim())) return;
  return choices[Number(answer.trim()) - 1];
}
export async function ensureUsageProject(teamId: string, request: typeof fetch = fetch): Promise<string> {
  const identity = async (response: Response): Promise<string> => {
    const data = await response.json() as { id?: unknown };
    if (typeof data.id !== 'string' || !/^prj_[A-Za-z0-9]+$/.test(data.id)) throw new Error('Vercel returned an invalid project identity.');
    return data.id;
  };
  const find = async () => {
    const response = await request(`https://api.vercel.com/v9/projects/rex-cloud?teamId=${encodeURIComponent(teamId)}`, {
      headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(15000),
    });
    if (response.status === 404) return;
    if (!response.ok) throw new (response.status === 403 ? ProjectAccessError : Error)(`Could not find the rex-cloud usage project (HTTP ${response.status}). Check your team access.`);
    return identity(response);
  };
  const existing = await find();
  if (existing) return existing;
  const response = await request(`https://api.vercel.com/v11/projects?teamId=${encodeURIComponent(teamId)}`, {
    method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'rex-cloud', framework: null }), signal: AbortSignal.timeout(15000),
  });
  if (response.status === 409) { const concurrent = await find(); if (concurrent) return concurrent; }
  if (!response.ok) throw new (response.status === 403 ? ProjectAccessError : Error)(`Could not prepare the rex-cloud usage project (HTTP ${response.status}). Run from a directory linked with vercel link, ask a team administrator to create it, or run setup with --team and --project.`);
  return identity(response);
}
export async function configure(root: string, partial: Partial<Scope>, interactive: boolean, options: {
  discover?: boolean; cwd?: string; configPath?: string; env?: NodeJS.ProcessEnv; request?: typeof fetch;
  select?: (kind: string, choices: Choice[]) => Promise<string>;
} = {}): Promise<Scope> {
  if (partial.teamId && !/^team_[A-Za-z0-9]+$/.test(partial.teamId)) throw new Error('Expected a Vercel team ID beginning with team_.');
  if (partial.projectId && !/^prj_[A-Za-z0-9]+$/.test(partial.projectId)) throw new Error('Expected a Vercel project ID beginning with prj_.');
  if (partial.teamId && partial.projectId) return validateScope(partial as Scope);
  if (options.discover === false) throw new Error('Run rex-cloud start or setup first, or pass --team team_… --project prj_….');
  await authenticate(interactive);
  const request = options.request ?? fetch;
  const context = await existingContext(partial, options.cwd, options.configPath, options.env);
  const teams = await listChoices('teams', undefined, request);
  let rl: ReturnType<typeof createInterface> | undefined;
  const choose = async (kind: string, choices: Choice[]) => {
    if (!choices.length) throw new Error(`No accessible Vercel ${kind} found. Create one in the Vercel dashboard, then retry.`);
    if (!interactive) throw new Error('Choose your Vercel team with rex-cloud setup in a Mac terminal, or pass --team and --project explicitly.');
    if (options.select) {
      const selected = await options.select(kind, choices);
      if (!choices.some(c => c.id === selected)) throw new Error('Invalid team selection.');
      return selected;
    }
    rl ??= createInterface({ input: stdin, output: stderr });
    stderr.write(`\nChoose a ${kind}:\n` + choices.map((c, i) => `  ${i + 1}. ${c.name}`).join('\n') + '\n');
    while (true) {
      const picked = selection(await rl.question('Number: '), choices);
      if (picked) return picked.id;
      stderr.write(`Enter a number from 1 to ${choices.length}.\n`);
    }
  };
  try {
    if (context.teamId && !teams.some(t => t.id === context.teamId))
      throw new Error('Your selected Vercel team is no longer accessible. Run vercel teams switch or pass --team and --project explicitly.');
    let teamId = context.teamId ?? (teams.length === 1 ? teams[0].id : await choose('team', teams));
    let team = teams.find(t => t.id === teamId)!;
    let projectId = context.projectId;
    if (projectId) {
      const response = await request(`https://api.vercel.com/v9/projects/${encodeURIComponent(projectId)}?teamId=${encodeURIComponent(teamId)}`, {
        headers: { Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Could not access the linked Vercel project (HTTP ${response.status}). Check access or run vercel link again.`);
      const project = await response.json() as { id?: string; accountId?: string; name?: string };
      if (project.id !== projectId || project.accountId !== teamId || typeof project.name !== 'string')
        throw new Error('The linked Vercel project does not match its team. Run vercel link again.');
      stderr.write(`Using ${team.name} / ${display(project.name)} for Sandbox usage.\n`);
    } else {
      const tried = new Set<string>();
      while (!projectId) {
        try { projectId = await ensureUsageProject(teamId, request); }
        catch (error) {
          tried.add(teamId);
          const alternatives = teams.filter(t => !tried.has(t.id));
          if (!(error instanceof ProjectAccessError) || !interactive || partial.teamId || options.env?.VERCEL_ORG_ID || (!options.env && process.env.VERCEL_ORG_ID) || !alternatives.length) throw error;
          stderr.write(`Cannot prepare rex-cloud in ${team.name} with your current permissions. Choose another team.\n`);
          teamId = await choose('team', alternatives);
          team = teams.find(t => t.id === teamId)!;
        }
      }
      stderr.write(`Using ${team.name} / rex-cloud for Sandbox usage.\n`);
    }
    const scope = validateScope({ teamId, projectId });
    return scope;
  } finally { rl?.close(); }
}
