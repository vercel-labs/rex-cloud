import type { Sandbox } from '@vercel/sandbox';
import { APIError, apiCode, findComputer, type Backend } from './cloud.js';
import type { Identity } from './identity.js';
import { teamLimit } from './lifetime.js';
import { duration, type Scope } from './state.js';
import { label, stopTime as formatStop } from './desktop.js';

export const STOPPED = ['stopped', 'failed', 'aborted'];
export class ExtensionRejected extends Error {}
export interface ExtendOptions {
  by?: string; interactive: boolean;
  ask: (room: number) => Promise<string>;
  /** Command target as the user must type it, for hints (name plus --shared/--state-dir). Defaults to the name. */
  target?: string;
  log?: (message: string) => void;
  /** Called once the extension request is in flight, so an interrupt can tell the user to check status. */
  onRequest?: () => void;
  backend?: Backend; request?: typeof fetch;
  extend?: (session: ReturnType<Sandbox['currentSession']>, ms: number) => Promise<void>;
}
export interface Extension {
  before: Sandbox; after: Sandbox;
  /** Milliseconds requested. */ added: number;
  /** Milliseconds the stop time actually moved; larger than `added` if another client extended concurrently. */ observed: number;
  expiresBefore: number; expiresAfter: number;
}

/** Extend a running computer in place. Never creates, resumes or stops anything. */
export async function extendComputer(scope: Scope & Partial<Identity>, name: string, opts: ExtendOptions): Promise<Extension> {
  const backend = opts.backend;
  const target = opts.target ?? name;
  const before = await findComputer(scope, name, backend);
  if (STOPPED.includes(before.status)) throw new Error(`${name} is ${before.status}, so there is nothing to extend. Resume it with rex-cloud start ${target}. extend never starts a computer.`);
  if (before.status !== 'running') throw new Error(`${name} is ${before.status}. Wait for that to finish, then retry extend.`);
  const session = before.currentSession();
  const expiresBefore = before.expiresAt?.getTime();
  if (!expiresBefore) throw new Error(`Vercel did not report a stop time. Run rex-cloud status ${target} and retry.`);
  opts.log?.(`${name} stops: ${stopTime(expiresBefore)}`);
  const limit = await teamLimit(scope.teamId, opts.request);
  const room = limit - session.timeout;
  if (room < 60000) throw new ExtensionRejected(`${name} already has the longest run your plan allows (${label(limit)} per run). Save your work before it stops, or start a new run afterwards.`);
  let added: number;
  if (opts.by) added = duration(opts.by);
  else if (!opts.interactive) throw new Error(`Choose how much time to add with --by, for example --by 2h. ${name} can take up to ${label(room)} more.`);
  else {
    while (true) {
      const answer = (await opts.ask(room)).trim();
      try { added = duration(answer); } catch { opts.log?.('Enter a duration with m for minutes or h for hours.'); continue; }
      if (added <= room) break;
      opts.log?.(`Add up to ${label(room)}. Your plan allows ${label(limit)} per run.`);
    }
  }
  if (added > room) throw new ExtensionRejected(`Add up to ${label(room)}. Your plan allows ${label(limit)} per run, and ${name} is already set to ${label(session.timeout)}.`);
  const extend = opts.extend ?? ((s, ms) => s.extendTimeout(ms, { signal: AbortSignal.timeout(20000) }));
  let failure: unknown;
  opts.onRequest?.();
  try { await extend(session, added); }
  catch (e) {
    if (e instanceof APIError) {
      if (e.response.status === 401 || e.response.status === 403) throw e;
      // Observed 2026-11-07: HTTP 400 sandbox_timeout_invalid "extension would exceed maximum execution timeout".
      if (apiCode(e) === 'sandbox_timeout_invalid') throw new ExtensionRejected(`Vercel declined: the extension would exceed the longest run your plan allows. ${name} keeps its current stop time. Run rex-cloud status ${target} to see it.`);
      if (e.response.status === 400 || e.response.status === 429) throw new ExtensionRejected(`Vercel declined the extension (HTTP ${e.response.status}). ${name} keeps its current stop time. Run rex-cloud status ${target} to see it.`);
    }
    // Anything else (network, timeout, or the computer stopping underneath us: 404/410/422) is settled by re-reading.
    failure = e;
  }
  // Re-read the authoritative deadline. After an ambiguous failure this decides whether time was added, so it is never added twice.
  const after = await findComputer(scope, name, backend);
  const expiresAfter = after.expiresAt?.getTime();
  const sameSession = after.status === 'running' && after.currentSession().sessionId === session.sessionId;
  if (!sameSession) throw new Error(`${name} changed while extending (now ${after.status}). Run rex-cloud status ${target} and retry when it is running.`);
  if (expiresAfter === undefined) throw new Error(`Vercel did not report a stop time after extending. Run rex-cloud status ${target}.`);
  const observed = expiresAfter - expiresBefore;
  if (observed < 1000) throw new Error(`${name} was not extended${failure ? '; the request did not complete' : ''}. Its stop time is unchanged: ${stopTime(expiresBefore)}. Check your connection and retry.`);
  if (observed < added - 1000) throw new Error(`${name} now stops at ${stopTime(expiresAfter)}, less than the requested ${label(added)}. Run rex-cloud status ${target} before extending again.`);
  return { before, after, added, observed, expiresBefore, expiresAfter };
}
export function stopTime(ms: number, now = Date.now()): string { return formatStop(new Date(ms).toISOString(), now); }
