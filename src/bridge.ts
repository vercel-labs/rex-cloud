import { createServer, type Socket } from 'node:net';
import { chmod, readFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { findComputer, friendlyError } from './cloud.js';
import type { Workspace } from './state.js';
import { currentUser } from './identity.js';

export const MARKER = Buffer.from('REX_CLOUD_RELAY_READY\n');
export class Handshake {
  private buffer = Buffer.alloc(0);
  ready = false;
  push(data: Buffer): Buffer | undefined {
    if (this.ready) return data;
    this.buffer = Buffer.concat([this.buffer, data]);
    const offset = this.buffer.indexOf(MARKER);
    if (offset < 0) {
      if (this.buffer.length > 4096) throw new Error('Remote bridge handshake exceeded its limit.');
      return;
    }
    if (offset > 4096) throw new Error('Unexpected remote bridge output.');
    this.ready = true;
    const rest = this.buffer.subarray(offset + MARKER.length);
    this.buffer = Buffer.alloc(0);
    return rest;
  }
}
export type Access = () => Promise<{ url: string; token: string }>;
export async function bridgeServer(work: Workspace, error: (message: string) => void, access?: Access) {
  const relay = await readFile(new URL('../assets/relay.py', import.meta.url), 'utf8');
  const clients = new Set<Socket>();
  const channels = new Set<WebSocket>();
  const getAccess: Access = access ?? (async () => {
    if (!work.shared && await currentUser() !== work.userId) throw new Error('Your Vercel account changed. Run start from this Mac to open your own computer.');
    const s = await findComputer(work, work.name);
    if (s.status !== 'running') throw new Error(`Computer is ${s.status}. Run rex-cloud start ${work.name}${work.shared ? ' --shared' : ''} to resume it.`);
    return s.currentSession().openInteractive({ signal: AbortSignal.timeout(15000) });
  });
  const server = createServer(socket => {
    clients.add(socket); socket.pause();
    let ws: WebSocket | undefined;
    const timer = setTimeout(() => socket.destroy(), 20000);
    const handshake = new Handshake();
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); clients.delete(socket); ws?.terminate(); });
    void (async () => {
      try {
        const auth = await getAccess();
        if (socket.destroyed) return;
        const url = new URL(auth.url);
        if (url.protocol !== 'wss:' && !(access && url.hostname === '127.0.0.1')) throw new Error('Expected an encrypted Sandbox connection.');
        url.searchParams.set('token', auth.token);
        ws = new WebSocket(url, { maxPayload: 4 * 1024 * 1024, handshakeTimeout: 15000, perMessageDeflate: false });
        channels.add(ws);
        ws.on('error', () => { error('Cloud connection failed. Check rex-cloud status, then reopen.'); socket.destroy(); });
        ws.on('close', () => { if (ws) channels.delete(ws); socket.destroy(); });
        ws.on('open', () => ws?.send(JSON.stringify({ type: 'start', command: 'python3', args: ['-u', '-c', relay, work.remoteSocket], env: [], cwd: work.cwd, cols: 80, rows: 24 })));
        ws.on('message', (raw, binary) => {
          if (!binary) return;
          try {
            const wasReady = handshake.ready;
            const data = handshake.push(Buffer.from(raw as Buffer));
            if (data === undefined) return;
            clearTimeout(timer);
            if (data.length && !socket.write(data)) ws?.pause();
            if (!wasReady) socket.resume();
          } catch { error('Cloud bridge handshake failed.'); socket.destroy(); }
        });
        socket.on('drain', () => ws?.resume());
        socket.on('data', data => { socket.pause(); ws?.send(data, e => { if (e) socket.destroy(); else socket.resume(); }); });
        socket.on('end', () => socket.destroy());
      } catch (e) { error(friendlyError(e)); socket.destroy(); }
    })();
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(work.socket, resolve); });
  await chmod(work.socket, 0o600);
  return { server, close: async () => {
    for (const socket of clients) socket.destroy();
    for (const ws of channels) ws.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
