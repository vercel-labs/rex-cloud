import test from 'node:test';
import assert from 'node:assert/strict';
import { commandHint } from '../dist/commands.js';

test('npx recovery commands remain runnable without a global install and preserve quoted paths', () => {
  const text = 'Next time: rex-cloud start dev\nStop: rex-cloud stop dev\nRun rex-cloud --help.';
  assert.equal(commandHint(text, {}), text);
  assert.match(commandHint(text, { npm_command: 'exec', npm_config_package: './vercel-labs-rex-cloud-0.1.tgz' }, '/tmp/a b'), /npx --yes --package '\/tmp\/a b\/vercel-labs-rex-cloud-0.1.tgz' rex-cloud stop dev/);
  assert.match(commandHint(text, { npm_command: 'exec', npm_config_package: '@vercel-labs/rex-cloud' }), /npx --yes @vercel-labs\/rex-cloud --help\./);
  assert.equal(commandHint('A rex-cloud project', { npm_command: 'exec' }), 'A rex-cloud project');
  assert.ok(commandHint(text, { npm_command: 'exec', npm_config_package: './vercel-labs-rex-cloud-0.1.tgz' }, "/tmp/it's").includes("it'\\''s"));
});

test('GitHub release recovery commands retain the download URL across directories', () => {
  const url = 'https://github.com/vercel-labs/rex-cloud/releases/download/v0.1.0-prototype.3/vercel-labs-rex-cloud-0.1.0-prototype.3.tgz';
  const text = 'Reconnect: rex-cloud start remote';
  assert.equal(commandHint(text, { npm_command: 'exec', npm_config_package: url }, '/tmp/another-directory'), `Reconnect: npx --yes --package '${url}' rex-cloud start remote`);
  assert.equal(commandHint(text, { npm_command: 'exec', npm_config_package: 'https://other.example/vercel-labs-rex-cloud-0.1.tgz' }), text);
});
