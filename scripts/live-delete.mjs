#!/usr/bin/env node
// Live test cleanup (not part of `npm test`). Disconnects the local helper, stops the computer if it is running and
// deletes the named sandbox and its snapshots. Only computers created by rex-cloud for the current user are touched.
//
//   node scripts/live-delete.mjs <name> <state-root> [--shared]
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { findComputer } from '../dist/cloud.js';
import { disconnect } from '../dist/helper.js';
import { currentUser } from '../dist/identity.js';
import { locations, readJSON, stateRoot, validateName, validateScope } from '../dist/state.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { shared: { type: 'boolean' } } });
const name = validateName(positionals[0]);
const root = stateRoot(positionals[1]);
const scope = validateScope(await readJSON(join(root, 'scope.json')));
const identity = { ...scope, userId: await currentUser(), shared: !!values.shared };
const paths = locations(root, { ...identity, socketStyle: 'named' }, name);
const work = await readJSON(paths.record);
if (work) await disconnect(root, work);
const s = await findComputer(identity, name);
if (s.status === 'running') { console.error(`stopping ${s.name}…`); await s.stop(); }
await s.delete({ deleteOrphanSnapshots: true }); // without it the snapshot is kept until it expires
console.log(JSON.stringify({ deleted: s.name, lastStatus: s.status }));
