# devdeck

A light dev cockpit for ToolJet work, on your Mac and your phone:

- **Sessions first** — a session is one terminal in any folder: your home folder for a quick look or a discussion, a project, or a worktree. Name it ("claude fix-modal", "server"), rename it, open it from the Mac or the phone. Another terminal in the same place is another session: + on its row (or ⋯ → New session here). Where a session starts (or moves to) is picked from your checkouts and project folders, or with Browse, by clicking through any folder on the Mac (the one you're in is the one chosen). Started one in the wrong place? ⋯ → Run in another folder… points it at another folder or worktree: an idle shell cds there; a running program (Claude, a server) keeps its folder until you restart it, while devdeck's Changes, Code and Env switch at once. A Claude that goes to work in another worktree (one it made with `tj`, say) takes its session there on its own; moving the session back by hand sticks.
- **New session** — one screen: name, sidebar folder (defaults to the open session's), and where it starts (defaults to what's open); Enter creates. *New worktree* is the other tab: branch, where it starts from, its database, and optional "Start dev environment". **Start from** is main (the new branch starts from origin's latest default branch) or one of your worktrees (from its branch's commits), and the database comes from the same place; **Another branch…** takes any branch name, with main's database (as does a worktree not set up yet). **Database**: **Same** (the default) uses those databases as they are (quickest, but changes show in both and the branch's migrations aren't run); **Copy** gives the worktree its own copy of them with the branch's migrations on top (about a second to copy at dev sizes, fine while that checkout's servers run); **New** sets up empty ones from scratch. A worktree's ⋯ → New worktree from this branch… opens it starting from that worktree.
- **Per session:** Terminal always; Changes and Code when the folder is a git repo; Env when it's a ToolJet checkout (set up / start / stop / restart, sign-in, license, live logs; each server start begins a new log and the last 5 runs stay pickable).
- **Your own folders** — the sidebar groups sessions in folders you make (named groups, not folders on disk). Each session row shows where it runs (branch or path), changes, servers and PR. **Worktrees** (sidebar footer) lists every checkout with its env, changes and code.
- **Claude usage** — for each Claude subscription on the Mac (Pro, Max, Team; API-key accounts have no such limits and aren't shown), the Overview shows the 5-hour and weekly limits with reset times, live, and the phone's session list shows them in one line per account. Claude hands these numbers only to its status line, so each account's card has a one-click **Connect**: it puts `bin/devdeck-statusline` in front of the status line in that account's Claude settings (every config signed in to it: `~/.claude`, `~/.claude-*/`), which saves the numbers to `~/.local/state/devdeck/claude/` and then runs the status line you had, unchanged (none before: a short one, model · 5h · week). **Disconnect** puts the settings back as they were; a copy from before connecting is kept next to the numbers. They refresh after each Claude reply in that account, pushed to the page (the server watches the saved numbers, no polling). When an account is signed in in several configs, each window shows the freshest reading: the latest reset time, then the highest use (an idle session's numbers are from its last reply).
- **⌘K palette** (the search icon, top right) — jump to any session or worktree; new session / worktree; theme.
- **Phone typing** — you write in the message box under the terminal (a tap on the terminal opens it; phone keyboards type badly straight into a terminal): the keyboard's Return starts a new line and the Send button sends it, as one paste plus Enter (several lines arrive as one prompt), with no autocorrect or auto-capitals. The paperclip (or pasting a screenshot into the box) attaches photos and files: they wait above the box as chips, and sending puts their paths in front of your message, so Claude opens them. The keys row (esc, tab, ^C, arrows, ⏎) fits on one line and sends without closing the keyboard. The top bar shows only back, the name, the Terminal / Changes / Env icons and ⋯; the worktree, its PR, its servers and ⟳ are the first items in ⋯, each with its state ("PR #18746 · 1 failing check"), so the terminal keeps most of the screen. When the connection drops (the phone slept, the network changed), the terminal reconnects on its own and anything typed meanwhile is sent once it's back. Drag a finger on the terminal to scroll, like a mouse wheel: back through its history in a shell, or through Claude's conversation in its full-screen mode (a flick glides). Sending anything while scrolled back returns to the live screen first, so nothing typed is lost. While the keyboard is up, the header and tabs step aside so the terminal keeps most of the screen (on iPhone too, which doesn't resize the page for the keyboard).
- **Copy on the phone** — long-press a word on the terminal to select it (a buzz, as in a native terminal app); drag the two handles to widen it; the bar copies it, selects the whole screen (All) or closes. Older output: scroll back to it first, or ⋯ → Copy from history…, which opens the session's history as a plain page to select from.
- **Install as an app** — on the phone, the session list shows an Install devdeck card until it's installed (✕ hides it): with an Install button once Chrome offers one (it does after the page has been used a little, and never once installed), else where to find it in the browser's menu (Chrome: ⋮ → Install app; Safari: Share → Add to Home Screen). It opens full screen from its icon, and when the Mac can't be reached it says so (with what to check) instead of a browser error. Icons are rebuilt from `public/icon.svg` with `node scripts/pwa-icons.mjs <playwright-core dir>`.
- **Quick replies** — when Claude or Codex asks (a permission or a question), its numbered options show as buttons above the terminal and in the Overview's "Needs you"; one tap answers, Esc cancels.
- **Files into the terminal** — drop files on a terminal, or paste a screenshot / copied file: they're saved under `~/.local/state/devdeck/uploads/` (cleared after a week) and the terminal gets their paths, so Claude attaches images.
- **Status bar** — branch, PR, changes, agent state, servers and folder of what's open; CPU, memory and disk of the Mac.
- **Overview** (desktop home) — what needs you (agents asking, PRs with failing checks / conflicts / changes requested), recent sessions, active worktrees.
- **Folder tabs** — the open session's sidebar folder (or, outside folders, all sessions outside folders) shows as tabs above the terminal, even when it's the only one: click to switch, ⌘1–9 / ⌃1–9 to jump (outside the installed app Chrome keeps ⌘1–9 for its own tabs), + for a new session in the folder, ✕ to end one.
- **Sidebar** — folders (optional, just to group) › sessions. Hover a session for + (new session here) and ⋯ (rename, move to a folder, end), a folder for a new session and ⋯ (rename, delete). Double-click a session or a folder's name to rename it (a click on a folder only opens or closes it); the session and folder names in the header and the folder tabs above the terminal rename the same way. Drag a session into a folder, between sessions to reorder, or out of its folder. A session that has several tmux windows (an older devdeck's tabs, or tmux's own new-window) is split into one session per window.
- **Theme** — System / Light / Dark (sidebar footer, or Settings → Appearance).
- **Terminal** — xterm 6 with the WebGL renderer, Unicode 15 widths (Claude's symbols line up), clickable links, ⇧Enter for a new line in Claude / Codex, ⌥ as Meta, selections copied to the clipboard on release (tmux's, and Claude's own in its full-screen mode, both arrive as OSC 52 with tmux's empty target, which devdeck accepts), ⌥-drag + ⌘C for a browser selection.
- **Claude status** — sessions running Claude / Codex show a dot: blue = working, amber = needs you (a permission or question prompt), green = idle. The browser tab title shows how many need you: `(2) devdeck`.
- **Pull requests** — each worktree heading shows its branch's PR (`#18564`, colored: green passing, amber checks running, red failing / conflicts / changes requested, grey draft, purple merged). The worktree page has the PR card with checks, review, conflicts and links to failing runs. A merged or closed PR keeps showing until the worktree has commits made after it closed (then it's new work). Uses your `gh` login. GitHub is asked when devdeck first sees a branch; when you open a worktree, or a session in one (that worktree's PR only, one call, skipped if it was asked in the last 15 s; also when you come back to the page from another tab or app); and when you press ⟳ in the header (or Reload in the ⌘K palette), which fetches every PR and also refreshes change counts and the session list. Nothing polls GitHub in the background. Branches never pushed to GitHub (not on a remote, not tracking one) are never asked about. The page itself refreshes every 5 s (paused while the tab is hidden); that stays on the Mac.
- **Code** (on the Mac; hidden on the phone, where VS Code is a heavy first load and hard to type in) — code-server opens only the session's folder (worktree detection and `.worktrees/` hidden), without the AI chat panel. It follows whichever editor the Mac's user has (VS Code, Insiders, Cursor or VSCodium): settings, keybindings, snippets and tasks are linked, and missing extensions are installed from Open VSX on their own (ones Open VSX lacks are skipped). Light or dark follows devdeck's theme switch (your editor's preferred light/dark themes if set, else VS Code's defaults); the terminal follows it too. Open it in its own tab from ⋯.
- **Tools** — installed CLIs, shell aliases/functions. **Settings** — projects, license, dev login, phone access.

## Install

On a Mac with Apple Silicon, in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/kavinvenkatachalam/devdeck/main/install.sh | sh
```

That installs devdeck with Homebrew (and Homebrew itself if it's missing, which asks for your password once), with its own Node and tmux; starts it, and again whenever you log in; and puts the **devdeck app** in Applications and opens it. The first screen asks for the folder your projects are in, and for GitHub (`gh`) if it's missing. Everything else is in Settings.

- **Update:** when there's a new version, **Update to …** shows below Settings in the sidebar, and the app's menu shows **Restart to Update** (devdeck asks GitHub when it starts and once a day; a devdeck run from a checkout doesn't). Or run `devdeck update`, or the install line again. Your terminals and servers keep running, and the page reloads onto the new version.
- **The app** is a window onto devdeck: closing it leaves devdeck running for your browser and phone, and when devdeck isn't running it offers to start it. It's installed by `devdeck desktop install` (and updated by `devdeck desktop update`), not downloaded in a browser: it isn't signed with a paid Apple ID, so macOS would block a downloaded copy; installed by the command it opens straight away, after the command has checked the download against the release's checksum and the app's signature.
- **Uninstall:** `devdeck autostart off; devdeck stop; devdeck desktop uninstall; brew uninstall devdeck`. Your terminals are tmux sessions (`tmux -L devdeck kill-server` ends them); settings are in `~/.config/devdeck`, state and logs in `~/.local/state/devdeck`.

## Run from a checkout

```bash
npm install
ln -s ~/Work/devdeck/bin/devdeck ~/.local/bin/devdeck   # once: puts `devdeck` on your PATH
devdeck                # starts in the background, prints the Mac and phone URLs
```

`devdeck stop` · `devdeck restart` · `devdeck status` · `devdeck logs` · `devdeck open` (browser) · `devdeck run` (foreground).
`devdeck autostart on` starts it whenever you log in to the Mac (`off` undoes it). `devdeck hooks` prints the Claude Code hooks that make the status dots exact (see How it works).
Stopping devdeck leaves your terminals and ToolJet servers running. Starting it also makes sure the phone URL (Tailscale :8444) is shared.

Options: `PORT=4317`, `HOST=127.0.0.1`, `DEVDECK_CODE_PORT=4318`, `DEVDECK_HOSTS` (more names to answer to, as `host:port`, comma-separated: needed if `HOST` is a LAN address). `npm run check` type-checks; `npm test` runs the tests (no extra dependencies). The page is plain ES modules in `public/js/`, one per area (terminal, env, sidebar, sheets…), with no build step. Icons are a Lucide sprite (`public/icons.svg`), rebuilt with `node scripts/icons.mjs`.

Needs on the machine: Node (devdeck runs on any 22.x; ToolJet commands use the checkout's `.nvmrc` version from nvm), git, tmux, Postgres and Redis for ToolJet, and a `.env` in the main ToolJet checkout.

## Releasing

Push a version tag: `git tag v0.5.0 && git push origin v0.5.0`. The release workflow (`.github/workflows/release.yml`) type-checks and tests, packs devdeck for Homebrew (`scripts/package.sh`: node modules installed and node-pty compiled on Node 24, which Homebrew's `node@24` runs), builds the app's DMG (`desktop/`, Electron, signed ad hoc), publishes both as a GitHub release, and then updates the formula in `kavinvenkatachalam/homebrew-tap` from `.github/formula-template.rb` (with the `HOMEBREW_TAP_TOKEN` secret). The app on its own: `cd desktop && npm install && npm start`; a DMG: `npx electron-builder --mac --config.extraMetadata.version=0.0.1`.

## Phone

devdeck only listens on localhost. Reach it over Tailscale (or use **Settings → Share devdeck on :8444**):

```bash
tailscale serve --bg --https=8444 http://localhost:4317
```

Its own HTTPS port (8444) keeps the main tailnet URL free for HexoKit. Open `https://<mac>.<tailnet>.ts.net:8444` on the phone, then **Add to Home Screen**.
There's no login to type: Tailscale tells devdeck who is visiting, and only the Mac's own Tailscale user gets in. Other people's devices on a shared tailnet are turned away.

## How it works

- Sessions live in devdeck's own tmux server (`tmux -L devdeck`), so they survive closing the browser or restarting devdeck. Terminals start with a clean login-shell environment.
- Who gets in: devdeck answers only to localhost and the Mac's Tailscale name (so a web page that points its own domain at 127.0.0.1 can't reach it), refuses requests sent by other sites, and over Tailscale lets in only the Mac's own Tailscale user. This covers pages, the API, terminals and /code.
- Claude status is read off the terminal's screen (`esc to interrupt` while working; `Do you want to proceed?` / `Enter to select` / Codex's approval prompt when it needs you), so it works with any account or alias with no setup. Claude's hooks make it exact: `devdeck hooks` prints them, to merge into the settings.json of each Claude config you use. Claude then reports when a turn starts and ends (`bin/devdeck-hook` writes `~/.local/state/devdeck/agents/<pane>`), and the screen still supplies a prompt's options and catches the two things hooks don't report (Esc on a prompt, Esc during a turn). Tests with sample screens: `test/agent.test.ts`; add one when a Claude version draws its screen differently.
- Env says Running only when a server's port answers. One devdeck started that's alive with its port closed (rebuilding, or a Nest watch server stuck on a compile error) shows as Not answering, and Start waits for it instead of starting a second one.
- The dev-env engine is bundled (no `tj`/ToolBelt needed) and follows `tools/tj`: `.env` with free ports and per-branch DBs (same names as tj), deps copied copy-on-write from another checkout when the lockfile matches (a whole folder in one `clonefile` call via the system Python when Apple's command line tools are installed, else `cp -c` file by file), `db:setup`, then `start:dev` / `npm start`. After the server is healthy it creates the dev admin (`setup-super-admin` → `onboarding/finish`) and applies the license (`PATCH /api/license`).
- It recognises servers started by tj or by hand in a worktree's terminal, and Stop stops those too. It only signals processes whose working directory is inside that worktree (a process group shared with anything else is stopped pid by pid), and logs every signal to `~/.local/state/devdeck/kills.log`.
- Light on the Mac: nothing runs in the background while no devdeck page is open. With one open it uses well under 1% of a core and ~70 MB: the page refreshes every 5 s (paused when hidden; pages open on the Mac and the phone share one refresh), `git status` (the costly part on a big repo) reruns every 30 s only for checkouts with a session or servers and every 10 min for the rest, env status every 5 s on the Env tab only (elsewhere it's re-read when the list sees a server go up or down), and GitHub only on ⟳ as described above.
- Claude / Codex started through an alias or login shell (`zsh -lc 'claude …'`) are found by asking `ps` what runs in front of the shell, so their status works too.
- On a slow link (a phone on mobile data) a terminal pauses its program once 1 MB of output is waiting to go out, as ssh would, rather than piling it up in devdeck. A dropped connection reconnects into the same terminal, without redrawing it from scratch.
- Detached-HEAD worktrees get databases named after their folder, so two never share one; removing a worktree never drops a database another checkout's `.env` uses, nor ones it shares (Same).
- Removing a worktree is instant: its folder is moved aside, git forgets it (`worktree prune`), and the files are deleted in the background at macOS background priority (`taskpolicy -b rm -rf`), so the Mac stays responsive.
- Deleting a sidebar folder ends the sessions in it (servers keep running).
- Terminal colors (Settings › Appearance › Terminal): devdeck (the default: its own light or dark, following the theme switch; pick it to go back) or one palette always: Always dark, Always light (devdeck's two), One Dark, Dracula, Nord, Solarized Dark or Light. Per device. On a light background, text a program colored for dark ones (Claude Code in its dark theme: white bullets, pale grays and links) is darkened until it reads; Claude Code's own `/theme` → a light one fixes the rest (the dark bars behind your messages).
- "working" can show as the word (the default) or an animation: Settings › Appearance › Working has dots, a spinner, a sparkle, bars, or your own GIF (up to 500 KB, kept in that browser). Per device, like the theme; animations stop when the system asks for reduced motion.
- Lock a folder (the lock button on its row, next to +) to keep its sessions from being ended: End session, a tab's ✕, deleting the folder and removing a worktree one of them runs in are all refused until you Unlock it. The lock follows a rename. Typing `exit` in a terminal still closes it.
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
