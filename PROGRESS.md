# PROGRESS

Branch: `feat/multi-client-extend` (local), base `a4da2ca` = tag `v0.1.0-prototype.3`.

## 2026-11-07 17:30 UTC — Preflight
- Host: Vercel Sandbox (Ubuntu 26.04, x86_64), hostname `0b9f99a9-311`, booted 17:10 UTC.
- This agent runs **inside the live `remote` computer**: `rex server run` pid 686 on
  `/vercel/.local/state/rex/run/server.sock`, 2 relay clients attached. DO NOT stop/restart/reconfigure.
- Rex: `0.1.0-preview.13` (commit 1b66548, built 2026-11-03).
- Tools: git, gh 2.103.3, node 24.22.1, npm, pnpm, bun, jq, gpg. Missing: vercel CLI, tailscale, ssh-keygen.
- Credentials: no GitHub login, no Vercel CLI/OIDC token, no VERCEL_* env in sandbox.
- Vercel MCP connector: team `elisabethrulke` (team_6FYa…), **0 projects**, so the `remote`
  computer is in a team the connector can't see. Its deadline is **unverified**.
- Deadline inference [assumption]: boot 17:10 UTC + 20h = 2026-11-08 13:10 UTC (05:10 PST), which matches
  the historical observation. Confirm after Vercel login.

## 2026-11-07 17:50 UTC — Access + deadline confirmed
- Logins: GitHub `erulkey` (admin on vercel-labs/rex-cloud; `main` requires signed commits → publish via GitHub API only).
  Vercel CLI login `elisabethrulke` saved at `~/.local/share/com.vercel.cli/auth.json` (remove at end).
- `remote` computer located [observed, API]: team `vercel-internal-playground` (`team_TtmJZYmD3tcLBLqWOhoVawd1`),
  project `codex-integration-factory` (`prj_IbmALXBur5uokFthCQ1j1hUkJrW8`), named sandbox
  `rex-cloud-ba26fe7defb02116-remote` (personal; owner hash of user id), session `sbx_Uy31DDvuAPefwRUBXVYVIeVyNTRJ`,
  2 vCPU / 4 GB, iad1, image universal, timeout 72,000,000 ms (20h), `expiresAt` 1794143422915 =
  **2026-11-08 13:10:22 UTC = 05:10 PST** — matches the historical observation. Not extended by us.
- Useful API facts [observed]: `GET /v2/sandboxes/{name}?projectId&teamId` returns `sandbox.expiresAt`, `sandbox.status`,
  `sandbox.currentSessionId`, `session.timeout`; `POST /v2/sandboxes/sessions/{id}/extend-timeout` exists in SDK 3.9.1.
- Other rex-cloud computers in that project (all stopped, not ours to touch): `…-review-check`, `rex-cloud-ux-check`,
  `rex-cloud-dev`, `rex-cloud-prototype-custom`, `rex-cloud-prototype`.
- Test resources will be created in the same team/project, named `rex-cloud-*-agenttest-*` and deleted afterwards.
- User left at 17:48 UTC with instruction to proceed autonomously.

## 2026-11-07 18:00 UTC — Implementation + live tests
- Commit `ace1eb0`: `extend` command, Rex host registration (`rex hosts add/edit`), harness `scripts/live-attach.mjs`, docs.
- Research in `docs/RESEARCH.md` (agent-written, sourced). Decision: keep the Vercel bridge (A); Tailscale not needed.
- Live evidence L1/L2 in TESTING.md: two devices share one server; process survives disconnect; reconnect reaches it;
  `extend --by 2h` moved agenttest's deadline 18:51→20:51 UTC on the same session.
- Running: connectivity monitor over device B until 20:35 UTC (`scratchpad/monitor.log`); agenttest2 stop/resume test.
- Flaky pre-existing test noticed once: `detached helper … recovers from a crash` (timing; passes on rerun).
- Still to do: API behaviour when exceeding the 24h cap (probe via SDK on agenttest at the end), cleanup
  (stop+delete agenttest, agenttest2; remove helpers; `vercel logout`? — see final notes), publish branch + draft PR.

## 2026-11-07 18:15 UTC — Published
- Branch `feat/multi-client-extend` published as ONE GitHub-signed commit via GraphQL `createCommitOnBranch`
  (the repo requires signed commits on every branch; Git Data API commits are unsigned and were rejected —
  dangling unsigned object `c5c8457…` is harmless). Local history (`ace1eb0`…`3fe5a01`) is the detailed record.
- Draft PR opened against `main`. Not merged; no release.
- agenttest2 deleted (`not_found` confirmed). agenttest still running (24h cap test) for the connectivity monitor;
  delete after 20:35 UTC with `node scripts/live-delete.mjs agenttest /tmp/claude-1000/rc-a` (+ disconnect rc-b).
- Remaining: monitor results → TESTING.md L5; final publish of docs; cleanup; final report.

## 2026-11-07 20:30 UTC — CI failure found and fixed
- The PR's macOS CI (Node 22 and 24) failed on commits `3efd0bb` and `250f44c`: all `test/extend.test.mjs` cases
  that call `extendComputer` threw `Vercel sign-in is required` because `findComputer` reads credentials before the
  (fake) backend is used. Locally the suite passed only because this machine is signed into Vercel. Reproduced here
  with `HOME`/`XDG_DATA_HOME` pointed at an empty directory: 8 of 10 fail on the old file.
- Fix: the suite sets `VERCEL_TOKEN=test-only` in `test.before`, as `core`, `helper` and `context` tests already do.
  The value never leaves the process; the backend is a fake. Full suite 52/52 in the logged-out condition.
- Published as signed commit `ab149d8` (GraphQL `createCommitOnBranch`); CI now green: test (22), test (24),
  Socket Security ×2, Vercel Internal Security Review.
- Live verification of `extend` remains the record in TESTING.md L3/L4 (real sandbox `agenttest`, API re-reads).

## 2026-11-07 20:40 UTC — Soak finished, cleanup done
- L5 soak: 314 probes / 0 failures / 2h39m, single server instance, tick loop never paused (TESTING.md).
- All created resources deleted and verified `not_found`; helpers disconnected; local test state removed. Live
  `remote`, server pid 686 and the user's relay processes untouched. Details in TESTING.md "Cleanup".
- PLAN acceptance table: 13 of 14 checks ✅; #14 (two physical Macs, sidebar host visibility) remains manual.
- Logins left in place on this computer (Vercel CLI, gh) so the user can continue; `vercel logout` / `gh auth logout` remove them.

## 2026-11-08 00:30 UTC — Mac feedback round
- User ran the branch on the work Mac: `extend remote --by 1h` worked on the real computer (API-confirmed, same session,
  this agent uninterrupted). Host registration failed: the Mac's Rex (0.0.1793645657, built 2026-11-02) rejects socket-path
  host endpoints with HTTP 400; Rex ≥ 0.1.0-preview.13 accepts them. Recorded as TESTING.md M1/M2.
- Added `start --label` (sidebar name), endpoint-based recognition of renamed hosts, multi-endpoint shared hosts, and an
  `outdated` registration result with an "update Rex" hint. Commits `5a63f9a`, `0fd36ed` (signed), CI green on the former.
- CI flake on `0fd36ed` (pull_request run only): pre-existing `write ENOTCONN` in the helper crash-recovery test. Root
  cause is the CLI's control probe not treating ENOTCONN as "helper gone" like ECONNRESET/EPIPE; fixed in `src/helper.ts`.
