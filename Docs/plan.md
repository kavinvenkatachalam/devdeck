# devdeck plan

Light, self-contained dev cockpit for ToolJet work. Personal first, team later.

## Model

A **session** is the main thing: one terminal in any folder — home, a project, or a worktree. When
its folder is a git repo it gains Changes and Code; when it's a ToolJet checkout it gains Env. Worktrees are a
feature a session can use, and have their own list for managing environments without a session.

## Status

| Step | State |
|---|---|
| Sessions, tabs, terminal, PWA (desktop + phone) | done |
| New session: existing folder or new worktree; optional set up / start | done |
| Env lens: Set up & start · Start · Stop all · Restart, live step checklist + log | done |
| Bundled env engine (worktree, submodules, .env/ports/DBs, deps, plugins, db:setup, servers) | done |
| Dev login + license (one key in Settings, applied on every start) | done |
| Env card: ports, login, workspace, license terms, users / workspaces / apps, logs | done |
| Remove worktree (unsaved-work check, stop, drop DBs, remove) | done |
| Changes lens (uncommitted / whole branch, incl. EE submodules) | done |
| Code lens (code-server under /code/, or open VS Code on the Mac) | done |
| Redesign: worktree-first list, New = worktree / open existing, Lucide icons, phone list → detail with bottom tabs | done |
| Projects setting accepts a repo, a worktree or a parent folder (case-insensitive paths) | done |
| Tools: CLIs, shell tools, skills | done |
| Safe stop: only processes inside the worktree; kills.log | done |
| Settings: license, dev login, folders, Tailscale share on :8444 | done |
| Claude / Codex status dots (working / needs you / idle), read off the screen | done |
| PR per worktree: badge in the list, card with checks / review / conflicts | done |
| `devdeck` command: start in background, stop, restart, status, logs | done |
| Plugins build reuse copies the generated entry files too | done |
| Boards: named, pin popover, reorder (drag), zoom, columns, rename / delete; carousel on the phone | done |
| Terminal-native redesign: mono, panels, breadcrumb top bar, status bar, ⌘K palette, compose box, overview, session colors | done |
| Light / dark / system theme; visual refresh | done |
| Overview = needs you (waiting agents, blocked PRs) · recent sessions · boards · active worktrees; quieter sidebar rows; empty Boards panel hidden until a drag | done |
| One terminal per session (tabs split into sessions); split views (boards) removed | done |
| Folder tabs above the terminal (switch, ⌘/⌃1–9, +, ✕); sessions.log | done |
| Push notifications | later |
| PWA: PNG + maskable icons, install button, offline page; copy text on the phone | done |
| Auto-start at login (`devdeck autostart on`, a LaunchAgent) | done |
| Review fixes: host / Tailscale-user check, Running = port answers, per-folder DBs for detached worktrees, Claude hooks for status, terminal backpressure and reconnect in place, shared list refresh, UI split into modules, tests | done |
| Open the running ToolJet app from the phone | later (it binds to the Mac's localhost) |
| Team mode: agent per Mac + shared server, auth | later |
| Mac app (Tauri wrapper) | later; install as an app from Chrome meanwhile |

## Decisions

- Node + TypeScript run directly (`--experimental-strip-types`); runtime deps: `ws`, `node-pty`; UI: Preact + htm, xterm.js, plain CSS, all served from `node_modules` (no CDN).
- Own tmux socket `devdeck`; only sessions tagged `@dd_path` are listed (rk's shim adds `_rk-ctl`).
- Terminals get a whitelisted environment (HOME, PATH, LANG…) so the launcher's `CLAUDE_CONFIG_DIR` etc. never leak in.
- DB names match tj's (`tooljet_<slug>_<hash>`), so worktrees tj set up are recognised; tj's ports and run files are read too.
- An unconfigured worktree never acts on the default ports (3000/8082 belong to the main checkout).
- Removing a worktree only drops DBs derived from its branch, never the main checkout's.
- Every request (pages, API, WebSocket, /code) must be addressed to localhost or the Mac's Tailscale name, not come from another site, and over Tailscale come from the Mac's own Tailscale user (src/access.ts).
- Agent status: Claude's hooks when set up, the screen otherwise; the screen always supplies prompt options (src/tmux.ts `combine`).
- Tailscale: devdeck only ever adds :8444, never the tailnet's main URL.
