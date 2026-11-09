import test from 'node:test';
import assert from 'node:assert/strict';
import { currentUser, cloudName } from '../dist/identity.js';
import { ensureComputer, findComputer, OWNER, APIError } from '../dist/cloud.js';
import { locations } from '../dist/state.js';

const a = { teamId: 'team_fixture', projectId: 'prj_fixture', userId: 'alice', shared: false };
const b = { ...a, userId: 'bob' };
test('personal default separates users in cloud and local state; sharing is explicit', () => {
  assert.notEqual(cloudName(a, 'dev'), cloudName(b, 'dev'));
  assert.notEqual(locations('/tmp/a', a, 'dev').socket, locations('/tmp/a', b, 'dev').socket);
  assert.equal(cloudName({ ...a, shared: true }, 'dev'), cloudName({ ...b, shared: true }, 'dev'));
  assert.equal(cloudName({ ...a, shared: true }, 'dev'), 'rex-cloud-dev');
  assert.throws(() => cloudName({}, 'dev'), /verified/);
});
test('identity comes from authenticated API and owner mismatches cannot mutate resources', async () => {
  const prior = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'fixture';
  try {
    assert.equal(await currentUser(async (url, opts) => { assert.equal(url, 'https://api.vercel.com/v2/user'); assert.equal(opts.headers.Authorization, 'Bearer fixture'); return Response.json({ user: { id: 'alice' } }); }), 'alice');
    await assert.rejects(currentUser(async () => Response.json({ user: {} })), /invalid/);
    const mutations = [];
    const wrong = { tags: { launcher: OWNER, owner: 'bob', sharing: 'personal' }, status: 'running', update: async args => mutations.push(args) };
    const backend = { get: async () => wrong, create: async () => assert.fail('must not create') };
    await assert.rejects(ensureComputer(a, 'dev', { create: true, timeout: 1000 }, backend), /another user/);
    await assert.rejects(findComputer(a, 'dev', backend), /another user/);
    assert.deepEqual(mutations, []);
  } finally { if (prior === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = prior; }
});
test('snapshot retention applies at creation and to an existing owned computer', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { headers: { 'x-vercel-id': 'iad1::fixture' } }));
  const prior = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'fixture';
  try {
    const updates = [];
    const computer = { tags: { launcher: OWNER, owner: 'alice', sharing: 'personal', image: 'vercel/sandbox/universal' }, status: 'running', update: async args => updates.push(args) };
    let created;
    await ensureComputer(a, 'dev', { create: true, timeout: 1000 }, { get: async () => { throw new APIError(new Response('', { status: 404 }), { json: { error: { code: 'not_found' } } }); }, create: async args => { created = args; return computer; } });
    assert.deepEqual(created.keepLastSnapshots, { count: 1 });assert.equal(created.tags.owner,'alice');
    await ensureComputer(a, 'dev', { create: true, timeout: 1000 }, { get: async () => computer });
    assert.deepEqual(updates, [{ keepLastSnapshots: { count: 1 } }]);
    computer.keepLastSnapshots = { count: 1, deleteEvicted: false };
    await ensureComputer(a, 'dev', { create: true, timeout: 1000 }, { get: async () => computer });
    assert.equal(updates.length, 2);
  } finally { if (prior === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = prior; }
});

test('running computer reconnect skips lifetime selection, stopped computer requires it', async () => {
  const prior = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'fixture';
  try {
    const computer = { tags: { launcher: OWNER, owner: 'alice', sharing: 'personal' }, status: 'running', keepLastSnapshots: { count: 1 }, update: async () => {} };
    const timeout = async () => { throw new Error('duration needed'); };
    await ensureComputer(a, 'dev', { create: true, timeout }, { get: async () => computer });
    computer.status = 'stopped';
    await assert.rejects(ensureComputer(a, 'dev', { create: true, timeout }, { get: async () => computer }), /duration needed/);
  } finally { if (prior === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = prior; }
});
