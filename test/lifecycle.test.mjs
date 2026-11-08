import test from 'node:test';
import assert from 'node:assert/strict';
import { agentInfo, deleteComputer, OWNER, APIError } from '../dist/cloud.js';
import { unregisterHost } from '../dist/desktop.js';

// deleteComputer reads credentials before touching the backend; a fixture token keeps the suite independent of a
// Vercel login, which CI does not have.
const savedToken = process.env.VERCEL_TOKEN;
test.before(() => { process.env.VERCEL_TOKEN = 'test-only'; });
test.after(() => { if (savedToken === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = savedToken; });
const scope = { teamId: 'team_fixture', projectId: 'prj_fixture', userId: 'user_fixture', shared: false };
const owned = { launcher: OWNER, owner: 'user_fixture', sharing: 'personal' };
function computer(status, tags = owned) {
  const calls = [];
  return { calls, name: 'rex-cloud-x-dev', status, tags,
    stop: async () => { calls.push('stop'); }, delete: async opts => { calls.push(['delete', opts]); } };
}

test('deleteComputer stops a running computer, then deletes it with its snapshots', async () => {
  const s = computer('running');
  const result = await deleteComputer(scope, 'dev', { get: async () => s });
  assert.deepEqual(s.calls, ['stop', ['delete', { deleteOrphanSnapshots: true }]]);
  assert.equal(result.cloudName, 'rex-cloud-x-dev');
});
test('deleteComputer does not stop a stopped computer and refuses one it does not own', async () => {
  const stopped = computer('stopped');
  await deleteComputer(scope, 'dev', { get: async () => stopped });
  assert.deepEqual(stopped.calls, [['delete', { deleteOrphanSnapshots: true }]]);
  const other = computer('running', { ...owned, owner: 'someone_else' });
  await assert.rejects(deleteComputer(scope, 'dev', { get: async () => other }), /another user/);
  assert.deepEqual(other.calls, []);
});
test('deleteComputer refuses a computer that is mid-transition and deletes nothing', async () => {
  for (const status of ['stopping', 'snapshotting', 'pending']) {
    const s = computer(status);
    await assert.rejects(deleteComputer(scope, 'dev', { get: async () => s }), /Retry delete/);
    assert.deepEqual(s.calls, []);
  }
});
const notFound = () => new APIError(new Response('', { status: 404 }), { json: { error: { code: 'not_found' } } });
test('deleteComputer reports an already-gone computer as not found, but a not_found during delete as a failure', async () => {
  assert.deepEqual(await deleteComputer(scope, 'dev', { get: async () => { throw notFound(); } }), { found: false });
  const s = { ...computer('stopped'), delete: async () => { throw notFound(); } };
  await assert.rejects(deleteComputer(scope, 'dev', { get: async () => s }));
});
test('deleteComputer runs beforeDelete only after ownership and state checks pass', async () => {
  let ran = 0;
  const hooks = { beforeDelete: async () => { ran++; } };
  await assert.rejects(deleteComputer(scope, 'dev', { get: async () => computer('stopping') }, hooks));
  await assert.rejects(deleteComputer(scope, 'dev', { get: async () => computer('running', { ...owned, owner: 'x' }) }, hooks));
  assert.equal(ran, 0);
  const ok = computer('running');
  await deleteComputer(scope, 'dev', { get: async () => ok }, hooks);
  assert.equal(ran, 1);
});
test('agentInfo gives the sandbox name and scope the Sandbox CLI needs', () => {
  assert.deepEqual(agentInfo(scope, { name: 'rex-cloud-x-dev' }), { sandbox: 'rex-cloud-x-dev', teamId: 'team_fixture', projectId: 'prj_fixture' });
});

const sock = '/tmp/rex-cloud-501-0123456789abcdef/k/sandbox-dev.sock';
const other = 'unix:///tmp/rex-cloud-501-fedcba9876543210/k/sandbox-dev.sock';
function rex(hosts) {
  const calls = [];
  return { calls, run: async args => { calls.push(args); return args[1] === '--json' ? JSON.stringify({ hosts }) : ''; } };
}
test('unregisterHost removes a host whose only endpoint is this socket', async () => {
  const r = rex([{ host: { label: 'dev', endpoints: [`unix://${sock}`] } }]);
  assert.equal(await unregisterHost(sock, r.run), 'removed');
  assert.deepEqual(r.calls.at(-1), ['hosts', 'remove', 'dev']);
});
test('unregisterHost keeps other devices\' endpoints on a shared host', async () => {
  const r = rex([{ host: { label: 'dev', endpoints: [`unix://${sock}`, other] } }]);
  assert.equal(await unregisterHost(sock, r.run), 'edited');
  assert.deepEqual(r.calls.at(-1), ['hosts', 'edit', 'dev', '--endpoint', other]);
});
test('unregisterHost leaves unrelated and non-rex-cloud hosts alone', async () => {
  const r = rex([
    { host: { label: 'studio', endpoints: ['studio.local'] } },
    { host: { label: 'mixed', endpoints: [`unix://${sock}`, 'studio.local'] } },
  ]);
  assert.equal(await unregisterHost(sock, r.run), 'none');
  assert.equal(r.calls.length, 1);
});
test('unregisterHost reports unsupported when rex hosts is unavailable', async () => {
  assert.equal(await unregisterHost(sock, async () => { throw new Error('no rex'); }), 'unsupported');
});
