# devdeck

A light dev cockpit for ToolJet work, on your Mac and your phone:

- **Sessions first** — a session is one terminal in any folder: your home folder for a quick look or a discussion, a project, or a worktree. Name it ("claude fix-modal", "server"), rename it, open it from the Mac or the phone. Another terminal in the same place is another session: + on its row (or ⋯ → New session here). Where a session starts (or moves to) is picked from your checkouts and project folders, or with Browse, by clicking through any folder on the Mac (the one you're in is the one chosen). Started one in the wrong place? ⋯ → Run in another folder… points it at another folder or worktree: an idle shell cds there; a running program (Claude, a server) keeps its folder until you restart it, while devdeck's Changes, Code and Env switch at once.
- **New session** — one screen: name, sidebar folder (defaults to the open session's), and where it starts (defaults to what's open); Enter creates. *New worktree* is the other tab (branch, optional "Start dev environment").
- **Per session:** Terminal always; Changes and Code when the folder is a git repo; Env when it's a ToolJet checkout (set up / start / stop / restart, sign-in, license, live logs; each server start begins a new log and the last 5 runs stay pickable).
- **Your own folders** — the sidebar groups sessions in folders you make (named groups, not folders on disk). Each session row shows where it runs (branch or path), changes, servers and PR. **Worktrees** (sidebar footer) lists every checkout with its env, changes and code.
- **⌘K palette** (the search icon, top right) — jump to any session or worktree; new session / worktree; theme.
- **Phone typing** — you write in the message box under the terminal (a tap on the terminal opens it; phone keyboards type badly straight into a terminal): Return sends it as one paste plus Enter, with no autocorrect or auto-capitals. The keys row (esc, tab, ^C, arrows…) sends without closing the keyboard. When the connection drops (the phone slept, the network changed), the terminal reconnects on its own and anything typed meanwhile is sent once it's back. Drag a finger on the terminal to scroll, like a mouse wheel: back through its history in a shell, or through Claude's conversation in its full-screen mode (a flick glides; back at the bottom the shell is live again). While the keyboard is up, the header, tabs and bottom bar step aside so the terminal keeps most of the screen (on iPhone too, which doesn't resize the page for the keyboard).
- **Quick replies** — when Claude or Codex asks (a permission or a question), its numbered options show as buttons above the terminal and in the Overview's "Needs you"; one tap answers, Esc cancels.
- **Files into the terminal** — drop files on a terminal, or paste a screenshot / copied file: they're saved under `~/.local/state/devdeck/uploads/` (cleared after a week) and the terminal gets their paths, so Claude attaches images.
- **Status bar** — branch, PR, changes, agent state, servers and folder of what's open; CPU, memory and disk of the Mac.
- **Overview** (desktop home) — what needs you (agents asking, PRs with failing checks / conflicts / changes requested), recent sessions, active worktrees.
- **Folder tabs** — the open session's sidebar folder (or, outside folders, all sessions outside folders) shows as tabs above the terminal, even when it's the only one: click to switch, ⌘1–9 / ⌃1–9 to jump (outside the installed app Chrome keeps ⌘1–9 for its own tabs), + for a new session in the folder, ✕ to end one.
- **Sidebar** — folders (optional, just to group) › sessions. Hover a session for + (new session here) and ⋯ (rename, move to a folder, end), a folder for a new session and ⋯ (rename, delete). Double-click a session or a folder's name to rename it (a click on a folder only opens or closes it); the session and folder names in the header and the folder tabs above the terminal rename the same way. Drag a session into a folder, between sessions to reorder, or out of its folder. A session that has several tmux windows (an older devdeck's tabs, or tmux's own new-window) is split into one session per window.
- **Theme** — System / Light / Dark (sidebar footer, or Settings → Appearance).
- **Terminal** — xterm 6 with the WebGL renderer, Unicode 15 widths (Claude's symbols line up), clickable links, ⇧Enter for a new line in Claude / Codex, ⌥ as Meta, selections copied to the clipboard on release (tmux's, and Claude's own in its full-screen mode, both arrive as OSC 52 with tmux's empty target, which devdeck accepts), ⌥-drag + ⌘C for a browser selection.
- **Claude status** — sessions running Claude / Codex show a dot: blue = working, amber = needs you (a permission or question prompt), green = idle. The browser tab title shows how many need you: `(2) devdeck`.
- **Pull requests** — each worktree heading shows its branch's PR (`#18564`, colored: green passing, amber checks running, red failing / conflicts / changes requested, grey draft, purple merged). The worktree page has the PR card with checks, review, conflicts and links to failing runs. A merged or closed PR keeps showing until the worktree has commits made after it closed (then it's new work). Uses your `gh` login and polls GitHub only as often as the state needs (checks running: 1 min, open: 2 min, no PR: 5 min, merged: 30 min); a webhook isn't possible for a local app. Branches never pushed to GitHub (not on a remote, not tracking one) are never asked about. The page itself refreshes every 5 s (paused while the tab is hidden); that stays on the Mac.
- **Code** — code-server opens only the session's folder (worktree detection and `.worktrees/` hidden), without the AI chat panel. It follows whichever editor the Mac's user has (VS Code, Insiders, Cursor or VSCodium): settings, keybindings, snippets and tasks are linked, and missing extensions are installed from Open VSX on their own (ones Open VSX lacks are skipped). Light or dark follows devdeck's theme switch (your editor's preferred light/dark themes if set, else VS Code's defaults); the terminal follows it too. Open it in its own tab from ⋯.
- **Tools** — installed CLIs, shell aliases/functions. **Settings** — projects, license, dev login, phone access.

## Run

```bash
npm install
ln -s ~/Work/devdeck/bin/devdeck ~/.local/bin/devdeck   # once: puts `devdeck` on your PATH
devdeck                # starts in the background, prints the Mac and phone URLs
```

`devdeck stop` · `devdeck restart` · `devdeck status` · `devdeck logs` · `devdeck open` (browser) · `devdeck run` (foreground).
Stopping devdeck leaves your terminals and ToolJet servers running. Starting it also makes sure the phone URL (Tailscale :8444) is shared.

Options: `PORT=4317`, `HOST=127.0.0.1`, `DEVDECK_CODE_PORT=4318`. `npm run check` type-checks. Icons are a Lucide sprite (`public/icons.svg`), rebuilt with `node scripts/icons.mjs`.

Needs on the machine: Node (devdeck runs on any 22.x; ToolJet commands use the checkout's `.nvmrc` version from nvm), git, tmux, Postgres and Redis for ToolJet, and a `.env` in the main ToolJet checkout.

## Phone

devdeck only listens on localhost. Reach it over Tailscale (or use **Settings → Share devdeck on :8444**):

```bash
tailscale serve --bg --https=8444 http://localhost:4317
```

Its own HTTPS port (8444) keeps the main tailnet URL free for HexoKit. Open `https://<mac>.<tailnet>.ts.net:8444` on the phone, then **Add to Home Screen**.
There is no login: anyone on your tailnet can open it, so keep the tailnet to your own devices.

## How it works

- Sessions live in devdeck's own tmux server (`tmux -L devdeck`), so they survive closing the browser or restarting devdeck. Terminals start with a clean login-shell environment.
- Claude status is read off the terminal's screen (`esc to interrupt` while working; `Do you want to proceed?` / `Enter to select` / Codex's approval prompt when it needs you), so it works with any account or alias and needs no hooks.
- The dev-env engine is bundled (no `tj`/ToolBelt needed) and follows `tools/tj`: `.env` with free ports and per-branch DBs (same names as tj), deps copied copy-on-write from another checkout when the lockfile matches (a whole folder in one `clonefile` call via the system Python when Apple's command line tools are installed, else `cp -c` file by file), `db:setup`, then `start:dev` / `npm start`. After the server is healthy it creates the dev admin (`setup-super-admin` → `onboarding/finish`) and applies the license (`PATCH /api/license`).
- It recognises servers started by tj or by hand in a worktree's terminal, and Stop stops those too. It only signals processes whose working directory is inside that worktree (a process group shared with anything else is stopped pid by pid), and logs every signal to `~/.local/state/devdeck/kills.log`.
- Light on the Mac: nothing runs in the background while no devdeck page is open. With one open it uses well under 1% of a core and ~70 MB: the page refreshes every 5 s (paused when hidden), `git status` (the costly part on a big repo) reruns every 30 s only for checkouts with a session or servers and every 10 min for the rest, env status every 5 s on the Env tab only (elsewhere it's re-read when the list sees a server go up or down), and GitHub as described above.
- Claude / Codex started through an alias or login shell (`zsh -lc 'claude …'`) are found by asking `ps` what runs in front of the shell, so their status works too.
- Removing a worktree is instant: its folder is moved aside, git forgets it (`worktree prune`), and the files are deleted in the background at macOS background priority (`taskpolicy -b rm -rf`), so the Mac stays responsive.
- Deleting a sidebar folder ends the sessions in it (servers keep running).
- Every session devdeck creates, splits or ends is logged with the reason in `~/.local/state/devdeck/sessions.log`.
- State and logs: `~/.local/state/devdeck/` (nothing is written into the worktrees besides `.env`). Settings: `~/.config/devdeck/settings.json` (mode 600):

```json
{
  "roots": ["~/Work/ToolJet"],
  "license": "",
  "login": { "email": "dev@tooljet.io", "password": "password" }
}
```

Plan and decisions: [Docs/plan.md](Docs/plan.md).
