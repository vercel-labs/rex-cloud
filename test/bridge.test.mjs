import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { bridgeServer, MARKER } from '../dist/bridge.js';

test('real Unix/WebSocket bridge preserves binary bytes, gets fresh access and closes on EOF', async t => {
  const dir = await mkdtemp('/tmp/rex-bridge-test-');
  const ws = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => ws.once('listening', resolve));
  const errors = []; let accessCount = 0;
  ws.on('connection', channel => {
    let started = false;
    channel.on('message', (bytes, binary) => {
      if (!started) { assert.equal(binary, false); assert.equal(JSON.parse(bytes).type, 'start'); started = true; channel.send(MARKER.subarray(0, 8)); channel.send(MARKER.subarray(8)); }
      else channel.send(bytes);
    });
  });
  const bridge = await bridgeServer({ socket: join(dir, 'rex.sock'), remoteSocket: '/tmp/remote.sock', cwd: '/tmp' }, e => errors.push(e), async () => { accessCount++; return { url: `ws://127.0.0.1:${ws.address().port}`, token: 'test-only' }; });
  t.after(async () => { await bridge.close(); for (const c of ws.clients) c.terminate(); await new Promise(r => ws.close(r)); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await stat(join(dir, 'rex.sock'))).mode & 0o777, 0o600);
  const payload = Buffer.alloc(512 * 1024); for (let i = 0; i < payload.length; i++) payload[i] = i % 256;
  for (let i = 0; i < 2; i++) {
    const received = await new Promise((resolve, reject) => {
      const socket = createConnection(join(dir, 'rex.sock')); const chunks = []; let size = 0;
      socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('roundtrip timed out')); });
      socket.on('error', reject); socket.on('connect', () => socket.write(payload));
      socket.on('data', data => { chunks.push(data); size += data.length; if (size === payload.length) { socket.end(); resolve(Buffer.concat(chunks)); } });
    });
    assert.deepEqual(received, payload);
  }
  assert.equal(accessCount, 2); assert.deepEqual(errors, []);
});
