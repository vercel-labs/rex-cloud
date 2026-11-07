# TESTING

Evidence log for `feat/multi-client-extend`. Times are UTC. "Live" = real Vercel Sandbox + real Rex server; "unit" = mocked backend; "manual" = still to be done on physical Macs.

## Protected resources (never touched)
- Live `remote` computer: `rex-cloud-ba26fe7defb02116-remote`, session `sbx_Uy31DDvuAPefwRUBXVYVIeVyNTRJ`, Rex socket `/vercel/.local/state/rex/run/server.sock` (this agent runs inside it). Deadline left at 2026-11-08 13:10:22 UTC.

## Resources created by this agent (all deleted 2026-11-07 20:40 UTC — see Cleanup)
| Resource | ID | Created | Notes |
| --- | --- | --- | --- |
| Named sandbox `agenttest` (personal) | `rex-cloud-ba26fe7defb02116-agenttest`, session `sbx_RIBGcLsM3wyQ0jSOY0g3tWTki5Fd` | 2026-11-07 17:51 | team `team_TtmJZYmD3tcLBLqWOhoVawd1`, project `prj_IbmALXBur5uokFthCQ1j1hUkJrW8`, timeout 1h (expires 18:51:53) |
| Local state roots | `/tmp/claude-1000/rc-a`, `/tmp/claude-1000/rc-b`, `/tmp/claude-1000/rc-c` | 17:51 | "device A" and "device B" helpers; rc-c = agenttest2 |
| Isolated local Rex server | `XDG_STATE_HOME=/tmp/claude-1000/rx-a/state` | 17:49 | used for `rex hosts` experiments; hosts added were removed |

## Baseline
- `npm run check` at `a4da2ca`: typecheck clean, **41/41 tests** pass (2026-11-07 17:50).
- After this branch's changes: **52/52** tests pass, typecheck clean — also with no Vercel login (`HOME`/`XDG_DATA_HOME` empty), which is the CI condition. CI on macOS (Node 22, 24) green at `ab149d8`.

## Unit tests added (test/extend.test.mjs, test/ux.test.mjs)
- extend adds time in place; success reported only from the re-read deadline on the same session ID.
- stopped/failed/aborted → "resume with start", never resumed/created; stopping → wait.
- plan headroom computed before the API call; messages show the remaining headroom; hobby 45m / pro 24h.
- interactive prompt re-asks on invalid or oversized answers.
- explicit 4xx rejection explained without retry; 401/403 surface as auth errors; secrets never echoed.
- ambiguous failure (network error): re-read decides — applied → success, not applied → "not extended", never a second POST.
- session replaced or stopped underneath → reported, not trusted.
- `registerHost` adds/edits only rex-cloud sockets, reports conflicts, never removes, never throws.

## Live checks
(filled in below as they run)

### L1 — Two devices, one server (live, 17:51–17:55 UTC)
Setup: `node scripts/live-attach.mjs agenttest /tmp/claude-1000/rc-a --create --timeout 1h …` then the same for `/tmp/claude-1000/rc-b`. Each state root gets its own helper + private socket (`/tmp/rex-cloud-1000-<hash>/<key>/sandbox-agenttest.sock`), both bridging to the same in-sandbox `/vercel/.local/state/rex/run/server.sock`.
- `rex -S unix://<A> server status --json` and via `<B>`: **same `pid` 763, same `instance_id` 10d8e2a3…**, `session_count` 1. ✅ (#2)
- `session ls` via A and B: same `session:01a1b723-6fb5-71ea-…` labelled `agenttest`. ✅ (#2)
- A: `send` a loop `echo MARKER_PID=$$; while :; do tick…; sleep 5; done` into the first block. B: `capture` shows `MARKER_PID=835` and live ticks. ✅ shared output (#3)
- B: `split --split=below -- bash -c 'echo FROM_B_PID=$$; sleep 600'` → A's `capture` of the new block shows `FROM_B_PID=1029`; A's `block ls` lists all three blocks. ✅ shared input + split propagation (#3, #4)
- A: `window new … Second`, `zoom --on`, `focus` → B's `rex events --all --json` stream received `window_created`, `block_created`, `active_window_changed`, `block_owner_changed`, `session_view_changed` (revisions 2→8), plus `client_joined/left`. ✅ layout propagation (#4)
- Disconnected device A's helper (`disconnect()` → socket removed). 8 s later B still captured `tick 20/21`; server pid/instance unchanged. ✅ process survives client loss (#5)
- Re-attached A (`live-attach` without `--create`): `created:false, resumed:false`, same `vm`, same session/block IDs, new helper pid; A's capture shows the same loop continuing (`tick 21`, no restart, same MARKER line). ✅ reconnect reaches the original process (#6)
- Second attach on A reused the running helper (same `helperPid` 112286). ✅ repeated start idempotent (#11)
- Events flagged by Rex: terminal blocks have an `owner` client (`block_owner_changed`) — size follows the owner; non-owner still reads/writes.

### L2 — Lifetime extension (live, 17:54 UTC, `--state-dir /tmp/claude-1000/rc-a`)
| Command | Result |
| --- | --- |
| `extend agenttest --by 25h` | `Choose a timeout from 1m to 24h…` (local validation, no API call) |
| `extend agenttest --by 24h` | shows `stops: Nov 7, 6:51 PM UTC (57m remaining)` then `Add up to 23h. Your plan allows 24h per run, and agenttest is already set to 1h.` |
| `extend agenttest` (stdin not a TTY) | `Choose how much time to add with --by, for example --by 2h. agenttest can take up to 23h more.` |
| `extend agenttest --by 2h --json` | `{"expiresAt":"2026-11-07T20:51:53.880Z","added":7200000,"previousExpiresAt":"2026-11-07T18:51:53.880Z", "vm":"sbx_RIBGcLsM3wyQ0jSOY0g3tWTki5Fd", …}` |
| `status agenttest` | `Stops: Nov 7, 8:51 PM UTC (178 min remaining)` |
| raw `GET /v2/sandboxes/{name}` | `status running`, **same session** `sbx_RIBGcLsM3wyQ0jSOY0g3tWTki5Fd`, `expiresAt 2026-11-07T20:51:53Z`, `session.timeout` 3h |
After the extension the ticking process (PID 835) and both bridges continued; server instance id unchanged. ✅ (#7, #8 partially — see L4 for the stopped case)

### L3 — Stop, extend-on-stopped, snapshot resume (live, agenttest2, 17:56–17:58 UTC)
Second disposable computer `rex-cloud-ba26fe7defb02116-agenttest2` (30m, session `sbx_LJtXDszfaKcZAfJBwyQwPKclsL80`), state root `/tmp/claude-1000/rc-c`.
- Before stop: wrote `~/marker.txt`, started `sleep 3000` (1 process), added a split (2 blocks in the session).
- `rex-cloud stop agenttest2` → `agenttest2 stopped. Files are saved. Running processes have ended.`
- `rex-cloud extend agenttest2 --by 1h` → `agenttest2 is stopped, so there is nothing to extend. Resume it with rex-cloud start agenttest2. extend never starts a computer.` No API write, no resume. ✅ (#8)
- `rex-cloud status agenttest2` → `stopped`, `Stops: not running`. ✅
- Resume (`live-attach` without `--create`): `resumed:true`, **new VM** `sbx_yc1kAJ8R8jA53YZDMpT721CpOXbI`, new Rex server (pid 645, new instance id, uptime 11 s).
- After resume: `cat ~/marker.txt` → `restored-marker-1794074232` ✅ files restored; `pgrep -c sleep` → `0` ✅ processes gone; Rex restored the **session structure** from its persisted state dir: same `session:01a1b727…`, same first block ID, 2 blocks — but every terminal is a fresh shell. ✅ (#12) — "Files restored. Terminals start as fresh shells." is accurate; layout also survives.

### L4 — Plan cap behaviour (live, agenttest, 18:00 UTC)
- `extend agenttest --by 21h --json` → `expiresAt 2026-11-08T17:51:53.880Z` (total 24h), same session. ✅
- `extend agenttest --by 1m` → pre-check: `agenttest already has the longest run your plan allows (24h per run)…` (no API call). ✅
- Raw probe past the cap: `POST /v2/sandboxes/sessions/sbx_RIBG…/extend-timeout {"duration":60000}` → **HTTP 400 `sandbox_timeout_invalid` "Failed to extend timeout: extension would exceed maximum execution timeout"**; deadline unchanged afterwards (re-GET: 24h, same session). This code is now mapped to a plain-language message in `extend` (unit-tested). ✅ (#8)
- Enterprise team confirmed at 24h max per session [observed]; `teamLimit()` treats pro/enterprise as 24h and hobby as 45m [doc, see docs/RESEARCH.md].

### L5 — Sustained connectivity (live, device B bridge, 17:55 → 20:35 UTC)
`scratchpad/monitor.sh`: every 30 s `rex -S <B> server status --json`; every 5 min a `capture` of the ticking block. Results are appended below when the run ends.

**Result (observed, 2026-11-07 17:55:12 → 20:34:39 UTC, 2h39m):**

| Metric | Value |
| --- | --- |
| Probes (`server status` over device B's bridge, every 30 s) | 314 |
| Failures | 0 |
| Distinct server instance IDs seen | 1 (`10d8e2a3-…`) |
| Sessions reported | 1 throughout |
| Tick captures (every 5 min, 32 total) | counter rose monotonically 1307 → 1917 (~61 per 5 min = the 5 s loop never paused) |

Interpretation: the bridge from device B stayed usable for the whole window with no reconnect or server restart, and the
process started earlier in the cloud block kept running. The monitor exited on its own at 20:35:09 UTC. Raw log:
`scratchpad/monitor.log` (not committed; contains only timestamps, instance IDs and tick values).

## Manual acceptance on two physical Macs (pending — not verifiable from Linux)
Prerequisites on **both** Macs: current Rex app in /Applications with `rex` on PATH, Node 22+, this branch installed (`npm install --global <tarball>` or `npm link` from the checkout), same Vercel user. Use `--team team_TtmJZYmD3tcLBLqWOhoVawd1 --project prj_IbmALXBur5uokFthCQ1j1hUkJrW8` on first `setup` if the Mac is not already configured for the `remote` computer.

1. **Work Mac — first use / reconnect**: `rex-cloud start remote`. Expect: reuse of the Vercel login, `Connecting to remote…` (no duration prompt for a running computer), then either `Select remote in Rex to continue.` or `In Rex, select the remote host in the sidebar…` plus the socket path fallback. Expected `Stops:` equals `rex-cloud status remote`.
   - Check: does the **remote** host appear in Rex's sidebar without pasting? (`rex hosts` on the Mac should list `remote → unix:///tmp/rex-cloud-…/sandbox-remote.sock`.) Record yes/no — this decides whether the README's "registers the computer as a Rex host" sentence can drop its fallback.
2. In the cloud terminal start something long-lived, e.g. `claude` or `while :; do date; sleep 2; done`, and note the PID (`echo $$`).
3. **Close the work Mac's lid** (or `rex-cloud disconnect remote`). Wait ≥2 minutes.
4. **Personal Mac**: `rex-cloud start remote`. Expect `Connecting to remote…`, same `Stops:` time (no extension), host registered/listed. Select **remote** → the same session, windows and splits, with the loop still running and the same PID. Type into the terminal: input works. Open a split: it must appear on the work Mac when it wakes.
5. **Work Mac wakes**: Rex reconnects to its local socket (helper still running, or run `rex-cloud start remote` again). Expect the same session and the split made from the personal Mac.
6. **Extend**: on either Mac `rex-cloud extend remote` → shows the stop time, asks for a duration; or `rex-cloud extend remote --by 2h`. Expect `Added 2h to remote. Nothing was interrupted.` and a later `Stops:`; the loop keeps running and both Macs stay connected. `rex-cloud status remote` on the other Mac shows the new time.
7. Negative: `rex-cloud extend remote --by 30h` (rejected locally), `rex-cloud extend other` for a stopped computer (points to `start`).
8. Cleanup is not needed for `remote`; stop test computers with `rex-cloud stop <name>`.

## Cleanup (observed, 2026-11-07 20:38–20:40 UTC)
- `agenttest`: `scripts/live-delete.mjs` → `{"deleted":"rex-cloud-ba26fe7defb02116-agenttest","lastStatus":"stopped"}`; API GET by name → `not_found`.
- `agenttest2`: deleted earlier (18:15), `not_found` confirmed.
- Helpers pid 112286 (A) and 111960 (B) disconnected via `disconnect()`; their bridge sockets and directories are gone. State roots rc-a/rc-b/rc-c and the isolated Rex server state (rx-a, already exited) removed.
- Not touched: live `remote` sandbox and its deadline, Rex server pid 686, the two `relay.py` processes serving the user's own connections, Vercel/GitHub logins.
