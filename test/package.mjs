import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = await mkdtemp('/tmp/rex-package-');
let disconnect, work, socketDir;
try {
  const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { encoding: 'utf8' }));
  const prefix = join(root, 'installed');
  execFileSync('npm', ['install', '--global', '--prefix', prefix, join(root, result[0].filename), '--offline', '--no-audit', '--no-fund'], { stdio: 'pipe' });
  assert.match(execFileSync(join(prefix, 'bin/rex-cloud'), ['--help'], { encoding: 'utf8' }), /rex-cloud start/);
  const dist = join(prefix, 'lib/node_modules/@vercel-labs/rex-cloud/dist');
  const { locations, privateDir, writeJSON } = await import(pathToFileURL(join(dist, 'state.js')));
  const { ensureHelper, control, disconnect: stop } = await import(pathToFileURL(join(dist, 'helper.js')));
  disconnect = stop;
  const state = join(root, 'state'); await privateDir(state);
  const scope = { teamId: 'team_fixture', projectId: 'prj_fixture', socketStyle: 'named' };
  const paths = locations(state, scope, 'package'); socketDir = paths.dir;
  work = { ...scope, name: 'package', cloudName: 'rex-cloud-package', socket: paths.socket, control: paths.control, remoteSocket: '/tmp/unused.sock', cwd: '/tmp', sessionId: 'fixture', blockId: 'fixture' };
  await writeJSON(paths.record, work);
  const helper = await ensureHelper(state, work);
  assert.equal((await control(paths.control)).pid, helper.pid);
  assert.equal((await ensureHelper(state, work)).pid, helper.pid);
  await disconnect(state, work);
  assert.equal(await control(paths.control), undefined);
  console.log('PASS: offline package install, CLI help, relocated helper startup, reuse and shutdown');
} finally {
  if (disconnect && work) await disconnect(join(root, 'state'), work);
  await rm(root, { recursive: true, force: true });
  if (socketDir) await rm(socketDir, { recursive: true, force: true });
}
