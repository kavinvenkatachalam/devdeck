# devdeck

A dev cockpit for Claude Code, Codex and git worktrees, on your Mac and your phone.

## Features

- **Sessions** — terminals in any folder or worktree, grouped in folders, reachable from the Mac and the phone
- **Agent status** — see which Claude or Codex session is working or needs you, and answer its prompts in one tap
- **Worktrees** — create one from main or another worktree, with its changes, code and dev servers alongside
- **Changes and Code** — the diff and an editor (code-server) for each session's folder
- **Pull requests** — status, checks and conflicts on each worktree, from your `gh` login
- **Claude usage** — your 5-hour and weekly limits, live
- **Phone** — a full terminal with a compose box, over Tailscale
- **Mac app** — a window onto devdeck, with updates in its menu

## Install

On a Mac with Apple Silicon:

```bash
curl -fsSL https://raw.githubusercontent.com/kavinvenkatachalam/devdeck/main/install.sh | sh
```

This installs devdeck with Homebrew (along with Node and tmux), starts it now and at every login, and opens the devdeck app.

| | |
| **Update** | *Update* in the sidebar, or *Restart to Update* in the app menu, shows up when a new version is out. Or run `devdeck update`. |
| **Phone** | Settings → Phone access. Needs Tailscale on the Mac and the phone. |
| **Uninstall** | `devdeck autostart off; devdeck stop; devdeck desktop uninstall; brew uninstall devdeck` |

Your terminals keep running through updates and restarts. Settings live in `~/.config/devdeck`, state and logs in `~/.local/state/devdeck`.

## Develop

```bash
npm install
ln -s "$PWD/bin/devdeck" ~/.local/bin/devdeck   # puts `devdeck` on your PATH
devdeck                                         # http://127.0.0.1:4317
npm run check && npm test                       # type-check and tests
```

`devdeck help` lists the other commands. The app is in `desktop/` (`npm install && npm start` there).

To release, push a version tag: `git tag v0.5.1 && git push origin v0.5.1`. GitHub Actions builds devdeck and the app, publishes the release, and updates the Homebrew formula.

## Credits

Inspired by [HexoKit](https://github.com/sahil87/hexokit) by Sahil Ahuja.

## License

MIT
