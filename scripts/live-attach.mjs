#!/usr/bin/env node
// Live test harness (not part of `npm test`). Attaches one "device" (a state root) to a named cloud computer the
// way `rex-cloud start` does, without the macOS-only desktop steps, so two Linux processes can stand in for two Macs.
//
//   node scripts/live-attach.mjs <name> <state-root> [--create --timeout 1h] [--team team_… --project prj_…]
//
// Prints JSON with the local socket. It never touches computers it did not create unless they carry rex-cloud's tags.
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { bootstrap, ensureComputer, summary } from '../dist/cloud.js';
import { ensureHelper, saveAccount } from '../dist/helper.js';
import { currentUser } from '../dist/identity.js';
import { duration, locations, privateDir, readJSON, stateRoot, validateName, validateScope, writeJSON } from '../dist/state.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { create: { type: 'boolean' }, timeout: { type: 'string' }, team: { type: 'string' }, project: { type: 'string' }, shared: { type: 'boolean' }, min: { type: 'string', default: '10' }, max: { type: 'string', default: '10' } } });
const name = validateName(positionals[0] ?? 'agenttest');
const root = stateRoot(positionals[1]);
await privateDir(root);
const saved = await readJSON(join(root, 'scope.json'));
const scope = validateScope({ teamId: values.team ?? saved?.teamId, projectId: values.project ?? saved?.projectId });
await writeJSON(join(root, 'scope.json'), scope);
const userId = await currentUser();
await saveAccount(root, userId);
const identity = { ...scope, userId, shared: !!values.shared };
const paths = locations(root, { ...identity, socketStyle: 'named' }, name);
const { sandbox, created, resumed } = await ensureComputer(identity, name, {
  create: !!values.create, timeout: duration(values.timeout ?? '1h'),
  onProgress: a => console.error(`${a} ${name}…`),
});
const remote = await bootstrap(sandbox, name, { min: Number(values.min), max: Number(values.max) });
const work = { ...identity, name, socketStyle: 'named', cloudName: sandbox.name, ...remote, socket: paths.socket, control: paths.control };
await writeJSON(paths.record, work);
const helper = await ensureHelper(root, work);
console.log(JSON.stringify({ ...summary(sandbox, name), created, resumed, ...remote, socket: paths.socket, control: paths.control, helperPid: helper.pid, stateRoot: root }));
