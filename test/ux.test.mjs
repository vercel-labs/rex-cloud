import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { locations } from '../dist/state.js';
import { listChoices, selection, configure, display } from '../dist/setup.js';
import { newestApp, foregroundMatches, stopTime } from '../dist/desktop.js';

test('named sockets remain short and scoped, while existing socket locations stay stable', () => {
  const scope = { teamId: 'team_test', projectId: 'prj_test' };
  const old = locations('/tmp/a', scope, 'dev');
  assert.match(old.socket, /\/[a-f0-9]{16}\.sock$/);
  const fresh = locations('/tmp/a', { ...scope, socketStyle: 'named' }, 'remote');
  assert.match(fresh.socket, /sandbox-remote\.sock$/);
  assert.notEqual(fresh.socket, locations('/tmp/a', { ...scope, projectId: 'prj_other', socketStyle: 'named' }, 'remote').socket);
  assert.equal(old.record, locations('/tmp/a', { ...scope, socketStyle: 'named' }, 'dev').record);
  assert.ok(locations('/tmp/a', { ...scope, socketStyle: 'named' }, 'a'.repeat(32)).socket.length < 104);
});

test('setup follows team timestamps and project continuation tokens without exposing API errors', async () => {
  const saved = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'test-only';
  try {
    for (const kind of ['teams', 'projects']) {
      const urls = [];
      const choices = await listChoices(kind, 'team_test', async (url, options) => {
        urls.push(new URL(url)); assert.equal(options.headers.Authorization, 'Bearer test-only');
        return Response.json({ [kind]: [{ id: 'id' + urls.length, name: 'Choice' + urls.length }], pagination: { next: urls.length === 1 ? (kind === 'teams' ? 123 : 'opaque-cursor') : null } });
      });
      assert.equal(choices.length, 2);
      assert.equal(urls[1].searchParams.get(kind === 'teams' ? 'until' : 'from'), kind === 'teams' ? '123' : 'opaque-cursor');
    }
    await assert.rejects(listChoices('teams', undefined, async () => new Response('private payload', { status: 403 })), e => /403/.test(e.message) && !/private/.test(e.message));
    await assert.rejects(listChoices('teams', undefined, async () => Response.json({ teams: [], pagination: { next: 123 } })), /did not advance/);
    await assert.rejects(listChoices('teams', undefined, async () => Response.json({ teams: 'bad' })), /unexpected/);
  } finally { if (saved === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = saved; }
});

test('noninteractive setup fails with a next step, and selections reject ambiguous input', async () => {
  await assert.rejects(configure('/unused', {}, false, { discover: false }), /start or setup/);
  await assert.rejects(configure('/unused', { teamId: '../bad' }, true), /team ID/);
  const choices = [{ id: 'team_test', name: 'Team' }];
  for (const input of ['0', '2', '-1', '1abc', '']) assert.equal(selection(input, choices), undefined);
  assert.equal(selection(' 1 ', choices).id, 'team_test');
  assert.doesNotMatch(display('\x1b[31mTeam\r\n'), /[\x00-\x1f]/);
});

test('desktop preflight chooses supported installed build and does not mistake old foreground copy for success', () => {
  const current = { path: '/Applications/Rex Beta.app', build: 1758 };
  assert.equal(newestApp([{ path: '/old', build: 1203 }, current]), current);
  assert.equal(newestApp([{ path: '/old', build: 1203 }]), undefined);
  assert.equal(foregroundMatches('"LSBundlePath"="/Volumes/Rex Beta/Rex Beta.app"\n"CFBundleVersion"="1203"', current), false);
  assert.equal(foregroundMatches('"LSBundlePath"="/Applications/Rex Beta.app"\n"CFBundleVersion"="1758"', current), true);
  assert.match(stopTime('2026-11-06T23:00:00Z', Date.parse('2026-11-06T22:15:00Z')), /45m remaining/);
  assert.match(stopTime('2026-11-08T13:10:00Z', Date.parse('2026-11-07T17:40:00Z')), /19h 30m remaining/);
});

test('interrupt releases only the active command lock so a user can retry', async t => {
  const root = await mkdtemp('/tmp/rex-interrupt-'); t.after(() => rm(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withLock} from './dist/state.js';process.on('SIGINT',()=>process.exit(130));await withLock(${JSON.stringify(root)},'command',async()=>{setInterval(()=>{},1000);console.log('ready');await new Promise(()=>{});});`], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await once(child.stdout, 'data');
  const exited = once(child, 'exit'); child.kill('SIGINT'); assert.equal((await exited)[0], 130);
  await assert.rejects(access(`${root}/command.lock`), { code: 'ENOENT' });
});

test('cloud prompt initializes empty homes and preserves existing shell customizations', async t => {
  const root = await mkdtemp('/tmp/rex-prompt-'); t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('python3', ['-c', `import pathlib,runpy,sys\nf=runpy.run_path('assets/bootstrap.py')['setup_prompt'];p=pathlib.Path(sys.argv[1]);f(p,'remote');f(p,'other')\nassert 'sandbox:remote' in (p/'.bashrc').read_text()\nq=p/'custom';q.mkdir();(q/'.bashrc').write_text('custom prompt');f(q,'remote')\nassert (q/'.bashrc').read_text()=='custom prompt'\nassert not (q/'.profile').exists()`, root]);
  assert.match(await readFile(`${root}/.profile`, 'utf8'), /\.bashrc/);
});

test('host registration adds or updates only rex-cloud hosts and never blocks on failures', async () => {
  const { registerHost } = await import('../dist/desktop.js');
  const socket = '/tmp/rex-cloud-501-0123456789abcdef/fedcba9876543210/sandbox-remote.sock';
  const calls = [];
  const rex = hosts => async args => { calls.push(args.join(' ')); if (args[0] === 'hosts' && args[1] === '--json') return JSON.stringify({ hosts }); return ''; };
  assert.equal(await registerHost('remote', socket, rex([])), 'added');
  assert.match(calls.at(-1), /^hosts add remote unix:\/\/\/tmp\/rex-cloud-501-[a-f0-9]+\/[a-f0-9]+\/sandbox-remote\.sock --icon cloud$/);
  assert.equal(await registerHost('Remote', socket, rex([{ host: { label: 'remote', endpoints: [`unix://${socket}`] }, from: 'home', held: false }])), 'current');
  assert.equal(await registerHost('remote', socket, rex([{ host: { label: 'remote 1', endpoints: [`unix://${socket}`] }, from: 'home', held: false }])), 'current', 'a host the user renamed in Rex is recognised by its endpoint');
  assert.equal(await registerHost('remote', socket, rex([]), undefined, 'remote 1'), 'added');
  assert.match(calls.at(-1), /^hosts add remote 1 unix:/, '--label names the host');
  const stale = 'unix:///tmp/rex-cloud-501-0123456789abcdef/0000000000000000/sandbox-remote.sock';
  assert.equal(await registerHost('remote', socket, rex([{ host: { label: 'Remote', endpoints: [stale] }, from: 'home', held: false }]), async () => false), 'updated');
  assert.equal(calls.at(-1), `hosts edit Remote --endpoint ${stale} --endpoint unix://${socket}`, 'edits by the existing label and keeps other devices’ endpoints');
  assert.equal(await registerHost('remote', socket, rex([{ host: { label: 'remote', endpoints: [stale] }, from: 'home', held: false }]), async () => true), 'conflict', 'a live socket of another bridge is never repointed');
  assert.equal(await registerHost('remote', socket, rex([{ host: { label: 'remote', endpoints: [stale, `unix://${socket}`] }, from: 'home', held: false }])), 'current');
  assert.equal(await registerHost('remote', socket, async args => { if (args[1] === '--json') return JSON.stringify({ hosts: [{ host: { label: 'remote', endpoints: [stale] }, from: 'home', held: true }] }); throw new Error('home is away'); }, async () => false), 'unsupported');
  assert.equal(await registerHost('remote', socket, rex([{ host: { label: 'remote', endpoints: ['ssh://studio'] }, from: 'home', held: false }])), 'conflict');
  assert.equal(await registerHost('remote', socket, async () => { throw new Error('unknown command "hosts"'); }), 'unsupported');
  assert.equal(await registerHost('remote', socket, async () => 'not json'), 'unsupported');
  assert.ok(calls.every(c => !c.includes('remove')), 'registration never removes hosts');
});
