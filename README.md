# devdeck

A dev cockpit for Claude Code, Codex and git worktrees, on your Mac and your phone.

## Install

On a Mac with Apple Silicon:

```bash
curl -fsSL https://raw.githubusercontent.com/kavinvenkatachalam/devdeck/main/install.sh | sh
```

Installs devdeck with Homebrew, starts it (and at every login), and opens the devdeck app.

- **Update:** *Update* in the sidebar or *Restart to Update* in the app menu, when a new version is out. Or `devdeck update`.
- **Phone:** Settings → Phone access (needs Tailscale).
- **Uninstall:** `devdeck autostart off; devdeck stop; devdeck desktop uninstall; brew uninstall devdeck`

## Develop

```bash
npm install
ln -s "$PWD/bin/devdeck" ~/.local/bin/devdeck
devdeck          # http://127.0.0.1:4317
npm run check && npm test
```

Release: push a version tag (`git tag v0.5.1 && git push origin v0.5.1`).

MIT license.
