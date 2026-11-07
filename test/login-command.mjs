import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LOGIN_ARGS } from '../dist/auth.js';

const root = await mkdtemp('/tmp/rex-login-command-');
const [packed] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', root], { encoding: 'utf8' }));
const fixture = join(root, packed.filename);
const result = spawnSync('npx', [...LOGIN_ARGS, '--help'], {
  encoding: 'utf8', timeout: 180000,
  env: { ...process.env, npm_config_package: fixture },
  stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(result.status, 0, result.stderr);
assert.match(result.stdout + result.stderr, /Sign in to your Vercel account/);
await rm(root, { recursive: true, force: true });
console.log('PASS: real Vercel login command resolves with inherited npx package context');
