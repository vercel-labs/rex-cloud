# Research: multi-Mac attach + `rex-cloud extend`

Date: 2026-11-07. Rex binary on this machine: `rex 0.1.0-preview.13` (commit 1b66548). SDK: `@vercel/sandbox` 3.9.1.

Tags: **[doc]** stated in official docs · **[observed]** seen in `rex … --help` on this machine or in SDK `.d.ts`/`.js` · **[assumption]** inference, not verified.

Source keys used below:
- R-DOCS https://www.superlogical.com/rex/docs
- R-REMOTE https://www.superlogical.com/rex/docs/linux/remote-access
- R-MODES https://www.superlogical.com/rex/docs/linux/server-modes
- R-SHARED https://www.superlogical.com/rex/docs/linux/shared-server
- R-LOGIN https://www.superlogical.com/rex/docs/linux/login-server
- R-UPGRADE https://www.superlogical.com/rex/docs/linux/upgrading
- R-INSTALL https://www.superlogical.com/rex/docs/linux/installation
- R-SRVAPI https://www.superlogical.com/rex/docs/automate/server-api
- R-CLIDOC https://www.superlogical.com/rex/docs/automate/cli
- R-CLI https://www.superlogical.com/rex/docs/reference/cli
- R-API https://www.superlogical.com/rex/docs/reference/api
- R-EVENTS https://www.superlogical.com/rex/docs/reference/events
- R-LUA https://www.superlogical.com/rex/docs/reference/lua
- R-CONFIG https://www.superlogical.com/rex/docs/customize/config
- R-MACSET https://www.superlogical.com/rex/docs/reference/mac-settings
- R-MACACT https://www.superlogical.com/rex/docs/reference/mac-actions
- R-PRIVACY https://www.superlogical.com/rex/docs/reference/privacy
- V-SBX https://vercel.com/docs/sandbox (the `/docs/vercel-sandbox/...` URLs 404; canonical is `/docs/sandbox/...`)
- V-PRICE https://vercel.com/docs/sandbox/pricing
- V-WORK https://vercel.com/docs/sandbox/working-with-sandbox
- V-PERSIST https://vercel.com/docs/sandbox/concepts/persistent-sandboxes
- V-SNAP https://vercel.com/docs/sandbox/concepts/snapshots
- V-AUTH https://vercel.com/docs/sandbox/concepts/authentication
- V-SDK https://vercel.com/docs/sandbox/sdk-reference
- V-CLI https://vercel.com/docs/sandbox/cli-reference
- V-KB https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence
- V-REST-EXT https://vercel.com/docs/rest-api/sandboxes/extend-session-timeout
- V-REST-GET https://vercel.com/docs/rest-api/sandboxes/get-a-named-sandbox
- V-CHG24 https://vercel.com/changelog/vercel-sandbox-can-now-run-for-up-to-24-hours
- T-TSNET https://tailscale.com/kb/1244/tsnet
- T-KEYS https://tailscale.com/kb/1085/auth-keys
- T-EPH https://tailscale.com/kb/1111/ephemeral-nodes
- T-TAGS https://tailscale.com/kb/1068/tags
- T-EXPIRY https://tailscale.com/kb/1028/key-expiry
- T-HTTPS https://tailscale.com/kb/1153/enabling-https
- LOCAL-SDK `/vercel/work/rex-cloud/node_modules/@vercel/sandbox/dist/{sandbox,session}.d.ts`, `api-client/api-client.{d.ts,js}`, `sandbox.js`
- LOCAL-HELP output of `/vercel/.local/share/rex-cloud/rex <cmd> --help`

---

## 1. Rex (Superlogical)

### 1.1 Server-side vs per-client state

- Model: a **session** "keeps running whether or not a client is viewing it"; a **window** is a tab holding a layout of **blocks**; a **block** is one application (today a terminal); a **client** is a program connected to the server (app or CLI). IDs are permanent; labels are mutable. [doc] R-CLIDOC
- `session.view` returns a server-held snapshot of **windows, layouts (trees of `block`/`split` nodes with `direction`, `before`, `after`, `ratio`), floating layers (`bounds` `[x,y,w,h]` fractions), and blocks**, plus a monotonically increasing `revision`. Clients keep the highest revision and re-fetch on `session_view_changed`. So layout, splits, panes, tabs/windows, floating layers are **server state shared by all attached clients**. [doc] R-API
- **Focus**: "each window keeps its own focused block"; focus methods are server API methods (`session.focus_block`, `session.focus_window`, …) and "focus methods end any zoom in the affected window". So **per-window focused block and zoom are server state**, shared. [doc] R-API
- `active_window_changed` is a *session* event (`window_id`), so the **active window of a session is server state** too. [doc] R-EVENTS
- **Zoom** (`session.zoom_block`): "Fills the window with one block. The layout is unchanged, and zoom ends when focus moves to another block in the window." Server-side, shared. [doc] R-API
- **Scrollback / screen content**: lives in the terminal block on the server (`rex capture` "Print a terminal's screen and scrollback"; `com.superlogical.terminal.format` reads what a block shows). [observed] LOCAL-HELP, [doc] R-API
- **Terminal size**: the terminal block has `size` ("Return the terminal's size in cells and pixels") and `resize` ("Request a size for the terminal") methods. [doc] R-LUA. Size conflicts: "when attached clients want different things for a block, such as a terminal's size, the block follows its **owner**" — `session.own_block` (`take` = immediate owner, `request` = queued behind current owner), `session.disown_block`, `block_owner_changed` event; when an owner detaches/disconnects the block passes to the next claimant (`take` claims ahead of `request`). Owning "gives no other rights". [doc] R-API
- **Per-client** state: which session the client is viewing (`session.bootstrap` has `preferred_session_id`; `session.attach` is per-connection; `session.detach` removes the client from one session and keeps the connection), the client's label (`client.set_label`), its loaded Lua scripts (`client.set_script`), the viewport/window geometry on the Mac (not part of `session.view`, which "describes structure only"). [doc] R-API. The Mac app renders "smooth terminal resizing" locally while the server size follows the owner. [doc] R-MACSET
- Not documented: how a non-owner client renders a terminal whose server size differs from its own pane (e.g. letterboxing vs reflow). [assumption] It must render the owner's cell grid, since content is server-side.

### 1.2 Multiple simultaneous clients

- Supported by design: `client.list` lists all connected clients; `session.list_clients` lists clients attached to one session; a dropped connection leaves the client listed as `lost` for up to 60 s and a reattach keeps the same `client_id`. [doc] R-API. `rex client ls` has a `principal` column per identity. [doc] R-REMOTE, [observed] LOCAL-HELP
- Live mirroring: all attached clients receive the same session event stream (`seq`-ordered; replay from snapshot; a connection >8 MiB behind is closed) and open per-block data streams via `data.connect` → WebSocket `/api/data` with one-time tickets. Input goes to the block via `client.key` / `block.event` from any attached client. [doc] R-API. Shared-server page: "all members can see and type into every session". [doc] R-SHARED. So **input and output mirror live across clients.** [doc] (mechanism) / [assumption] (no explicit "two Macs" statement)
- **Shared server mode vs personal**: modes are Personal (your account, any `rex` command autostarts it), Shared (`rex` system account via `rex.service`, members of group `rex`, everything runs as `rex`), Login (root; identifies caller by connection, maps to OS account via `/etc/rex/accounts.jsonc`, hands off to a per-account server). [doc] R-MODES. Shared/Login are about *multiple OS identities on one machine*; **they are not required for multiple clients**. A personal server already admits several clients (the Mac app plus CLI are both clients). [doc] R-MODES, R-API
- **Two Macs of one person**: no need for shared mode; both just need a path to the same personal server's socket/listener. In rex-cloud today both Macs' relays connect to the same Unix socket inside the sandbox; the server identifies each as `peer` uid of the sandbox user. [observed] `assets/relay.py`, PROGRESS.md ("2 relay clients attached") / [doc] `server.whoami` kinds R-API
- Auth in shared mode: group membership on the socket (mode `0660`, refuses `0666`); "Access to the shared server is access to the `rex` account". [doc] R-SHARED. Login server: no passwords/keys, identity from the connection (`peer:<uid>`, `tailscale:<login>`, `tailscale:tag:<name>`, `tailscale:*`, `identified`, `anonymous`); account chosen with `https://ACCOUNT@host`. [doc] R-LOGIN

### 1.3 `rex server start --tailscale`

- "also serve the API over the tailnet as an embedded tsnet node"; flags `--tailscale-hostname NAME` (default `rex`), `--tailscale-control-url URL` (Headscale), `--tailscale-auth-key-file FILE` (`-` for stdin on `run`), `--tailscale-advertise-tag TAG` (repeatable), `--tailscale-allow-tailnet-members`. [observed] LOCAL-HELP (`rex server start --help`, `rex server run --help`)
- "The machine doesn't need Tailscale installed, because Rex embeds it." First run: sign in via link shown in `rex server status` or the log; headless: one-time auth key file (key needed only once). Address `https://rex.<tailnet>.ts.net`; **tailnet needs MagicDNS and HTTPS certificates enabled**. Tagged device needs `--tailscale-advertise-tag tag:NAME` **and** `--tailscale-allow-tailnet-members` (tagged devices have no owner). [doc] R-REMOTE
- Identity/ACL: "By default, only the machine's owner (or the Rex device) is allowed"; `--tailscale-allow-tailnet-members` admits "any tailnet member permitted by ACLs". `server.whoami` returns `kind: tailscale` with `user_id`, `login_name`, `node`. API: "Tailscale access is controlled by `allow_tailnet_members`. When false, only the user who signed in the device gets in." [doc] R-REMOTE, R-API, [observed] LOCAL-HELP
- Runtime management: `rex server tailscale on|off|logout|login|rename|pair` (`pair` shows a QR of the tailnet address); API `server.tailscale.enable/disable/login/logout/rename` are **local-only methods** (403 over TCP/Tailscale). `server.status` includes `tailscale` (`state` e.g. `needs_login`/`disabled`, `auth_url`, `https.state`, `dns_name`); `tailscale_status_changed` server event. [doc] R-CLI, R-API, R-EVENTS, [observed] LOCAL-HELP
- Alternatives needing host `tailscaled`: `--extra-listen tailnet-serve:///run/rex/serve.sock` + `tailscale serve` (identifies callers via tailscaled LocalAPI, `--tailscaled-socket PATH`), or `--extra-listen tailnet://:7297` (plain HTTP inside the tailnet). "Always use `tailnet-serve://` … never `unix://`" for the Serve socket. [doc] R-REMOTE
- Plain TCP needs `--allow-anonymous` and "every connection has full access". [doc] R-REMOTE, [observed] LOCAL-HELP
- Mac side: **Add Remote Host…** with `https://rex.<tailnet>.ts.net` (bare hostname tries HTTPS 443, then HTTPS 7297, then HTTP 7297). The Mac app itself also has a *Settings > Server > Tailscale* toggle to serve its own local server over the tailnet and a *Remote Address / Pair device (QR)* flow. [doc] R-REMOTE, R-MACSET
- tsnet background: embedded node with userspace TCP/IP stack; without an auth key `Start()` prints a login URL; auth key pre-approves; device approval may still require admin approval. [doc] T-TSNET. HTTPS certs: enable MagicDNS + "Enable HTTPS"; Let's Encrypt via DNS-01; names appear in public CT logs; LE rate limits apply. [doc] T-HTTPS
- Privacy: Tailscale off by default; when on, "the built-in Tailscale device connects to Tailscale's servers, and Tailscale receives its connection logs and metrics." [doc] R-PRIVACY

### 1.4 Registering a remote host in Rex for Mac automatically

- GUI: **Add Remote Host…** (`client.host.add`, keywords "url http https connect"), **Switch Host** (`client.host.switch`), **Remove Host…**, **Pair Device with QR Code…**. Settings > Remote Hosts lists/reorders hosts, shows status, retry. No arguments documented for these actions. [doc] R-MACACT, R-MACSET
- Address forms accepted by Add Remote Host: the same forms as `rex -S` — `https://host`, `http://host:port`, `ACCOUNT@host` for login server, and local Unix socket paths (SSH-forward recipe: "Add the local socket path as a host in Rex for Mac, or with `rex hosts add`"). [doc] R-REMOTE, R-LOGIN
- **No `rex://` URL scheme / deep link is documented** anywhere on the site or findable via web search. [doc] (absence) R-MACACT, R-MACSET; search 2026-11-07
- Programmatic host registration paths:
  - `rex hosts add LABEL ENDPOINT... [--icon NAME]`, `hosts edit/remove/check/list`. "Hosts are stored on your home, so every device following that home sees the same list." "a socket path only works on devices where it exists." [doc] R-CLI. **But** R-REMOTE says "`rex hosts` is CLI-only today and doesn't sync to the GUI or other machines." The two pages conflict; treat GUI visibility of `rex hosts add` entries as **unverified** [assumption: R-REMOTE is the more conservative/current statement].
  - Server API `hosts.put` (adds/replaces a host by `id`; `label` ≤64 chars unique case-insensitively; `endpoints` ≥1 "in a form the `rex -S` option accepts"; **"Unix sockets and named pipes aren't allowed"**; server never writes the config file; emits `hosts_changed` to connected clients; store ≤1 MiB). `hosts.list` returns declared (`source: init.lua:N`) + stored hosts. [doc] R-API
  - Config file `rex.host{ label=, endpoints={...} | endpoint=, id=, icon= }` in `~/.config/rex/init.lua` (Mac default; `REX_CONFIG` override), load-time only, then `rex config reload` on the same machine. Endpoint forms not specified; "declares other servers to connect to". [doc] R-LUA, R-CONFIG, R-DOCS
- Implication: the current rex-cloud bridge exposes a **Unix socket**, which `hosts.put` rejects and which `rex hosts add` can only add per-device. To auto-register without pasting, rex-cloud would need either (a) a loopback `http://127.0.0.1:PORT` listener on the Mac proxying to the sandbox socket (allowed by `hosts.put`/`rex.host`, but whether the Mac GUI picks it up is the unverified point above), or (b) a `rex.host{}` line written into the Mac's `init.lua` plus `rex config reload`. [assumption]
- The Mac app's bundled local server exposes a "Local API" Unix socket (Developer Mode) and the `rex` CLI targets it by default; `rex client ls` / `-C` can target Rex.app; app-level requests need **Remote Control** enabled in Settings. [doc] R-MACSET, R-CLI, agent-skill page

### 1.5 Server API & events (for tests)

- Discovery: `rex api list [-q|--json]`, `rex api describe METHOD [--json]`, `rex api call METHOD '<json>'` (`-s SESSION` adds `session_id`); `help.all` / `GET /api/help` / `/llms.txt`. Errors: `bad_request`, `not_found`, `session_not_found`, `conflict` (acting on a session without attaching), `method_not_found`, `not_supported`, `refused`, `client_unavailable`, `timeout`, `too_large`. [doc] R-SRVAPI, R-API, [observed] LOCAL-HELP
- Transport: control connection starts with a `hello` message (client `label` documented; kind/name/platform/version appear in `client_joined` payload `info`); events carry `seq`; data streams are WebSocket `/api/data` with one-time tickets (`data.connect` args `session_id`, `block_id`, `data_ref_id` e.g. `terminal`, optional `subprotocol` e.g. `rex.data.terminal.v1`; reject `0x01` unknown/used ticket, `0x07` subprotocol mismatch; close 1008 for unknown data ref). Listener kinds: `unix`, `http`, `tailnet`, `tailnet-serve`, `login-server`. Browser WebSockets need `--websocket-origin-pattern`. [doc] R-API, [observed] LOCAL-HELP
- Auth: none beyond transport identity; `server.whoami` → `principal.kind` ∈ `peer` (uid/gid/pid), `windows_peer`, `tailscale`, `anonymous` ("for display, not authorization"). Local-only methods: `server.stop`, `server.config_reload`, `server.tailscale.*`, `server.apple.*`. [doc] R-API
- Useful methods: `server.status` (identity, session count, `host_id`, `instance_id`, `config.{generation,hash}`, `tailscale`), `server.version`, `session.list`, `session.create`, `session.attach` (→ `client_id`, `view`, `seq`), `session.attach_all`, `session.bootstrap` (`event_scope` session|all, `preferred_session_id`, `attach_session_ids`, `data_tickets` ≤8), `session.detach`, `session.list_clients`, `client.list` (filters `session_id`, `kinds`), `client.inspect`, `client.set_label`, `session.view`, `session.own_block`/`disown_block`, `block.method` (`com.superlogical.terminal.write|format|title|size|resize`), `target.resolve`. [doc] R-API, R-LUA
- CLI shortcuts for tests: `rex -S <socket> client ls --all --json`, `rex session ls --json`, `rex send -s S 'text'`, `rex capture -b BLOCK`, `rex wait`, `rex events --all --json`. Exit codes 0/1/2/3 (not found or ambiguous)/4 (server unreachable)/130. [observed] LOCAL-HELP, [doc] R-CLIDOC
- Events (`rex events --json`: `{"type","payload"}`; session events wrapped as `session_event` with `session_id` + nested `event`; terminal events wrapped in `block_event`): server `session_created`, `session_destroyed`, `client_joined` (`client{client_id, info{kind,name,platform,version}, principal, connected_at}`), `client_left`, `client_changed`, `keymap_changed`, `hosts_changed`, `tailscale_status_changed`; session `window_created/closed/label_changed`, `active_window_changed`, `block_created/closed`, `session_label_changed`, `session_view_changed{revision}`, `client_connected{client_id,principal,connected_at}`, `client_disconnected`, `client_connection_changed{connection_state}`, `creator_changed`; terminal `terminal.child_exited`, `pwd_changed`, `title_changed`, `bell`, `process_changed`, `program_status_changed`, … `block_owner_changed` exists per R-API but is not in R-EVENTS table. [doc] R-EVENTS, R-API
- Good test assertions for "two Macs share one server": `client.list` shows two `kind: app` clients; `session.list_clients` for the shared session shows both; `rex send` from client A appears in `rex capture` and in client B's data stream; `client_joined`/`client_left`/`client_connection_changed` fire. [assumption] (composition of documented primitives)

### 1.6 Lifecycle, survival, persistence

- Personal server autostarted by a `rex` command "stops about 10 seconds after its last session and last connection close"; one started with `rex server start` keeps running (start is idempotent; options apply only to a newly launched server). `rex server run --exit-empty` is the foreground equivalent of the idle stop. [doc] R-MODES, [observed] LOCAL-HELP
- Sessions keep running with no clients attached ("keeps running whether or not a client is viewing it"). [doc] R-CLIDOC
- `rex server stop` "ends every program running in the server's sessions"; `--if-idle` (exit 1 if not idle, 4 if server too old), `--discard` "deletes saved sessions after the stop". `rex server start/run --restore` (default true) "restore the saved sessions (false starts without them and saves nothing)", `--state-dir DIR`. So **session structure is saved and restored across server restarts; the processes inside are not** (stop ends programs). [observed] LOCAL-HELP, [doc] R-CLI. Docs do not describe what exactly "saved sessions" restores (labels/layouts vs scrollback). [assumption] layout + cwd, not process state.
- Upgrades: Mac app and server need not match; too-new/too-old is refused with "update the server"/"update the client". Shared server upgrade restarts `rex.service` and ends sessions; login-server account servers survive. [doc] R-UPGRADE
- Limits: `--max-sessions 64`, `--max-blocks 1024`, `--max-windows 64`, `--max-panes 64` defaults. Socket mode default `0600`. Personal socket `$XDG_RUNTIME_DIR/rex` or `~/.local/state/rex/run` (matches `/vercel/.local/state/rex/run/server.sock` here). [observed] LOCAL-HELP, [doc] R-MODES
- rex-cloud today: `bootstrap.py` runs `rex server start --json` then finds/creates a session labelled with the computer name; terminals do not survive a sandbox stop (README: "Terminals restart as fresh shells"). [observed] `assets/bootstrap.py`, README

### 1.7 Cross-check with local `--help`

- All flags quoted in 1.3/1.6 appear verbatim in `rex server start --help` / `rex server run --help` on this machine (`--tailscale`, `--tailscale-hostname`, `--tailscale-control-url`, `--tailscale-auth-key-file`, `--tailscale-advertise-tag`, `--tailscale-allow-tailnet-members`, `--tailnet-allow-identified`, `--tailscaled-socket`, `--allow-anonymous`, `--extra-listen unix|http|tailnet|tailnet-serve|login-server`, `--restore`, `--state-dir`, `--exit-empty` (run only), `--env` (start only)). [observed]
- Top-level commands present: `client`, `events`, `api`, `hosts`, `home`, `whoami`, `login-server`, `server tailscale`. `rex client --help`: "A client is one program connected to the server, such as Rex.app or this command… a person may give it a label." `rex events --help`: `--all` "including clients joining, leaving, and changing". [observed]
- Global `-S/--server` accepts "a host's label or a server address (a value with a port is always an address)"; `-C/--client`; `--autostart` default true; `--timeout 10s`. [observed]

---

## 2. Vercel Sandbox

### 2.1 Authentication & scope

- Two methods: **OIDC token** (`VERCEL_OIDC_TOKEN` via `vercel link` + `vercel env pull`; expires after 12 h locally; automatic on Vercel) and **access token** (`VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`; pass all three or none to SDK calls). [doc] V-AUTH, V-SDK
- SDK `Credentials { token, projectId, teamId }`; `inferScope()` reads `.vercel/project.json` else tries `defaultTeamId` then hobby teams the user owns; there is an OAuth device flow (`auth/oauth`, `pollForToken`). [observed] LOCAL-SDK `utils/get-credentials.d.ts`, `auth/*.d.ts`
- Sandboxes are scoped to a **project**; names unique per project; anyone with API access to the team/project can `Sandbox.get({name})` — there is no per-user ACL below project level. [doc] V-PERSIST (name scope) / [assumption] (ACL). rex-cloud compensates with the owner-hash name prefix and `owner`/`sharing` tags. [observed] `src/identity.ts`, `src/cloud.ts`
- REST: `GET /v2/sandboxes/{name}?projectId=&teamId=[&resume=]` returns `{ resumed, routes, sandbox{ name, status ∈ running|stopped|stopping, currentSessionId, currentSnapshotId, expiresAt ("Only present while a session is running"), timeout, persistent, keepLastSnapshots, snapshotExpiration, tags, … }, session{ id, status, timeout, startedAt, requestedStopAt, … } }`. [doc] V-REST-GET (confirms the `sandbox.expiresAt` observation in PROGRESS.md)

### 2.2 Persistent (named) sandboxes & snapshots

- Persistence is the default; `persistent:false` opts out. Two-level model: **sandbox** (long-lived, named) → **sessions** (one VM boot each). On stop (manual or timeout) the filesystem is snapshotted automatically; resume boots a new session from the latest snapshot "with a fresh session timeout". [doc] V-PERSIST
- **What is restored: filesystem (and installed packages/"environment configuration") only.** Sandbox configuration is reapplied. Processes/memory do not carry over (the docs use `onResume` to restart servers; "Running processes have ended" in rex-cloud README). [doc] V-SNAP, V-KB, V-SDK; [assumption] on memory (not explicitly stated, but implied by "filesystem")
- Ports/routes: `routes` are returned per session; `update({ports})` is the full desired list. [doc] V-REST-GET, V-PERSIST
- `Sandbox.get({name, resume:false})` returns a handle without starting a session; any SDK call needing a VM auto-resumes (`withResume` retries on 410 stopped / 422 `sandbox_stopping` / 422 `sandbox_snapshotting`). `stop()` and `update()` never auto-resume. `getOrCreate` ignores creation params for an existing name. [doc] V-PERSIST, [observed] LOCAL-SDK `sandbox.js`
- Retention: snapshots expire 30 days after last use by default; `snapshotExpiration` (0 = never), `keepLastSnapshots{count 1–10, expiration, deleteEvicted}`; sandboxes that cannot resume (no snapshot) are removed after 14 days of inactivity. Snapshots are region-bound. [doc] V-PERSIST, V-SNAP, V-PRICE
- Status values: `pending | running | stopping | stopped | failed | aborted | snapshotting` (session); named sandbox `status` enum documented as `running|stopped|stopping`. [observed] LOCAL-SDK, [doc] V-REST-GET

### 2.3 `extendTimeout` semantics

- SDK: `sandbox.extendTimeout(duration: number /* ms */, opts?) → Promise<void>`; doc comment: "extend the lifetime … up until the maximum execution timeout for your plan"; example `create({timeout: 10m})` + `extendTimeout(5m)` → "a total of 15 minutes" (**additive**). `sandbox.extendTimeout` goes through `withResume`, so calling it on a stopped persistent sandbox **resumes it (new session)**; use `sandbox.currentSession().extendTimeout()` to extend only a running VM. Returns nothing; read `sandbox.expiresAt` / `Sandbox.get` for the new deadline. `sandbox.timeout` (saved default) is unchanged. [observed] LOCAL-SDK `sandbox.d.ts`, `session.d.ts`, `sandbox.js`; [doc] V-SDK
- REST: `POST /v2/sandboxes/sessions/{sessionId}/extend-timeout` body `{ duration }` (ms, **minimum 1000**); "The session must be active and able to accept commands. The total timeout cannot exceed the maximum allowed limit for your account." Response `{ session{ id, status, timeout, … } }` — `session.timeout` is the new total ("The maximum amount of time the sandbox will run for"); no `expiresAt` in this response (compute `startedAt + timeout` or re-GET the named sandbox). Error statuses listed: 400 (invalid body/query), 401, 403, 404, 410, 422, 429, 500 (410 = session stopped per SDK's `isSandboxStoppedError`; 422 codes `sandbox_stopping` / `sandbox_snapshotting` observed in SDK). The exact error code for "exceeds plan maximum" is **not documented**. [doc] V-REST-EXT, [observed] LOCAL-SDK `api-client.js`
- CLI `sandbox extend <name> <duration>`: "The duration is additive. The sandbox must have a running session; this command doesn't resume a stopped one." On stopped: `Sandbox my-sandbox has no running session to extend.` [doc] V-CLI, V-WORK
- `update({timeout})` sets the saved default and, if the running session's timeout is lower, extends the live session by the difference (SDK computes `params.timeout - session.timeout` and calls `extendTimeout`); lowering never shortens. [doc] V-PERSIST, V-CLI; [observed] LOCAL-SDK `sandbox.js` ~L1093
- Open question: is the plan cap measured on the session's **total** `timeout` (i.e. 24 h from session start) — REST text says "total timeout cannot exceed the maximum", SDK says "up until the maximum execution timeout for your plan". [doc] Both imply **total per session ≤ plan max**, so on Pro a 20 h session can be extended by at most ~4 h; a `rex-cloud extend --by 2h` must clamp to `planMax - session.timeout` and surface a clear error otherwise. [assumption] on behaviour when the request exceeds the cap (reject vs clamp) — needs a live test.

### 2.4 Plan limits & pricing (iad1 rates)

- Max **session** duration: Hobby 45 min, Pro 24 h, Enterprise 24 h (raised from 5 h on 2026-06-16); default timeout 5 min; the limit "applies to a single session, not to the sandbox itself", resets on each resume. [doc] V-PRICE, V-CHG24
- Concurrency: Hobby 10, Pro/Enterprise 10,000. Resources: Hobby ≤4 vCPU/8 GB, Pro ≤8 vCPU/16 GB, Enterprise ≤32 vCPU/64 GB; 64 GB ephemeral disk; 15 open ports. Control-plane quota 1k/10k/100k req/min. [doc] V-PRICE
- Pricing (Pro/Ent): Active CPU $0.128/h, Provisioned Memory $0.0212/GB-h (1-min minimum), Creations $0.60/1M, Snapshot storage $0.08/GB-month, egress $0.15/GB (Enterprise; Pro included in Flat Rate CDN); downloads free. Hobby included: 5 CPU-h, 420 GB-h, 5,000 creations, 15 GB snapshots. Example: idle 1 vCPU/2 GB all day ≈ $1.05/day, ≈ $31/30 days (memory dominates); rex-cloud's 2 vCPU/4 GB ≈ 2×. [doc] V-SBX, V-PRICE

### 2.5 Interactive WebSocket (used by the bridge)

- `sandbox.openInteractive()` / `session.openInteractive()` → `POST /v2/sandboxes/sessions/{id}/interactive` → `{ url, token }` for a "controller-hosted PTY"; "Treat `token` as a credential and close the WebSocket when finished." `interactivePort` is a session field. [observed] LOCAL-SDK `api-client.js`, `validators.d.ts`; [doc] V-SDK
- rex-cloud sends `{type:'start', command:'python3', args:[..relay.py.., remoteSocket], cols, rows}` then pipes binary frames ↔ the local Unix socket; each Mac/each local client connection opens its own WebSocket+relay. Both Macs therefore reach the **same** in-sandbox Rex Unix socket as independent Rex clients. [observed] `src/bridge.ts`, `assets/relay.py`

---

## 3. Tailscale (only as relevant to Rex's embedded node)

- Auth keys: one-off (auto-revoked after use) vs reusable; options ephemeral, pre-approved, tagged, pre-signed; key expiry 1–90 days (default 90); a key-joined device takes the generating user's identity unless tagged. Only Owners/Admins/IT/Network admins can generate; API/OAuth-client creation possible. [doc] T-KEYS
- Node key expiry default 180 days; tagged devices have expiry disabled by default; re-auth with `tailscale up --force-reauth`. For Rex's embedded node this means a user-owned `rex` node will need re-login every 180 days unless expiry is disabled per device. [doc] T-EXPIRY, T-TAGS
- Tags: device identity is user **or** tag, never both; tagged devices are "service accounts", need `tagOwners` in policy; this is why Rex requires `--tailscale-allow-tailnet-members` for tagged nodes (no owner to match). [doc] T-TAGS, R-REMOTE
- Ephemeral nodes: auto-removed 30–60 min after going offline, get a new IP on recreation; created only via ephemeral auth key or `tailscaled --state=mem:`; metered minutes. Relevant if the sandbox's tsnet state dir is lost on stop (state dir is on the sandbox filesystem, so it *is* snapshotted). [doc] T-EPH; [assumption] state persistence via snapshot
- HTTPS certs for `rex.<tailnet>.ts.net` need MagicDNS + HTTPS enabled; LE DNS-01; names end up in public CT logs; LE rate limits if re-requested often (a fresh tsnet state each boot would re-request). [doc] T-HTTPS; [assumption] re-request on lost state
- tsnet has a userspace network stack and does not need `tailscaled`. [doc] T-TSNET. Vercel Sandbox explicitly supports "VPN clients" as system-privileged workloads, so a userspace tsnet node should run. [doc] V-SBX; [assumption] untested in Firecracker here

---

## Implications for rex-cloud

| Axis | (A) Existing authenticated Vercel bridge for both Macs | (B) Rex built-in Tailscale (`rex server start --tailscale`) |
|---|---|---|
| Install effort | Each Mac: `npm i -g rex-cloud`, Vercel login, same team/project, paste the printed socket path once into **Add Remote Host**. No extra accounts. [observed] README | Each Mac: Tailscale account + client logged in; tailnet must have MagicDNS + HTTPS enabled; sandbox side needs a one-time auth key file (or interactive login URL from `rex server status`); then add `https://rex.<tailnet>.ts.net` once (GUI accepts URLs, so `hosts.put`/`rex.host` automation becomes possible). [doc] R-REMOTE, T-HTTPS |
| Reconnect | Helper re-opens `openInteractive` per local connection; the Rex server sees a reconnect with the same `client_id` within 60 s of `lost`. Dependence on Vercel control plane + 15 s handshake. After a sandbox stop, the bridge must wait for a new session (new `sessionId`). [observed] `src/bridge.ts`, [doc] R-API | Mac connects directly over WireGuard; the Rex app "reconnects to them at launch until you remove them". Survives rex-cloud not running on the Mac. After sandbox stop/resume the tsnet node must re-register (state dir is on the snapshotted FS, so same node key if kept; if lost, new device + possible device approval + new cert → slower). [doc] R-PRIVACY, T-KEYS, T-HTTPS; [assumption] state survives snapshot |
| Identity / auth | Vercel team/project access gates `openInteractive`; inside the sandbox every relay is `peer` uid of the sandbox user — Rex cannot tell Mac A from Mac B except by client label. [observed] relay.py, [doc] R-API | Rex sees `tailscale` principals (`login_name`, `node`); default admits only the signing-in user (both Macs of one person qualify); `--tailscale-allow-tailnet-members` + ACLs for others; login-server principals could map tailnet users to accounts. Tailscale is the only listener Rex calls "identified" without SSH. [doc] R-REMOTE, R-LOGIN, R-API |
| Exposure risk | No inbound network listener in the sandbox; Rex stays on a `0600` Unix socket. Attack surface = Vercel API token on each Mac and the interactive WS token (treat as credential). [doc] V-SDK, [observed] LOCAL-HELP | Adds a tailnet-reachable HTTPS listener with full shell power ("A connection has the same power as the server's account"). Hostname published in CT logs; Tailscale receives connection metadata; a leaked reusable/tagged auth key = shell access until revoked. [doc] R-REMOTE, T-HTTPS, T-KEYS, R-PRIVACY |
| Lifecycle | Bound to the Vercel session: stop/timeout kills Rex and terminals; `rex-cloud extend` can push `expiresAt` up to the plan cap per session (additive, ≥1 s, must be running). Both Macs see the same deadline via `GET /v2/sandboxes/{name}`. [doc] V-REST-EXT, V-REST-GET | Same sandbox lifecycle, plus Tailscale node lifecycle (key expiry 180 d unless disabled, ephemeral removal if keyed ephemeral, cert renewal 90 d). More moving parts, nothing gained for a single-person two-Mac case. [doc] T-EXPIRY, T-EPH, T-HTTPS |

Recommendation (draft): keep (A) as the default; it already yields shared live terminals (both Macs are independent clients of one personal server, block size follows the owner). Offer (B) later as an opt-in `--tailscale` for users who want Rex-level identity or iOS access. Implement `rex-cloud extend <name> [--by 2h]` with `Sandbox.get({name, resume:false})` → require `status==='running'` → `currentSession().extendTimeout(ms)` (never the parent-handle method, to avoid an accidental resume) → re-GET and print the new `expiresAt`; clamp/explain against `planMax - session.timeout`.

### Open questions (need live tests, not docs)
1. Does `extendTimeout` reject (which code?) or clamp when `session.timeout + duration > plan max`? [assumption]
2. Does the Mac GUI list hosts added via `hosts.put`/`rex hosts add`/`rex.host{}` on the Mac's local server (docs conflict)? Can a `http://127.0.0.1:PORT` endpoint replace the pasted Unix path?
3. How does a non-owner Mac render a terminal whose owner has a different pane size (reflow vs fixed grid)? Is ownership auto-claimed by the Mac app on focus?
4. Does `rex server start --restore` (default) restore layouts across a sandbox stop/resume if the state dir is on the snapshotted filesystem? (Processes certainly do not survive.)
5. Does tsnet start inside Firecracker with the universal image (userspace stack, needs outbound UDP/443 to DERP/control)?
