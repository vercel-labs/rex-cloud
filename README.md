# Rex cloud

Run a Linux cloud terminal in Rex, backed by Vercel Sandbox. Give your computer a name, work in its Rex terminal, and use the same command to return later.

**Experimental preview.** One-time host setup in Rex is required. See [preview limits](#preview-limits) before relying on it for ongoing work.

## Start a cloud computer

You need macOS, Node.js 22 or later with npm, and a current [Rex](https://www.superlogical.com/rex) app in **Applications** with its `rex` command on your PATH. The tested minimum Rex app build is 1758. You also need a Vercel account with access to a team and permission to use Sandbox. The Sandbox CLI is not required.

Install the preview from its GitHub release:

```sh
npm install --global https://github.com/vercel-labs/rex-cloud/releases/download/v0.1.0-prototype.3/vercel-labs-rex-cloud-0.1.0-prototype.3.tgz
```

In a **local Mac terminal**, including a **This Mac** pane in Rex, run:

```sh
rex-cloud start remote
```

The launcher reuses your Vercel login or opens browser sign-in. It uses your linked project or current Vercel CLI team when available. Otherwise, it asks you to choose a team and finds or creates a `rex-cloud` project to track Sandbox usage. It asks how long the computer should run, then starts it and opens Rex.

Connect once on this Mac:

1. Choose **Add Remote Host** in Rex.
2. Paste the socket path printed by the launcher and select **Connect to…**.
3. Select **remote**, then its terminal in the sidebar.

Your cloud shell shows a prompt such as `sandbox:remote ~ $`. Run `uname -s` there to see `Linux`. Clone a repository, install your tools, and sign into your coding agent inside that terminal. Your Mac's files and running sessions stay on your Mac.

### Run without a global install

Use this command every time instead:

```sh
npx --yes --package https://github.com/vercel-labs/rex-cloud/releases/download/v0.1.0-prototype.3/vercel-labs-rex-cloud-0.1.0-prototype.3.tgz rex-cloud start remote
```

Both methods save the same setup. The package is not yet published to the npm registry, so `npx @vercel-labs/rex-cloud` is not available yet. The remaining examples use the installed `rex-cloud` command.

## Return to the same computer

Run the same command from your Mac:

```sh
rex-cloud start remote
```

| Computer state | What happens |
| --- | --- |
| The name is new | Creates a fresh computer. |
| Still running | Reconnects to its live terminals. |
| Stopped or timed out | Boots from its saved disk snapshot. Files and installed tools remain. Terminals restart as fresh shells. |

Select **remote** under the existing cloud host in Rex. Running commands, process memory, and scrollback do not survive a stop or timeout. Restart your agent or use its own conversation-resume command if it provides one.

For a fresh environment, use another name:

```sh
rex-cloud start experiment
```

Names are scoped to your Vercel user, team, and project. The default name is `dev` when you omit it. `up` is an alias for `start`. `open` reopens an existing computer and never creates one.

## Choose a duration or stop early

The launcher saves your first duration choice and shows the stop time. This preview accepts up to **45 minutes on Hobby** and **24 hours on Pro or Enterprise**. Override the saved duration for the next creation or resume:

```sh
rex-cloud start remote --timeout 45m
```

Reconnecting to a running computer keeps its current deadline. Closing your laptop does not stop cloud compute. At the deadline, the computer stops and saves its disk. Snapshot retention is subject to Vercel's [persistence limits](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes).

```sh
rex-cloud status remote
rex-cloud stop remote
```

`stop` ends running commands and saves the disk. `disconnect` only closes this Mac's connection. Neither `status` nor background connection attempts wake a stopped computer. Running computers and saved snapshots incur [Vercel Sandbox usage](https://vercel.com/docs/sandbox/pricing).

## Use an existing Vercel project

First setup reuses your existing login. For project selection, explicit flags and saved Rex cloud configuration take precedence, followed by paired `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID`, a project link, and your current Vercel CLI team.

For a project linked with `vercel link`, run from the linked directory itself. For `vercel link --repo`, run from the mapped app directory. Personal-account links fall back to team selection. Without a usable link, the launcher finds or creates `rex-cloud` in the selected team. It selects your only team automatically when there is no current team.

The selected team and project are printed before compute starts. Subsequent starts keep that saved scope even from another directory. The launcher does not run `vercel link`, deploy an app, or copy your repository. If an inferred team denies project access during interactive setup, it offers an explicit team choice.

Run `rex-cloud setup` to change the saved scope. For automation, provide your own IDs and a duration on first start:

```sh
rex-cloud setup --team team_YOUR_TEAM --project prj_YOUR_PROJECT
rex-cloud start remote --timeout 45m --json
```

`--state-dir PATH` keeps a separate local configuration. Reuse that path when reconnecting. Normal use does not need this option.

## Choose a custom image

New computers use `vercel/sandbox/universal`. To use a ready Vercel Container Registry image, choose a new computer name and replace the image reference:

```sh
rex-cloud start research --image your-team/your-project/image:tag
```

Custom images need Linux amd64, glibc, Python 3, CA certificates, and Rex's runtime libraries, including PAM. The launcher uses the image's user, home, and working directory. It preserves existing shell startup files. Image ENTRYPOINT and CMD are not run. Existing named computers keep their original image.

## Connect from another Mac or share deliberately

Install the preview on the other Mac, sign into the same Vercel user, select the same team and project, and run `rex-cloud start remote`. Add that Mac's printed host path once. Both Macs connect to the same cloud Rex server through Vercel's authenticated connection. Tailscale is not required. Physical two-Mac sleep/wake testing is still pending.

Computers are personal by default. To share a computer with other members who have project access, use `--shared` on every command:

```sh
rex-cloud start pair --shared --timeout 45m
rex-cloud stop pair --shared
```

Everyone joining that shared computer uses the same Linux user, files, and live terminals. Personal names prevent accidental joins. They do not isolate resources from Vercel project administrators.

Computers created by prototype.2 or earlier use the shared namespace. Reopen them with `rex-cloud start dev --shared`. Existing socket paths and diagnostic snapshot retention are preserved. New computers retain the latest disk snapshot.

## Fix a connection

- **Rex rejects the host path:** open the current app from Applications. An older copy running from an installer may have the same name.

- **The cloud host is disconnected:** run `rex-cloud status remote`, then `rex-cloud start remote` from your Mac. Clicking the sidebar entry alone does not wake a stopped computer.

- **Vercel cannot authorize the operation:** run `rex-cloud login` and check team/project access. Vercel login is separate from Git and coding-agent login.

- **Startup was interrupted:** run `rex-cloud status remote`. The computer may have started. Use `rex-cloud stop remote` to stop it.

Use `--no-open` to keep Rex in the background or `--json` for machine-readable output. Run `rex-cloud --help` for all options.

## How it connects

The launcher starts a Rex server inside a persistent Vercel Sandbox and exposes a private Unix socket on your Mac. A local background process carries the connection through Sandbox's authenticated interactive WebSocket to the cloud Rex socket. There is no public Rex port.

The Linux Rex executable is downloaded from Superlogical's release server and checked against a pinned checksum and the local CLI's supported API revision. Rex itself is not bundled or licensed by this repository. Dependencies bundled with the launcher are listed in `dist/THIRD_PARTY_NOTICES.txt` inside the release package.

## Preview limits

This is a prototype for testing. Automatic host registration, startup at Mac login, and migration of a running local Mac session are not implemented. Fresh-account signup through the first cloud terminal, real credential renewal, physical two-Mac sleep/wake, and a two-hour connected session still need validation. Confirmation from Superlogical for the automated server-install flow is pending.

## Develop locally

```sh
git clone https://github.com/vercel-labs/rex-cloud.git
cd rex-cloud
npm ci
npm run check
npm run test:package
npm pack
```

Tests cover authentication preservation, lifecycle decisions, private sockets, byte transport, setup selection, and isolated package installation. They do not provision a cloud computer. Local test execution needs permission to create Unix sockets. CI runs on macOS with Node.js 22 and 24.

## Uninstall

Stop computers you no longer need and disconnect local helpers first:

```sh
rex-cloud stop remote
rex-cloud disconnect remote
npm uninstall --global @vercel-labs/rex-cloud
```

Uninstalling leaves saved snapshots and local configuration intact.
