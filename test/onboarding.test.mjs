import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureUsageProject } from '../dist/setup.js';
import { teamLimit, chooseLifetime } from '../dist/lifetime.js';
import { parseCompatibility } from '../dist/desktop.js';

test('usage project is reused or created without a deployment, including concurrent setup', async () => {
  const prior = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'fixture';
  try {
    let created = false;
    const request = async (url, options) => {
      if (options.method === 'POST') {
        assert.equal(new URL(url).searchParams.get('teamId'), 'team_fixture');
        assert.deepEqual(JSON.parse(options.body), { name: 'rex-cloud', framework: null });
        created = true; return Response.json({ id: 'prj_usage' });
      }
      assert.equal(new URL(url).pathname, '/v9/projects/rex-cloud');
      return created ? Response.json({ id: 'prj_usage' }) : new Response('', { status: 404 });
    };
    assert.equal(await ensureUsageProject('team_fixture', request), 'prj_usage');
    assert.equal(await ensureUsageProject('team_fixture', request), 'prj_usage');
    let reads = 0;
    assert.equal(await ensureUsageProject('team_fixture', async (url, opts) => opts.method === 'POST' ? new Response('', { status: 409 }) : ++reads === 1 ? new Response('', { status: 404 }) : Response.json({ id: 'prj_usage' })), 'prj_usage');
    await assert.rejects(ensureUsageProject('team_fixture', async (url, opts) => opts.method === 'POST' ? new Response('', { status: 403 }) : new Response('', { status: 404 })), /administrator/);
    await assert.rejects(ensureUsageProject('team_fixture', async (url, opts) => { assert.notEqual(opts.method, 'POST'); return new Response('', { status: 403 }); }), /team access/);
  } finally { if (prior === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = prior; }
});
test('plan limits are explicit and unattended first use cannot silently choose45 minutes', async () => {
  const prior = process.env.VERCEL_TOKEN; process.env.VERCEL_TOKEN = 'fixture';
  try {
    assert.equal(await teamLimit('team_fixture', async () => Response.json({ billing: { plan: 'hobby' } })), 2700000);
    assert.equal(await teamLimit('team_fixture', async () => Response.json({ billing: { plan: 'pro' } })), 86400000);
    await assert.rejects(teamLimit('team_fixture', async () => Response.json({ billing: {} })), /could not be determined/);
    await assert.rejects(chooseLifetime('team_fixture', undefined, undefined, false), /Choose a duration/);
    await assert.rejects(chooseLifetime('team_fixture', '8h', undefined, false, async () => Response.json({ billing: { plan: 'hobby' } })), /exceeds your team plan/);
    assert.equal(await chooseLifetime('team_fixture', '45m', undefined, false, async () => Response.json({ billing: { plan: 'hobby' } })), '45m');
  } finally { if (prior === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = prior; }
});
test('Rex version checks use declared protocol compatibility and fail closed on unknown output', () => {
  assert.deepEqual(parseCompatibility('rex build\napi: revision 10 (supports 0 to 10)'), { min: 0, max: 10 });
  assert.throws(() => parseCompatibility('unknown version'), /compatibility/);
  assert.throws(() => parseCompatibility('api: revision2 (supports5 to2)'), /compatibility/);
});
