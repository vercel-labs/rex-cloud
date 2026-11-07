import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existingContext, linkedProject } from '../dist/context.js';
import { configure } from '../dist/setup.js';

const scope = { teamId: 'team_linked', projectId: 'prj_linked' };
const link = { orgId: scope.teamId, projectId: scope.projectId };
async function fixture(t) {
  const root = await mkdtemp('/tmp/rex-context-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'app'), configPath = join(root, 'config.json');
  await mkdir(cwd);
  const put = async (path, value) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
  };
  return { root, cwd, configPath, put, env: {} };
}
function authenticated(t) {
  const saved = process.env.VERCEL_TOKEN;
  process.env.VERCEL_TOKEN = 'fixture-only';
  t.after(() => { if (saved === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = saved; });
}
function api({ teams = ['linked', 'current'], status = 200, accountId = scope.teamId } = {}) {
  const calls = [];
  const request = async (url, options) => {
    const path = new URL(url).pathname;
    assert.equal(options.headers.Authorization, 'Bearer fixture-only');
    calls.push({ path, method: options.method ?? 'GET' });
    if (path === '/v2/teams') return Response.json({ teams: teams.map(name => ({ id: `team_${name}`, name })) });
    assert.equal(options.method, undefined, 'inherited existing context must not create a project');
    if (status !== 200) return new Response('', { status });
    return Response.json({ id: path.endsWith('/rex-cloud') ? 'prj_usage' : scope.projectId, accountId, name: 'existing-project' });
  };
  return { request, calls };
}

test('first setup uses the linked project over current CLI team, without mutation or prompts', async t => {
  authenticated(t);
  const f = await fixture(t), a = api();
  await f.put(join(f.cwd, '.vercel/project.json'), link);
  await f.put(f.configPath, { currentTeam: 'team_current' });
  const before = await readFile(f.configPath);
  assert.deepEqual(await configure(f.root, { teamId: undefined, projectId: undefined }, false, { ...f, ...a }), scope);
  assert.deepEqual(await readFile(f.configPath), before);
  assert.deepEqual(JSON.parse(await readFile(join(f.cwd, '.vercel/project.json'))), link);
  assert.equal(a.calls.length, 2);
});

test('current CLI team is selected among multiple teams and uses the usage project', async t => {
  authenticated(t);
  const f = await fixture(t), a = api();
  await f.put(f.configPath, { currentTeam: 'team_current' });
  assert.deepEqual(await configure(f.root, {}, false, { ...f, ...a }), { teamId: 'team_current', projectId: 'prj_usage' });
});

test('personal-account links and null currentTeam allow team-based Sandbox setup', async t => {
  authenticated(t);
  const f = await fixture(t);
  await f.put(join(f.cwd, '.vercel/project.json'), { orgId: 'legacyUser123', projectId: 'prj_personal' });
  await f.put(f.configPath, { currentTeam: 'team_current' });
  assert.deepEqual(await configure(f.root, {}, false, { ...f, ...api() }), { teamId: 'team_current', projectId: 'prj_usage' });
  await f.put(f.configPath, { currentTeam: null });
  assert.deepEqual(await configure(f.root, {}, false, { ...f, ...api({ teams: ['current'] }) }), { teamId: 'team_current', projectId: 'prj_usage' });
});

test('permission failure offers an explicit team choice only in interactive inferred setup', async t => {
  authenticated(t);
  const f = await fixture(t);
  await f.put(f.configPath, { currentTeam: 'team_current' });
  const calls = [];
  const request = async (url, options) => {
    const parsed = new URL(url); calls.push({ team: parsed.searchParams.get('teamId'), method: options.method ?? 'GET' });
    if (parsed.pathname === '/v2/teams') return Response.json({ teams: [{ id: 'team_current', name: 'Current' }, { id: 'team_allowed', name: 'Allowed' }] });
    if (parsed.searchParams.get('teamId') === 'team_current') return new Response('', { status: options.method === 'POST' ? 403 : 404 });
    return Response.json({ id: 'prj_allowed' });
  };
  let selections = 0;
  const select = async (kind, choices) => { selections++; assert.equal(kind, 'team'); assert.deepEqual(choices, [{ id: 'team_allowed', name: 'Allowed' }]); return choices[0].id; };
  assert.deepEqual(await configure(f.root, {}, true, { ...f, request, select }), { teamId: 'team_allowed', projectId: 'prj_allowed' });
  assert.equal(selections, 1);
  for (const [partial, interactive] of [[{}, false], [{ teamId: 'team_current' }, true]]) {
    const before = calls.length;
    await assert.rejects(configure(f.root, partial, interactive, { ...f, request, select }), /HTTP 403/);
    assert.ok(calls.slice(before).every(c => c.team !== 'team_allowed'));
  }
  assert.equal(selections, 1);
});

test('Vercel environment scope wins over links while explicit scope wins over environment', async t => {
  const f = await fixture(t);
  await f.put(join(f.cwd, '.vercel/project.json'), link);
  const env = { VERCEL_ORG_ID: 'team_environment', VERCEL_PROJECT_ID: 'prj_environment' };
  assert.deepEqual(await existingContext({}, f.cwd, f.configPath, env), { teamId: env.VERCEL_ORG_ID, projectId: env.VERCEL_PROJECT_ID });
  assert.deepEqual(await existingContext(scope, f.cwd, f.configPath, env), scope);
  await assert.rejects(existingContext({}, f.cwd, f.configPath, { VERCEL_ORG_ID: 'team_environment' }), /Set both/);
  await assert.rejects(existingContext({}, f.cwd, f.configPath, { VERCEL_ORG_ID: 'personalUser', VERCEL_PROJECT_ID: 'prj_personal' }), /Sandbox requires a Vercel team/);
});

test('context skips untrusted files with a reason and falls back to usable context', async t => {
  const f = await fixture(t);
  const warnings = [];
  t.mock.method(process.stderr, 'write', message => { warnings.push(String(message)); return true; });
  const path = join(f.cwd, '.vercel/project.json');
  await f.put(path, link); await chmod(path, 0o644);
  assert.deepEqual(await linkedProject(f.cwd), scope);
  await f.put(f.configPath, { currentTeam: 'team_current' });
  await chmod(path, 0o664);
  assert.deepEqual(await existingContext({}, f.cwd, f.configPath, {}), { teamId: 'team_current' });
  assert.ok(warnings.some(w => w.includes('writable by others')));
  await rm(path); await f.put(join(f.root, 'linked.json'), link); await symlink(join(f.root, 'linked.json'), path);
  assert.equal(await linkedProject(f.cwd), undefined);
  assert.ok(warnings.some(w => w.includes('symbolic link')));
});

test('sole team is automatic, ambiguous teams need a choice, and inaccessible current team never falls back', async t => {
  authenticated(t);
  const f = await fixture(t);
  assert.deepEqual(await configure(f.root, {}, false, { ...f, ...api({ teams: ['current'] }) }), { teamId: 'team_current', projectId: 'prj_usage' });
  const a = api();
  await assert.rejects(configure(f.root, {}, false, { ...f, ...a }), /Choose your Vercel team/);
  assert.equal(a.calls.length, 1);
  await f.put(f.configPath, { currentTeam: 'team_removed' });
  await assert.rejects(configure(f.root, {}, false, { ...f, ...a }), /no longer accessible/);
  assert.ok(a.calls.every(c => c.path === '/v2/teams'));
});

test('revoked project access and mismatched project ownership fail before usage project creation', async t => {
  authenticated(t);
  const f = await fixture(t);
  await f.put(join(f.cwd, '.vercel/project.json'), link);
  for (const status of [403, 404, 500]) {
    const a = api({ status });
    await assert.rejects(configure(f.root, {}, false, { ...f, ...a }), new RegExp(`HTTP ${status}`));
    assert.equal(a.calls.length, 2);
  }
  await assert.rejects(configure(f.root, {}, false, { ...f, ...api({ accountId: 'team_other' }) }), /does not match/);
});

test('explicit team override never borrows a linked project from another team', async t => {
  authenticated(t);
  const f = await fixture(t);
  await f.put(join(f.cwd, '.vercel/project.json'), link);
  await f.put(f.configPath, { currentTeam: 'team_linked' });
  assert.deepEqual(await configure(f.root, { teamId: 'team_current' }, false, { ...f, ...api() }), { teamId: 'team_current', projectId: 'prj_usage' });
});

test('complete saved or explicit scope wins even with malformed context and discovery disabled', async t => {
  const f = await fixture(t);
  await f.put(join(f.cwd, '.vercel/project.json'), 'invalid');
  const options = { ...f, discover: false, request: () => { throw new Error('must not fetch'); } };
  assert.deepEqual(await configure(f.root, scope, false, options), scope);
  await assert.rejects(configure(f.root, {}, false, options), /start or setup/);
});

test('repo links select the deepest containing directory and prefer a direct link', async t => {
  const f = await fixture(t);
  const cwd = join(f.cwd, 'apps/web/src'); await mkdir(cwd, { recursive: true });
  await f.put(join(f.cwd, '.vercel/repo.json'), { orgId: 'team_root', projects: [
    { id: 'prj_root', name: 'root', directory: '.' },
    { id: scope.projectId, orgId: scope.teamId, name: 'web', directory: 'apps/web' },
  ] });
  assert.deepEqual(await linkedProject(cwd), scope);
  await f.put(join(cwd, '.vercel/project.json'), { orgId: 'team_direct', projectId: 'prj_direct' });
  assert.deepEqual(await linkedProject(cwd), { teamId: 'team_direct', projectId: 'prj_direct' });
});

test('ambiguous repo mappings fail and an ordinary ancestor project link is not inherited', async t => {
  const f = await fixture(t);
  await f.put(join(f.cwd, '.vercel/project.json'), link);
  const cwd = join(f.cwd, 'sub'); await mkdir(cwd);
  assert.equal(await linkedProject(cwd), undefined);
  await f.put(join(f.cwd, '.vercel/repo.json'), { orgId: scope.teamId, projects: [
    { id: 'prj_a', directory: 'a' }, { id: 'prj_b', directory: 'b' },
  ] });
  await assert.rejects(linkedProject(cwd), /Multiple Vercel projects/);
});

test('malformed context has actionable errors and never changes configuration', async t => {
  const f = await fixture(t);
  await f.put(f.configPath, { currentTeam: '../invalid' });
  await assert.rejects(existingContext({}, f.cwd, f.configPath), /teams switch/);
  await f.put(join(f.cwd, '.vercel/project.json'), { orgId: 'team_missing' });
  await assert.rejects(existingContext({}, f.cwd, f.configPath), /vercel link again/);
});

test('actual CLI disconnect keeps saved scope after cwd changes, while unconfigured status cannot set up resources', async t => {
  const f = await fixture(t), state = join(f.root, 'state');
  await mkdir(state, { mode: 0o700 });
  await f.put(join(state, 'scope.json'), scope);
  await f.put(join(f.cwd, '.vercel/project.json'), 'invalid');
  const cli = resolve('dist/cli.js');
  const output = execFileSync(process.execPath, [cli, 'disconnect', '--shared', '--json', '--state-dir', state], { cwd: f.cwd, encoding: 'utf8' });
  assert.equal(JSON.parse(output).disconnected, true);
  assert.deepEqual(JSON.parse(await readFile(join(state, 'scope.json'))), scope);
  for (const command of ['status', 'stop', 'disconnect', 'open'])
    assert.throws(() => execFileSync(process.execPath, [cli, command, '--state-dir', join(f.root, 'new')], { cwd: f.cwd, stdio: 'pipe' }), error => /start or setup/.test(error.stderr.toString()));
});
