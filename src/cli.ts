#!/usr/bin/env node
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { authenticate, login } from './auth.js';
import { agentInfo, bootstrap, deleteComputer, ensureComputer, findComputer, friendlyError, summary } from './cloud.js';
import { control, disconnect, ensureHelper, saveAccount } from './helper.js';
import { commandHint } from './commands.js';
import { configure } from './setup.js';
import { installedRex, openDesktop, attached, stopTime, rexCompatibility, registerHost, unregisterHost, label } from './desktop.js';
import { currentUser, type Identity } from './identity.js';
import { chooseLifetime } from './lifetime.js';
import { extendComputer } from './extend.js';
import { Prompt } from './prompt.js';
import { duration, locations, privateDir, readJSON, stateRoot, validateName, validateScope, withLock, writeJSON, type Scope, type Workspace } from './state.js';

const exec = promisify(execFile);
const print = (message: string) => console.log(commandHint(message));
const warn = (message: string) => console.error(commandHint(message));
const HELP = `rex-cloud · cloud terminals for Rex (prototype)

  rex-cloud start [name] [--timeout 45m] [--image VCR_REFERENCE] [--shared] [--label "remote 1"]
  rex-cloud status [name]
  rex-cloud extend [name] [--by 2h]
  rex-cloud stop [name]
  rex-cloud restart [name] [--timeout 45m] [--label "remote 1"]
  rex-cloud delete [name] --yes
  rex-cloud disconnect [name]
  rex-cloud setup [--team team_… --project prj_…]
  rex-cloud login

Run start from a local Mac terminal, including This Mac in Rex.
The default name is dev. start creates or resumes the same cloud computer.
On first use, reuse your Vercel login, linked project, or current CLI team.
Without a project link, a rex-cloud project tracks Sandbox usage. Choose a team only if needed.
start lists the computer as a host in Rex's sidebar; --label picks that sidebar name (default: the computer name).
Renaming the host in Rex sticks. If it is not listed, add the printed socket via Add Remote Host.
The cloud terminal starts fresh. Existing Mac sessions stay on your Mac.
Computers belong to your Vercel user by default. --shared explicitly joins a team computer.
Use --shared with every command for shared computers, including earlier prototype computers.

Aliases: up works like start; open only reopens an existing computer.
Options: --team, --project, --state-dir, --no-open, --json, --help
--no-open keeps the Mac app in the background. --json also disables app opening.
Choose a duration on first use. Hobby allows 45m, paid plans up to 24h.
Your duration choice is saved. --timeout overrides it for future starts.
Reconnecting keeps the current stop time. extend adds time to a running computer in place;
terminals, agents and connections continue. Pro and Enterprise allow 24h per run.
Lifecycle:
  stop     ends running processes; files and the saved disk (snapshot) are kept. start boots from it.
  restart  stop, then start: fresh processes, same files. Use it when something in the computer is stuck.
  delete   permanently removes the computer, its snapshots, this Mac's helper and the host it registered. Needs --yes.
disconnect only closes this Mac's bridge; the computer keeps running.
Agents: rex-cloud status <name> --json gives sandbox, teamId and projectId for the Sandbox CLI, e.g.
  sandbox exec --scope <teamId> --project <projectId> <sandbox> -- npm test   (also sandbox cp)
Vercel login does not sign into coding agents or Git services.
`;

let interruptedComputer: string | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  warn(interruptedComputer
    ? `\nInterrupted. ${interruptedComputer} may still be running, possibly with a changed stop time. Check rex-cloud status ${interruptedComputer}, or stop it with rex-cloud stop ${interruptedComputer}.`
    : '\nCancelled.');
  process.exit(signal === 'SIGINT' ? 130 : 143);
});

async function main() {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, team: { type: 'string' }, project: { type: 'string' },
    'state-dir': { type: 'string' }, image: { type: 'string' }, timeout: { type: 'string' }, 'no-open': { type: 'boolean' }, shared: { type: 'boolean' }, by: { type: 'string' }, label: { type: 'string' }, yes: { type: 'boolean' },
  } });
  const command = positionals[0];
  if (values.help || !command) { print(HELP); return; }
  if (!['setup', 'login', 'start', 'up', 'open', 'status', 'extend', 'stop', 'restart', 'delete', 'disconnect'].includes(command)) throw new Error(`Unknown command: ${command}. Run rex-cloud --help.`);
  if (values.by && command !== 'extend') throw new Error('--by is available with extend, for example rex-cloud extend remote --by 2h.');
  if (values.by) try { duration(values.by); } catch { throw new Error('Give --by as minutes or hours, for example --by 30m or --by 2h (up to 24h).'); }
  if (positionals.length > 2 || (['setup', 'login'].includes(command) && positionals.length > 1)) throw new Error('Unexpected extra arguments. Run rex-cloud --help.');
  if (values.yes && command !== 'delete') throw new Error('--yes is only used with delete.');
  // Checked before any Vercel call so a mistaken delete costs nothing.
  if (command === 'delete' && !values.yes) throw new Error(`delete permanently removes ${positionals[1] ?? 'dev'}: its files, saved disk (snapshots), this Mac's helper and its Rex host.${values.shared ? ' Other members of this project lose it too.' : ''} To keep the files and only stop compute, use rex-cloud stop. To confirm, add --yes.`);
  const starting = ['start', 'up', 'open', 'restart'].includes(command);
  if (values.image && !['start', 'up'].includes(command)) throw new Error('--image is available with start. Use a new computer name to change images.');
  if (values.timeout && !starting) throw new Error('--timeout is available with start, up, open and restart.');
  if (values.label !== undefined && !starting) throw new Error('--label is available with start, up, open and restart.');
  if (values.label !== undefined && !values.label.trim()) throw new Error('Give --label a name to show in Rex, for example --label "remote 1".');
  if (command === 'login') { await login(); return; }
  const root = stateRoot(values['state-dir']);
  await privateDir(root);
  const saved = await readJSON<Scope>(join(root, 'scope.json'));
  const interactive = Boolean(process.stdin.isTTY && !values.json);
  const useSaved = command !== 'setup';
  const requested = {
    teamId: values.team ?? (useSaved ? saved?.teamId : undefined),
    projectId: values.project ?? (useSaved && (!values.team || values.team === saved?.teamId) ? saved?.projectId : undefined),
  };
  const configured = await configure(root, requested, interactive && (starting || command === 'setup'), { discover: ['start', 'up', 'setup'].includes(command) });
  if (command === 'setup' || !requested.teamId || !requested.projectId) await withLock(root, 'scope', () => writeJSON(join(root, 'scope.json'), configured));
  if (command === 'setup') {
    print(values.json ? JSON.stringify({ configured: true, ...configured }) : 'Vercel account saved. From a local Mac terminal, run: rex-cloud start');
    return;
  }
  const name = validateName(positionals[1] ?? 'dev');
  const hostLabel = values.label?.trim() ?? name;
  const cachedAccount = await readJSON<{ userId: string }>(join(root, 'account.json'));
  if (command !== 'disconnect') await authenticate(interactive);
  const userId = command === 'disconnect' ? cachedAccount?.userId : await currentUser();
  if (!userId && !values.shared) throw new Error('No saved personal account. Run start once, or use disconnect --shared for an earlier prototype computer.');
  if (command !== 'disconnect' && await saveAccount(root, userId!) && !values.json) warn('Disconnected the previous account on this Mac. Its cloud computers keep their stop times.');
  const scope: Identity = { ...configured, userId: userId ?? 'offline', shared: !!values.shared };
  const stateFlag = values['state-dir'] || process.env.REX_CLOUD_STATE_DIR ? ` --state-dir '${root.replaceAll("'", "'\\''")}'` : '';
  const target = `${name}${scope.shared ? ' --shared' : ''}${stateFlag}`;
  const previous = await readJSON<Workspace>(locations(root, scope, name).record);
  const socketStyle = previous ? previous.socketStyle : 'named' as const;
  const paths = locations(root, { ...scope, socketStyle }, name);
  const log = (message: string) => { if (!values.json) warn(message); };
  if (starting && scope.shared) log('Shared computer: other members with access to this Vercel project can use the same terminals.');
  await withLock(root, paths.key, async () => {
    if (command === 'disconnect') {
      const work = await readJSON<Workspace>(paths.record);
      if (work) await disconnect(root, work);
      print(values.json ? JSON.stringify({ name, disconnected: true }) : `Disconnected this Mac from ${name}. Cloud work continues until its stop time.`);
      return;
    }
    await authenticate(interactive);
    if (command === 'status') {
      const s = await findComputer(scope, name), helper = await control(paths.control);
      const rexAttached = s.status === 'running' && helper ? await attached(paths.socket) : false;
      const data = { ...summary(s, name), ...agentInfo(scope, s), socket: paths.socket, localConnected: !!helper, rexAttached, connectionError: helper?.lastError };
      print(values.json ? JSON.stringify(data) : `${name}: ${data.status}\nStops: ${stopTime(data.expiresAt)}\nThis Mac: ${helper ? 'connection helper running' : 'disconnected'}\nRex: ${rexAttached === true ? 'connected to the cloud computer' : rexAttached === false ? 'not connected' : 'connection could not be checked'}${helper?.lastError ? `\nConnection error: ${friendlyError(new Error(helper.lastError))}` : ''}\n${s.status === 'running' ? `Add time: rex-cloud extend ${target}\nStop compute: rex-cloud stop ${target}\nRun a command: sandbox exec --scope ${scope.teamId} --project ${scope.projectId} ${s.name} -- <command>` : `Resume: rex-cloud start ${target}`}`);
      return;
    }
    if (command === 'delete') {
      const work = await readJSON<Workspace>(paths.record);
      const disconnectMac = async () => { if (work) await disconnect(root, work); };
      const result = await deleteComputer(scope, name, undefined, { onStop: () => log(`Stopping ${name}…`), beforeDelete: disconnectMac });
      if (!result.found) await disconnectMac();
      const found = result.found, cloudName = result.found ? result.cloudName : undefined;
      const host = await unregisterHost(paths.socket);
      const files = [paths.record, join(root, `${paths.key}.preferences.json`)];
      const unlinkFailed = await Promise.all(files.map(file => unlink(file).then(() => false, (e: NodeJS.ErrnoException) => e.code !== 'ENOENT')));
      const localRecord = unlinkFailed.some(Boolean) ? 'failed' : 'removed';
      const data = { name, deleted: found, cloudName, snapshots: found ? 'deleting' : 'none', host, localRecord };
      print(values.json ? JSON.stringify(data) : [
        found ? `Deleted ${name}. Its files and saved disk are being removed and cannot be recovered.` : `${name} was not found in Vercel. Removed this Mac's leftover records for it.`,
        // The Rex app re-adds hosts it holds in its own list (every host added in Settings → Remote Hosts), so removing the
        // registered entry is not enough to clear the sidebar; always say where to finish.
        `If ${name} is still listed in Rex, remove it in Settings → Remote Hosts.`,
        localRecord === 'failed' ? `Could not remove this Mac's records for ${name} in ${root}.` : '',
      ].filter(Boolean).join('\n'));
      return;
    }
    if (command === 'extend') {
      const prompt = new Prompt();
      try {
        const result = await extendComputer(scope, name, {
          by: values.by, interactive, log, target,
          ask: room => prompt.ask(`Add how much time? (up to ${label(room)}; m = minutes, h = hours): `),
          onRequest: () => { interruptedComputer = target; },
        });
        interruptedComputer = undefined;
        const data = { ...summary(result.after, name), expiresAt: new Date(result.expiresAfter).toISOString(), added: result.added, observed: result.observed, previousExpiresAt: new Date(result.expiresBefore).toISOString() };
        const moved = result.observed > result.added + 1000 ? `The stop time moved by ${label(result.observed)}; another connection extended ${name} as well.` : `Added ${label(result.added)} to ${name}.`;
        print(values.json ? JSON.stringify(data) : `${moved} Nothing was interrupted.\nStops: ${stopTime(data.expiresAt)}`);
      } finally { prompt.close(); }
      return;
    }
    if (command === 'stop') {
      const s = await findComputer(scope, name);
      if (s.status === 'running') { log(`Stopping ${name} and saving its disk…`); await s.stop(); }
      else if (!['stopped', 'failed', 'aborted'].includes(s.status)) throw new Error(`Computer is ${s.status}. Retry stop when its transition finishes.`);
      const work = await readJSON<Workspace>(paths.record);
      if (work) await disconnect(root, work);
      const current = await findComputer(scope, name);
      print(values.json ? JSON.stringify(summary(current, name)) : current.status === 'stopped'
        ? `${name} stopped. Files are saved. Running processes have ended.\nResume with: rex-cloud start ${target}`
        : `${name}: ${current.status}. A clean stop and saved disk could not be confirmed.\nCheck recovery state with: rex-cloud status ${target}`);
      if (current.status !== 'stopped') process.exitCode = 1;
      return;
    }
    try { await exec('rex', ['version'], { timeout: 5000 }); }
    catch { throw new Error('Install the current Rex app and its CLI first, then retry. The rex command must be on your PATH.'); }
    const app = await installedRex();
    const compatibility = await rexCompatibility();
    if (command === 'restart') {
      const s = await findComputer(scope, name);
      if (s.status === 'running') { log(`Stopping ${name} and saving its disk…`); await s.stop(); }
      else if (!['stopped', 'failed', 'aborted'].includes(s.status)) throw new Error(`Computer is ${s.status}. Retry restart when its transition finishes.`);
      const work = await readJSON<Workspace>(paths.record);
      if (work) await disconnect(root, work);
    }
    const preferencePath = join(root, `${paths.key}.preferences.json`);
    const preference = await readJSON<{ timeout: string }>(preferencePath);
    const explicitTimeout = values.timeout ? await chooseLifetime(scope.teamId, values.timeout, undefined, interactive) : undefined;
    const timeout = async () => {
      const chosen = explicitTimeout ?? await chooseLifetime(scope.teamId, undefined, preference?.timeout, interactive);
      await writeJSON(preferencePath, { timeout: chosen });
      return duration(chosen);
    };
    interruptedComputer = target;
    const { sandbox: s, created, resumed } = await ensureComputer(scope, name, {
      create: !['open', 'restart'].includes(command), image: values.image, timeout,
      onProgress: action => log(action === 'creating' ? `Creating ${name}…` : action === 'resuming' ? `Waking ${name}…` : `Connecting to ${name}…`),
    });
    if (explicitTimeout) await writeJSON(preferencePath, { timeout: explicitTimeout });
    try {
      const remote = await bootstrap(s, name, compatibility);
      const work: Workspace = { ...scope, name, socketStyle, cloudName: s.name, ...remote, socket: paths.socket, control: paths.control };
      await writeJSON(paths.record, work);
      await ensureHelper(root, work);
      await exec('rex', ['--autostart=false', '--timeout', '20s', '-S', paths.socket, 'server', 'status', '--json'], { timeout: 25000, maxBuffer: 1024 * 1024 });
      const data = { ...summary(s, name), ...remote, socket: paths.socket, created };
      // rexAttached tells an agent whether the Rex app actually shows this computer. Observed with Rex 0.1.0 (1853): the app
      // lists only hosts in its own list, so a host added with `rex hosts add` stays hidden until someone adds the socket in
      // Add Remote Host. An agent should pass socket + hostLabel to the user when rexAttached is false.
      if (values.json) { const host = await registerHost(name, paths.socket, undefined, undefined, hostLabel); print(JSON.stringify({ ...data, host, hostLabel, rexAttached: await attached(paths.socket) ?? false })); return; }
      if (!values['no-open']) {
        try {
          const foreground = await openDesktop(app);
          if (!foreground) log(`Open ${app.path} from Applications.`);
        } catch { log(`Could not bring Rex forward. Open ${app.path} from Applications.`); }
      }
      // Register after the app is up so its local server answers `rex hosts`; failures only change the printed guidance.
      const host = await registerHost(name, paths.socket, undefined, undefined, hostLabel);
      const connected = await attached(paths.socket);
      print(`\n${name} ${resumed ? 'resumed' : 'is ready'}.`);
      if (resumed) print('Files restored. Terminals start as fresh shells.');
      if (connected) {
        print(`Select ${hostLabel} in Rex to continue.`);
        if (host === 'outdated') print(`Your Mac's Rex server is running a build that does not accept socket hosts, so ${hostLabel} was not added to the sidebar. Check that Rex is up to date, then relaunch its server with rex server stop (this ends programs running in your local Mac sessions; the cloud computer is unaffected) and run rex-cloud start ${target} again. Until then connect via Add Remote Host with:\n\n${paths.socket}\n`);
        else if (host === 'conflict') print(`A different host is already named ${hostLabel} in Rex, so it was left unchanged. Pick another sidebar name with --label.`);
      }
      else if (['added', 'updated', 'current'].includes(host)) print(`If ${hostLabel} is not in Rex's sidebar, add it once on this Mac: in Rex's Settings → Remote Hosts choose Add Remote Host…, paste this path as the Host URL and enter ${hostLabel} as the Host name:\n\n${paths.socket}\n\nThe path stays the same for this computer, so you only do this once.`);
      else {
        if (host === 'outdated') print(`Your Mac's Rex server is running a build that does not accept socket hosts, so ${hostLabel} could not be added to the sidebar. Check that Rex is up to date, then relaunch its server with rex server stop (this ends programs running in your local Mac sessions; the cloud computer is unaffected) and run rex-cloud start ${target} again.`);
        print(`Connect once on this Mac:\n  1. In ${app.path}, choose Add Remote Host.\n  2. Paste this path and select the Connect to… result:\n\n${paths.socket}\n\n  3. Select ${hostLabel}, then its bash terminal.${host === 'conflict' ? `\nA different host is already named ${hostLabel} in Rex, so it was left unchanged. Pick another sidebar name with --label.` : host === 'outdated' ? '' : '\nIf Rex rejects the path, check that you opened the Applications copy.'}`);
      }
      print(`Stops: ${stopTime(data.expiresAt)}`);
      if (created || !connected) print(`\nFrom your Mac:\n  Reconnect: rex-cloud start ${target}\n  Add time: rex-cloud extend ${target}\n  Stop: rex-cloud stop ${target}`);
    } catch (e) {
      throw new Error(`Setup did not complete. ${name} may still be running until ${s.expiresAt?.toISOString() ?? 'its timeout'}. Run rex-cloud stop ${target} to stop compute, or open to retry. ${friendlyError(e)}`);
    }
  });
  interruptedComputer = undefined;
}
main().catch(e => { warn(`rex-cloud: ${friendlyError(e)}`); process.exitCode = 1; });
