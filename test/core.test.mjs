import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, chmod, mkdir, symlink, stat, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duration, validateName, validateScope, locations, privateDir, writeJSON, readJSON, withLock } from '../dist/state.js';
import { APIError, ensureComputer, nearestRegion, newComputerRegion, OWNER, friendlyError } from '../dist/cloud.js';
import { Handshake, MARKER } from '../dist/bridge.js';

const scope = { teamId: 'team_fixture', projectId: 'prj_fixture', userId: 'user_fixture', shared: false };
test('input validation rejects paths, ambiguous durations and invalid scope before provisioning', () => {
  for (const name of ['../foo', 'A', 'x y', '', 'a'.repeat(33)]) assert.throws(() => validateName(name));
  assert.equal(validateName('dev-2'), 'dev-2');
  for (const value of ['0m', '-1h', '25h', '1.5h', '1d', 'NaNm']) assert.throws(() => duration(value));
  assert.equal(duration('8h'), 28800000); assert.equal(duration(), 2700000);
  assert.throws(() => validateScope({ teamId: '../bad', projectId: 'prj_ok' }));
});
test('socket identity is stable and separate across teams, projects and devices', () => {
  const a = locations('/tmp/device-a', scope, 'dev');
  assert.deepEqual(a, locations('/tmp/device-a', scope, 'dev'));
  assert.notEqual(a.socket, locations('/tmp/device-b', scope, 'dev').socket);
  assert.notEqual(a.socket, locations('/tmp/device-a', { ...scope, teamId: 'team_other' }, 'dev').socket);
  assert.ok(a.socket.length < 104);
});
test('private state refuses symlinks and permissive directories; writes are atomic and locked', async t => {
  const root = await mkdtemp(join(tmpdir(), 'rex-state-')); t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700); await privateDir(root);
  const path = join(root, 'state.json'); await writeJSON(path, { n: 1 });
  assert.deepEqual(await readJSON(path), { n: 1 }); assert.equal((await stat(path)).mode & 0o777, 0o600);
  const link = join(root, 'link.json'); await symlink(path, link); await assert.rejects(writeJSON(link, {}), /unsafe/);
  const exposed = join(root, 'exposed'); await mkdir(exposed); await chmod(exposed, 0o755); await assert.rejects(privateDir(exposed), /private/);
  await withLock(root, 'test', async () => { await assert.rejects(withLock(root, 'test', async () => {}), /Another command/); });
  await withLock(root, 'test', async () => writeJSON(path, { n: 2 })); assert.equal(JSON.parse(await readFile(path)).n, 2);
});
test('handshake handles fragmented marker, trailing binary bytes and bounded preamble', () => {
  const h = new Handshake(); assert.equal(h.push(MARKER.subarray(0, 7)), undefined);
  const payload = Buffer.from([0, 255, 13, 10]); assert.deepEqual(h.push(Buffer.concat([MARKER.subarray(7), payload])), payload);
  assert.deepEqual(h.push(payload), payload);
  assert.throws(() => new Handshake().push(Buffer.alloc(4097)), /limit/);
});

function error(code, status = 404) { return new APIError(new Response('', { status }), { json: { error: { code } }, message: 'sensitive https://example.invalid/?token=secret' }); }
function computer(status = 'running', image = 'vercel/sandbox/universal') {
  return { status, tags: { launcher: OWNER, image, owner: scope.userId, sharing: 'personal' }, update: async () => {} };
}
function vercelFetch({ edge = 'sfo1::iad1::fixture', project = Response.json({}) } = {}) {
  return async url => String(url).startsWith('https://api.vercel.com/v9/projects/') ? project.clone() : new Response(null, { headers: { 'x-vercel-id': edge } });
}
test('lifecycle creates only on confirmed not_found and never silently replaces missing snapshots', async t => {
  t.mock.method(globalThis, 'fetch', vercelFetch());
  const previous = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'test-only';
  try {
    for (const err of [error('snapshot_not_found'), error('forbidden', 403), new Error('network')]) {
      let created = false;
      await assert.rejects(ensureComputer(scope, 'dev', { create: true, timeout: 2700000 }, { get: async () => { throw err; }, create: async () => { created = true; } }));
      assert.equal(created, false);
    }
    let created;
    const result = await ensureComputer(scope, 'dev', { create: true, timeout: 2700000 }, { get: async () => { throw error('not_found'); }, create: async args => { created = args; return computer(); } });
    assert.equal(result.created, true); assert.match(created.name, /^rex-cloud-[a-f0-9]{16}-dev$/); assert.equal(created.persistent, true);
    assert.equal(created.image, 'vercel/sandbox/universal'); assert.equal(created.region, 'sfo1');
  } finally { if (previous === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = previous; }
});
test('open does not create, image mismatch and unowned computers are preserved, create races re-read', async t => {
  t.mock.method(globalThis, 'fetch', vercelFetch());
  const previous = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'test-only';
  try {
    await assert.rejects(ensureComputer(scope, 'dev', { create: false, timeout: 2700000 }, { get: async () => { throw error('not_found'); }, create: async () => assert.fail('must not create') }));
    await assert.rejects(ensureComputer(scope, 'dev', { create: true, image: 'custom:v1', timeout: 2700000 }, { get: async () => computer(), create: async () => assert.fail() }), /another image/);
    await assert.rejects(ensureComputer(scope, 'dev', { create: true, timeout: 2700000 }, { get: async () => ({ ...computer(), tags: {} }), create: async () => assert.fail() }), /not created/);
    let gets = 0;
    const result = await ensureComputer(scope, 'dev', { create: true, timeout: 2700000 }, { get: async () => { if (++gets === 1) throw error('not_found'); return computer(); }, create: async () => { throw error('conflict', 409); } });
    assert.equal(result.created, false); assert.equal(gets, 2);
  } finally { if (previous === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = previous; }
});
test('nearest region comes from x-vercel-id and falls back to the Sandbox default when unknown or unreachable', async t => {
  const headers = id => new Response(null, { headers: id ? { 'x-vercel-id': id } : {} });
  for (const [response, expected] of [[headers(' HND1::iad1::abc'), 'hnd1'], [headers('bogus99::abc'), undefined], [headers(), undefined]]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    assert.equal(await nearestRegion(), expected);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('offline'); });
  assert.equal(await nearestRegion(), undefined);
});
test('a project default sandbox region wins over the nearest region, including when the project cannot be read', async t => {
  const auth = { teamId: 'team_fixture', projectId: 'prj_fixture', token: 'test-only' };
  const cases = [
    [Response.json({}), 'sfo1'],
    [Response.json({ sandbox: { region: null, failoverRegions: [] } }), 'sfo1'],
    [Response.json({ sandbox: { region: 'fra1' } }), undefined],
    [new Response('', { status: 403 }), undefined],
  ];
  for (const [project, expected] of cases) {
    t.mock.method(globalThis, 'fetch', vercelFetch({ project }));
    assert.equal(await newComputerRegion(auth), expected);
    t.mock.restoreAll();
  }
});
test('an explicit region is used without detection, and an existing computer in another region is preserved', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('an explicit region must skip detection'));
  const previous = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'test-only';
  try {
    let created;
    await ensureComputer(scope, 'dev', { create: true, region: 'lhr1', timeout: 2700000 }, { get: async () => { throw error('not_found'); }, create: async args => { created = args; return { ...computer(), region: 'lhr1' }; } });
    assert.equal(created.region, 'lhr1');
    await assert.rejects(ensureComputer(scope, 'dev', { create: true, region: 'lhr1', timeout: 2700000 }, { get: async () => ({ ...computer(), region: 'iad1' }), create: async () => assert.fail() }), /runs in iad1/);
    await ensureComputer(scope, 'dev', { create: true, region: 'lhr1', timeout: 2700000 }, { get: async () => ({ ...computer(), region: 'lhr1' }), create: async () => assert.fail() });
  } finally { if (previous === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = previous; }
});
test('API failures do not expose credential-bearing response text', () => {
  assert.doesNotMatch(friendlyError(error('internal', 500)), /secret|token=/);
  assert.match(friendlyError(error('unauthorized', 401)), /login/);
});
