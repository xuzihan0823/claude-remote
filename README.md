<div align="center">

<img src="app/assets/icon.png" alt="claude-remote" width="96" />

# claude-remote

**View and continue Claude Code sessions on your iPhone, and respond to approval requests from a Mac or Linux host.**

**English** · [简体中文](README.zh-CN.md)

[![Node](https://img.shields.io/badge/node-%3E%3D22.13.0-339933?logo=node.js&logoColor=white)](package.json)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%2B%20iOS-000000?logo=apple&logoColor=white)](#quick-start)

[Quick start](#quick-start) · [Deployment guide (Chinese)](docs/deployment.md) ·
[Screenshots](docs/screenshots.md) · [Architecture](#architecture) ·
[Security](#security) · [Self-hosted Relay (Chinese)](deploy/relay/README.md) ·
[CLI reference](#cli-reference) · [Development](#development)

<img src="docs/images/hero.webp" alt="Claude Remote app screenshots" width="94%" />

</div>

- **Follow sessions live.** Watch output, choose a model and reasoning effort, and send messages with image or file attachments.
- **Move between phone and terminal.** Both use the same session history. Use `cr open <id>` to resume in the terminal. The iPhone waits while a terminal process owns the session.
- **Respond to approvals.** Review tool requests and answer questions on your phone. Pending approvals are denied on timeout, cancellation, or daemon restart.
- **Connect over LAN, Tailscale, or Relay.** Enable multiple routes and let the app prefer a direct connection in automatic mode. A self-hosted Relay lets the host connect outbound.

## Quick start

The host needs macOS or Linux, **Node.js 22.13.0 or later**, and an installed and signed-in Claude Code CLI.

1. On the host, install and start `cr`.

   ```sh
   npm install -g @anyyu/claude-remote
   cr
   ```

2. Pick a network route. Keep the daemon running during pairing.

   - **Tailscale Serve:** Sign the host and iPhone into the same tailnet, then run `cr pair --tailscale` on the host.
   - **Same Wi-Fi:** Run `cr config set host 0.0.0.0` and restart the daemon as prompted.
   - **Self-hosted Relay:** [Deploy Relay on a public Linux server](deploy/relay/README.md), then run the generated `cr relay add` command on the Claude Code host.
3. Download the [latest iPhone `.ipa`](https://github.com/xuzihan0823/claude-remote/releases/latest). Sign it with your own signing setup before sideloading it.
4. Run `cr pair` on the host and scan the QR code. If you set up Tailscale Serve with `cr pair --tailscale`, you can scan the QR code from that command.

### Set up with a terminal agent

Copy this prompt into a terminal agent such as Claude Code or Codex:

```markdown
Help me deploy and pair claude-remote from https://github.com/xuzihan0823/claude-remote. Stop when you need my approval, a sign-in, or a manual step.

1. Ask whether the target is this machine or a remote macOS or Linux host. For a remote host, confirm the SSH address or alias and verify access. Run the remaining host steps on the chosen machine.
2. Check the OS with uname -s. Check that Node.js is at least 22.13.0 and that claude --version works. If a prerequisite is missing, tell me what to install or upgrade. Leave the system Node.js installation to me.
3. If cr is missing, run npm install -g @anyyu/claude-remote. If I explicitly request a source install from the repository, run pnpm install and node packages/cli/bin/cr.mjs setup instead. Run cr setup to initialize the token and detect Claude Code. On macOS, ask whether I want launchd to keep the daemon running and enable it with cr config set autostart on if I agree. Otherwise keep cr open, or run cr up in the foreground. On Linux, suggest tmux or screen for a persistent terminal.
4. Ask which network route I want:
   - Tailscale Serve: Check tailscale status and have me sign the host and iPhone into the same tailnet if needed. With the daemon running, run cr pair --tailscale. If Tailscale asks for browser approval to enable HTTPS, stop and show me the approval link.
   - Same Wi-Fi: Run cr config set host 0.0.0.0, restart the daemon as prompted, then run cr pair.
   - Self-hosted Relay: With my approval, run curl -fsSL https://raw.githubusercontent.com/xuzihan0823/claude-remote/main/deploy/relay/install.sh | sudo bash on my public Linux server. Check that ports 443 and 80 are available as required. Run the generated cr relay add command on the Claude Code host, then run cr pair.
5. Point me to the latest iPhone IPA in GitHub Releases so I can sign and install it, then have me scan the pairing QR code.
```

The [deployment guide (Chinese)](docs/deployment.md) covers manual setup and building the iOS app from source.

## Architecture

```text
iPhone app (app/ + web/core/)
    │ HTTP and WebSocket with a bearer token
    ├── Direct: LAN, Tailscale, or mDNS
    └── Relay: https://<RELAY_HOST>/d/<deviceId> (packages/relay)
                                             ▲ outbound connection
Host daemon (packages/daemon) ─── connector ──┘
    ├── Reads ~/.claude/projects/**/*.jsonl
    ├── Resumes sessions through the Agent SDK (packages/agent-bridge)
    └── Tracks approval requests in SQLite (packages/interactions)

cr (packages/cli) runs the terminal console and manages the daemon, pairing, and Relay.
```

The daemon exposes HTTP APIs, WebSocket, and local pairing endpoints. The root URL and static web routes return `404`.

## Security

| Area | Behavior |
| --- | --- |
| Session history | The daemon reads JSONL on the host. Claude Code writes session history as part of its normal operation through the Agent SDK. |
| Approvals | Pending approvals are denied on timeout (300 seconds by default), cancellation, or daemon restart. |
| Authentication | The app uses a randomly generated bearer token (`BRIDGE_TOKEN`). |
| Pairing | `/api/pair-info` and `/api/pair-qr.svg` are for loopback access. Relay requests and requests with recognized proxy headers are rejected. |
| Self-hosted Relay | TLS terminates on your Relay server, which can see the token and session traffic. Use a server you control. |

## CLI reference

Run `cr` for the full-screen console. It supports browsing and searching sessions, live output, approvals, pairing, and logs. Press `?` for keyboard shortcuts.

| Command | What it does |
| --- | --- |
| `cr` | Open the console and initialize it on first run. |
| `cr setup` | Check initialization and detect the Claude Code executable. |
| `cr pair [--tailscale]` | Print a pairing QR code and connection addresses. Add `--tailscale` to configure Tailscale Serve. |
| `cr status` | Show daemon, launchd, connection, and session status. |
| `cr up` / `cr down` / `cr restart` | Start, stop, or restart the daemon. |
| `cr config` | View or change settings such as `host`, `port`, `bark`, `ntfy`, and `autostart`. |
| `cr relay add\|status\|on\|off\|remove` | Manage self-hosted Relay connections. |
| `cr ls [-n 20]` / `cr search <term> [--full]` | List recent sessions or search them. Use `--full` to search message text. |
| `cr show <id>` / `cr open <id>` | Read recent messages or resume the session in the terminal. |
| `cr logs` | Follow daemon logs. |

## Development

```sh
git clone https://github.com/xuzihan0823/claude-remote.git
cd claude-remote
pnpm install
node packages/cli/bin/cr.mjs setup
```

Source installs use `.env` at the repository root (see [the example](.env.example)). The setup command links `cr` into `~/.local/bin`. Global npm installs use `~/.claude-remote/config.env`.

Run `pnpm dev` to start the daemon from source. The mobile app has its own npm dependencies under `app/`. Expo generates the iOS project in `app/ios/`.

```sh
pnpm typecheck
pnpm test
pnpm build:npm
```

The npm build writes to `dist/npm/`. The legacy command `pnpm test:web` runs the shared logic tests in `web/core/`.

| Path | Contents |
| --- | --- |
| [app/](app/) | React Native and Expo iPhone app |
| [docs/](docs/) | Deployment, screenshots, and architecture notes |
| [packages/](packages/) | CLI, daemon, Agent SDK bridge, approvals, and Relay |
| [web/core/](web/core/) | Shared mobile networking, session state, and tests |
| [web/vendor/](web/vendor/) | Vendored JavaScript and license notices |
| [deploy/relay/](deploy/relay/) | Relay installer and Docker, Caddy, and systemd configuration |
| [scripts/](scripts/) | npm packaging, launchd entry point, and session repair |

## License

Project code is available under the [MIT License](LICENSE). Third-party code remains under its own licenses. See [vendored JavaScript licenses](web/vendor/README.md) and [iOS third-party notices](app/THIRD-PARTY-NOTICES.txt). The Claude Agent SDK is installed separately by npm and is subject to [Anthropic’s terms](https://code.claude.com/docs/en/legal-and-compliance).

## Friends

[Linux.Do](https://linux.do/) — A new ideal community
