import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, chmod } from 'node:fs/promises';
import { createServer } from 'node:net';
import { locations, writeJSON, withLock } from '../dist/state.js';
import { ensureHelper, control, disconnect, saveAccount } from '../dist/helper.js';

test('detached helper reuses its socket, disconnects cleanly and recovers from a crash', async t => {
  const root = await mkdtemp('/tmp/rex-helper-test-'); await chmod(root, 0o700);
  const scope = { teamId: 'team_fixture', projectId: 'prj_fixture' }, name = 'test';
  const paths = locations(root, scope, name);
  const work = { ...scope, name, cloudName: 'rex-cloud-test', socket: paths.socket, control: paths.control, remoteSocket: '/tmp/unused.sock', cwd: '/tmp', sessionId: 'fixture', blockId: 'fixture' };
  await writeJSON(paths.record, work);
  t.after(async () => { await disconnect(root, work); await rm(root, { recursive: true, force: true }); await rm(paths.dir, { recursive: true, force: true }); });
  const first = await withLock(root, paths.key, () => ensureHelper(root, work));
  assert.equal((await ensureHelper(root, work)).pid, first.pid);
  assert.equal((await control(paths.control)).key, paths.key);
  await disconnect(root, work); assert.equal(await control(paths.control), undefined);
  const second = await ensureHelper(root, work); assert.notEqual(second.pid, first.pid);
  process.kill(second.pid, 'SIGKILL');
  for (let i = 0; i < 20; i++) { if (!await control(paths.control)) break; await new Promise(r => setTimeout(r, 50)); }
  const third = await ensureHelper(root, work); assert.notEqual(third.pid, second.pid);
  await disconnect(root, work); await disconnect(root, work);
  let upgraded = false;
  const old = createServer(socket => socket.once('data', data => {
    const { command } = JSON.parse(data);
    socket.end(JSON.stringify({ key: paths.key, pid: process.pid }), () => {
      if (command === 'disconnect') { upgraded = true; old.close(); }
    });
  }));
  await new Promise(resolve => old.listen(paths.control, resolve));
  await chmod(paths.control, 0o600);
  const current = await ensureHelper(root, work);
  assert.equal(upgraded, true);
  assert.match(current.build, /^[a-f0-9]{64}$/);
  assert.notEqual(current.pid, process.pid);
  const prior = process.env.VERCEL_TOKEN;
  try {
    process.env.VERCEL_TOKEN = 'replacement-fixture';
    const replaced = await ensureHelper(root, work);
    assert.notEqual(replaced.pid, current.pid);
    assert.equal((await ensureHelper(root, work)).pid, replaced.pid);
  } finally { if (prior === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = prior; }
});

test('switching accounts disconnects the previous personal helper without changing its cloud work', async t => {
  const root = await mkdtemp('/tmp/rex-account-test-'); await chmod(root, 0o700);
  const scope = { teamId: 'team_fixture', projectId: 'prj_fixture', userId: 'alice', shared: false };
  const paths = locations(root, scope, 'dev');
  const work = { ...scope, name: 'dev', cloudName: 'fixture', socket: paths.socket, control: paths.control, remoteSocket: '/tmp/unused.sock', cwd: '/tmp', sessionId: 'fixture', blockId: 'fixture' };
  await writeJSON(paths.record, work);
  t.after(async () => { await disconnect(root, work); await rm(root, { recursive: true, force: true }); await rm(paths.dir, { recursive: true, force: true }); });
  await saveAccount(root, 'alice');
  const first = await ensureHelper(root, work);
  assert.equal(await saveAccount(root, 'alice'), 0);
  assert.equal((await control(paths.control)).pid, first.pid);
  assert.equal(await saveAccount(root, 'bob'), 1);
  assert.equal(await control(paths.control), undefined);
});
