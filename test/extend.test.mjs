import test from 'node:test';
import assert from 'node:assert/strict';
import { APIError, OWNER } from '../dist/cloud.js';
import { extendComputer, stopTime } from '../dist/extend.js';
import { label } from '../dist/desktop.js';

const scope = { teamId: 'team_fixture', projectId: 'prj_fixture', userId: 'user_fixture', shared: false };
// extend reads credentials before touching the backend, so give it a fixture token the way the other suites do.
// Without this the suite only passes on a machine that is signed into Vercel, which CI is not.
const savedToken = process.env.VERCEL_TOKEN;
test.before(() => { process.env.VERCEL_TOKEN = 'test-only'; });
test.after(() => { if (savedToken === undefined) delete process.env.VERCEL_TOKEN; else process.env.VERCEL_TOKEN = savedToken; });
const HOUR = 3600000;
const pro = async () => Response.json({ billing: { plan: 'pro' } });
function error(status, code = 'bad_request') { return new APIError(new Response('', { status }), { json: { error: { code } }, message: 'sensitive https://example.invalid/?token=secret' }); }
/** A fake named computer: one session whose deadline moves only when extendTimeout succeeds. */
function computer(opts = {}) {
  const state = { status: opts.status ?? 'running', timeout: opts.timeout ?? 4 * HOUR, startedAt: Date.parse('2026-11-07T17:10:22.915Z'), sessionId: opts.sessionId ?? 'sbx_original', extended: [], gets: 0 };
  const snapshot = () => {
    const seen = { status: state.status, timeout: state.timeout, sessionId: state.sessionId };
    return {
      status: seen.status, tags: { launcher: OWNER, image: 'vercel/sandbox/universal', owner: scope.userId, sharing: 'personal' },
      // Like the real SDK, the deadline getter reads the live session, which extendTimeout mutates.
      get expiresAt() { return seen.status === 'running' ? new Date(state.startedAt + state.timeout) : undefined; },
      currentSession: () => ({ sessionId: seen.sessionId, timeout: seen.timeout, extendTimeout: async ms => { state.extended.push(ms); if (opts.fail) { const f = opts.fail; opts.fail = undefined; if (f.applies) state.timeout += ms; throw f.error; } state.timeout += ms; } }),
      update: async () => assert.fail('extend must not update the computer'), stop: async () => assert.fail('extend must not stop'),
    };
  };
  const backend = { get: async params => { state.gets++; assert.equal(params.resume, false, 'extend must never resume'); if (opts.afterGet) opts.afterGet(state, state.gets); return snapshot(); }, create: async () => assert.fail('extend must not create') };
  return { state, backend };
}
const run = (c, extra = {}) => extendComputer(scope, 'dev', { interactive: false, ask: async () => assert.fail('no prompt expected'), backend: c.backend, request: pro, ...extra });

test('extend adds time in place and reports only the re-read deadline on the same session', async () => {
  const c = computer();
  const result = await run(c, { by: '2h' });
  assert.deepEqual(c.state.extended, [2 * HOUR]);
  assert.equal(result.added, 2 * HOUR); assert.equal(result.observed, 2 * HOUR);
  assert.equal(result.expiresAfter - result.expiresBefore, 2 * HOUR);
  assert.equal(result.after.expiresAt.getTime(), result.expiresAfter);
  assert.equal(c.state.gets, 2, 'reads before and after');
});
test('a stopped or transitioning computer is never resumed, created or extended', async () => {
  for (const status of ['stopped', 'failed', 'aborted']) {
    const c = computer({ status });
    await assert.rejects(run(c, { by: '1h' }), /rex-cloud start dev[^]*never starts/);
    assert.deepEqual(c.state.extended, []);
  }
  const c = computer({ status: 'stopping' });
  await assert.rejects(run(c, { by: '1h' }), /stopping.*retry/);
});
test('plan limits are checked before calling Vercel and explained with the remaining headroom', async () => {
  const c = computer({ timeout: 23 * HOUR });
  await assert.rejects(run(c, { by: '2h' }), /Add up to 1h\. Your plan allows 24h per run/);
  assert.deepEqual(c.state.extended, []);
  await assert.rejects(run(computer({ timeout: 24 * HOUR }), { by: '1m' }), /longest run your plan allows \(24h per run\)/);
  await assert.rejects(run(computer({ timeout: 30 * 60000 }), { by: '1h', request: async () => Response.json({ billing: { plan: 'hobby' } }) }), /Add up to 15m\. Your plan allows 45m/);
  await assert.rejects(run(computer(), { by: '25h' }), /1m to 24h/);
  await assert.rejects(run(computer(), {}), /--by, for example --by 2h\. dev can take up to 20h more/);
});
test('interactive prompt re-asks on invalid or oversized answers and respects the headroom', async () => {
  const c = computer({ timeout: 20 * HOUR });
  const answers = ['soon', '5h', '3h'], rooms = [], logs = [];
  const result = await run(c, { interactive: true, ask: async room => { rooms.push(room); return answers.shift(); }, log: m => logs.push(m) });
  assert.equal(result.added, 3 * HOUR); assert.deepEqual(rooms, [4 * HOUR, 4 * HOUR, 4 * HOUR]);
  assert.match(logs.join('\n'), /m for minutes or h for hours/); assert.match(logs.join('\n'), /Add up to 4h/);
});
test('explicit Vercel rejections are explained without retrying; auth errors surface as auth errors', async () => {
  const c = computer({ fail: { error: error(400, 'timeout_limit_exceeded') } });
  await assert.rejects(run(c, { by: '1h' }), e => /declined the extension \(HTTP 400\)/.test(e.message) && !/secret|token=/.test(e.message));
  assert.equal(c.state.extended.length, 1); assert.equal(c.state.gets, 1, 'no second read needed after an explicit rejection');
  // Vercel's actual over-cap answer, observed live: HTTP 400 sandbox_timeout_invalid.
  await assert.rejects(run(computer({ fail: { error: error(400, 'sandbox_timeout_invalid') } }), { by: '1h' }), /exceed the longest run your plan allows[^]*keeps its current stop time/);
  await assert.rejects(run(computer({ fail: { error: error(403, 'forbidden') } }), { by: '1h' }), e => e instanceof APIError && e.response.status === 403);
});
test('ambiguous failures are resolved by re-reading the deadline, so time is never added twice', async () => {
  const applied = computer({ fail: { error: new Error('socket hang up'), applies: true } });
  const result = await run(applied, { by: '1h' });
  assert.equal(result.observed, HOUR); assert.equal(applied.state.extended.length, 1, 'no blind retry');
  const lost = computer({ fail: { error: new Error('socket hang up'), applies: false } });
  await assert.rejects(run(lost, { by: '1h' }), /was not extended; the request did not complete[^]*unchanged/);
  assert.equal(lost.state.extended.length, 1);
});
test('a computer that stops mid-call is reported as stopped, not as a declined extension', async () => {
  for (const status of [410, 422, 404]) {
    const c = computer({ fail: { error: error(status, 'sandbox_stopped') }, afterGet: (state, n) => { if (n === 2) state.status = 'stopped'; } });
    await assert.rejects(run(c, { by: '1h' }), /changed while extending \(now stopped\)/);
    assert.equal(c.state.gets, 2, 'the re-read decides');
  }
  const concurrent = computer({ afterGet: (state, n) => { if (n === 2) state.timeout += HOUR; } });
  const result = await run(concurrent, { by: '1h' });
  assert.equal(result.added, HOUR); assert.equal(result.observed, 2 * HOUR, 'reports what actually moved');
  await assert.rejects(run(computer({ status: 'stopped' }), { by: '1h', target: "dev --state-dir '/x'" }), /start dev --state-dir '\/x'\./, 'hints carry the full command target');
});
test('a session that changes underneath extend is reported instead of being trusted', async () => {
  const replaced = computer({ afterGet: (state, n) => { if (n === 2) state.sessionId = 'sbx_other'; } });
  await assert.rejects(run(replaced, { by: '1h' }), /changed while extending/);
  const stopped = computer({ afterGet: (state, n) => { if (n === 2) state.status = 'stopped'; } });
  await assert.rejects(run(stopped, { by: '1h' }), /changed while extending \(now stopped\)/);
});
test('prompt rejects with Cancelled when input closes and still returns normal answers', async () => {
  const { Prompt } = await import('../dist/prompt.js');
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough(), output = new PassThrough();
  const prompt = new Prompt(input, output);
  const first = prompt.ask('How much? ');
  input.write('2h\n');
  assert.equal(await first, '2h');
  const second = prompt.ask('Again? ');
  input.end();
  await assert.rejects(second, /Cancelled/);
  await assert.rejects(prompt.ask('Closed? '), /Cancelled/);
  prompt.close();
});
test('durations and stop times read naturally and include the timezone', () => {
  assert.equal(label(2 * HOUR), '2h'); assert.equal(label(90 * 60000), '1h 30m'); assert.equal(label(45 * 60000), '45m');
  const text = stopTime(Date.parse('2026-11-08T13:10:22Z'), Date.parse('2026-11-07T17:40:22Z'));
  assert.match(text, /19h 30m remaining/); assert.match(text, /\b(UTC|GMT|[A-Z]{2,5}|GMT[+-]\d+)\b/);
});
