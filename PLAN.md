# PLAN — Rex Cloud: one cloud server, two Macs, explicit lifetime extension

Branch `feat/multi-client-extend`, based on `v0.1.0-prototype.3` (`a4da2ca`). Companion files: `PROGRESS.md` (log, checkpoints), `TESTING.md` (commands, evidence), `docs/RESEARCH.md` (sources).

## Goal

1. `rex-cloud start remote` on the work Mac starts or reconnects to a named cloud computer.
2. It appears as a remote host in Rex; terminals and a coding agent run there.
3. Closing the work laptop leaves cloud processes running.
4. `rex-cloud start remote` on the personal Mac attaches to the same live Rex server, sessions and processes.
5. `rex-cloud extend remote [--by 2h]` adds time to the running computer without interrupting anything.

## Architecture decision

**Chosen: A — both Macs use the existing authenticated Vercel bridge** (local private Unix socket → detached helper → Sandbox interactive WebSocket → `relay.py` → the cloud Rex Unix socket). One Rex server inside the Sandbox owns all sessions; every Mac is just another Rex client of that server.

Why A over B (Rex built-in `--tailscale`):

| | A: Vercel bridge (existing) | B: Rex `server start --tailscale` (embedded tsnet) |
| --- | --- | --- |
| Install effort on each Mac | Already required: `rex-cloud` + Rex app. No extra account. | Adds a Tailscale account, Tailscale on each Mac, an auth key delivered into the Sandbox, ACLs. |
| Identity / auth | Vercel user + team/project scopes (already enforced: personal names, owner tags, token never leaves Mac). | Tailnet identity (node owner by default). A second trust system to configure and keep aligned with Vercel access. |
| Exposure | No listening network port; the Rex socket is `0600` inside the VM. | A tailnet-reachable endpoint. Acceptable with default node-owner policy, but strictly more exposure and more flags to get wrong. |
| Reconnect | Helper re-fetches an interactive URL per connection; Rex reconnects to the local socket. | tsnet node must re-enrol after every snapshot resume (ephemeral/auth key lifecycle); Sandbox restarts change node state. |
| Lifecycle | Nothing to clean up besides the Sandbox. | Tailnet devices to garbage-collect per Sandbox session. |

Two Macs of one person are two clients of one server; Rex's shared-server mode (login-server / multi-account) is unnecessary. Tailscale would only earn its place if the Vercel WebSocket path were unavailable or too slow; it is neither (observed interactive bridge working from this agent's own session). Decision is revisited in `docs/RESEARCH.md` if the Rex docs show a host-registration path that needs it.

Snapshot/resume: a stopped computer resumes **files only**; processes, scrollback and the Rex server restart fresh (`rex server run --restore` default true keeps session *layout* if the server state dir is on the persisted disk — to verify in testing, not promised).

## Smallest complete improvement (this branch)

1. **`rex-cloud extend [name] [--by 2h] [--shared] [--json]`**
   - Reads the computer (never resumes: `Sandbox.get(..., resume:false)`).
   - Stopped/failed/aborted → tells the user to run `start`; never creates or resumes. `stopping`/`snapshotting`/`pending` → wait and retry.
   - Shows the current stop time + remaining; asks how much to add (interactive) or takes `--by`.
   - Checks plan headroom (`teamLimit` − current session timeout) before calling the API; rejections explained briefly.
   - Calls `Session.extendTimeout(ms)` on the **current session** — not `Sandbox.extendTimeout`, whose `withResume` wrapper resumes a stopped sandbox.
   - On any error that is not an explicit API rejection, re-reads the computer and compares `expiresAt` to the pre-call value, so a timed-out request is never retried into a double extension.
   - Reports success only after re-reading the authoritative `expiresAt` and confirming the same session ID is still running. Prints the stop time with timezone.
   - `status` gains an `Extend:` hint; `start`/reconnect never changes a running computer's deadline (unchanged behaviour, now covered by a test).
2. **Second-Mac flow documentation + evidence** (README "Connect from another Mac" made precise; manual acceptance steps in `TESTING.md`).
3. **Tests**: unit tests with a mocked backend for every `extend` path; live isolated-Sandbox tests recorded in `TESTING.md`; local isolated Rex server tests for multi-client sharing semantics.

Out of scope (recorded as limitations): automatic host registration in Rex for Mac (depends on Rex app support — see research), startup at login, process migration from macOS.

## Acceptance plan

| # | Check | Method | Status |
| --- | --- | --- | --- |
| 1 | Baseline: typecheck clean, 41 tests pass | `npm run check` | ✅ 41/41 at a4da2ca; 52/52 after |
| 2 | Two independent clients reach the same server and see the same session IDs | isolated `rex server run --state-dir … --listen unix://…` + two CLI clients via two bridges | ✅ live L1 (same pid 763 / instance 10d8e2a3) |
| 3 | Shared live output and input | `rex send` from client A, `rex capture` from client B | ✅ live L1 |
| 4 | Session/tab/split/layout propagation | `rex events --all --json` on B while A runs `new`, `window new`, `split`, `focus`, `zoom` | ✅ live L1 (events on B) |
| 5 | Running process survives client disconnection | start `while :; do date; sleep 1; done` in a block, `disconnect` helper A, re-capture from B | ✅ live L2 (MARKER_PID 835 survived) |
| 6 | Reconnection reaches the original process | record block PID / `$$` before and after reconnect | ✅ live L2 |
| 7 | `extend` changes the deadline, same session ID, same PIDs | live on an isolated test computer | ✅ live L3 (18:51→20:51, same session) |
| 8 | Extension limits, stopped computer, auth errors, ambiguous failures | unit tests + live stopped-computer check | ✅ unit + live L3/L4 (400 sandbox_timeout_invalid; stopped → start) |
| 9 | Personal identity isolation / explicit sharing preserved | existing tests + no behaviour change | ✅ existing tests unchanged, 52/52 |
| 10 | Auth recovery preserves the Vercel CLI login | existing `auth.test.mjs` + `test:login-command` | ✅ auth.test + test:login-command |
| 11 | Install, repeated starts, reconnect | `npm pack` + `test:package`; repeated `open` against the test computer | ✅ test:package; repeated attach idempotent (L2) |
| 12 | Timeout / snapshot resume: files restored, processes gone | stop + start test computer; check marker file and process list | ✅ live L4 (agenttest2: files back, processes gone) |
| 13 | Sustained connectivity (≈2 h) | bridge + `rex events` stream with periodic `capture`, logged | ✅ live L5: 314 probes / 0 failures / 2h39m |
| 14 | Physical two-Mac GUI continuity | **manual, pending** — steps in `TESTING.md` | ⏳ manual, pending — steps in TESTING.md |

Protection rules while testing: never touch the live `remote` computer, its Rex server (`/vercel/.local/state/rex/run/server.sock`) or its deadline; isolated Rex servers use their own `--state-dir` and sockets under the scratchpad; cloud tests use computers named `agenttest-*` created and deleted by this agent only.
