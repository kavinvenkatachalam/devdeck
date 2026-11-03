#!/bin/sh
# Installs devdeck, or brings it up to date:
#   curl -fsSL https://raw.githubusercontent.com/kavinvenkatachalam/devdeck/main/install.sh | sh
# Homebrew installs the devdeck command (with its Node and tmux); devdeck then starts, and the devdeck app goes in
# /Applications and opens. It doesn't start at login unless you ask (devdeck autostart on): the app offers to start
# it. Run this again any time: it updates what's there.
# Everything is in functions and runs from the last line, so a download cut short runs nothing.
# Adapted from HexoKit's installer (https://github.com/sahil87/hexokit, MIT, Copyright (c) 2026 Sahil Ahuja).
set -eu

TAP=kavinvenkatachalam/tap
FORMULA=$TAP/devdeck

say() { if [ -t 1 ]; then printf '\033[36m→ %s\033[0m\n' "$1"; else printf '→ %s\n' "$1"; fi; }
done_() { if [ -t 1 ]; then printf '\033[32m✓ %s\033[0m\n' "$1"; else printf '✓ %s\n' "$1"; fi; }
die() { printf '%s\n' "$1" >&2; exit 1; }

# A step that prints nothing while it works (it can take a minute): a spinner and the seconds so far, so it doesn't
# look stuck. Its output is shown only if it fails.
quietly() {
  msg=$1
  shift
  log=$(mktemp)
  "$@" >"$log" 2>&1 &
  pid=$!
  if [ -t 1 ]; then
    i=0
    while kill -0 "$pid" 2>/dev/null; do
      case $((i % 4)) in 0) c='⠋' ;; 1) c='⠙' ;; 2) c='⠸' ;; *) c='⠴' ;; esac
      printf '\r\033[36m%s %s\033[0m \033[2m%ss\033[0m\033[K' "$c" "$msg" $((i / 5))
      sleep 0.2
      i=$((i + 1))
    done
    printf '\r\033[K'
  else
    say "$msg"
  fi
  if wait "$pid"; then
    rm -f "$log"
  else
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
}

preflight() {
  [ "$(uname -s)" = Darwin ] || die "devdeck runs on macOS."
  [ "$(uname -m)" = arm64 ] || die "devdeck needs a Mac with Apple Silicon (M1 or later)."
  command -v curl >/dev/null 2>&1 || die "curl is missing."
}

# Homebrew's own installer when there's none (it asks for your password once); then its path, for every brew call
# below: a brand-new Homebrew isn't on this shell's PATH yet.
brew_ready() {
  if command -v brew >/dev/null 2>&1; then
    BREW=$(command -v brew)
    return
  fi
  say "Installing Homebrew (it may ask for your Mac password)"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  BREW=/opt/homebrew/bin/brew
  [ -x "$BREW" ] || die "Homebrew didn't install. See https://brew.sh"
  eval "$("$BREW" shellenv)"
  echo "Add Homebrew to your shell for next time:  echo 'eval \"\$($BREW shellenv)\"' >> ~/.zprofile"
}

# Homebrew 6+ installs from another tap only once you've trusted it; older ones have no `brew trust`.
trust() {
  if "$BREW" trust --help >/dev/null 2>&1; then quietly "Getting Homebrew ready" "$BREW" trust --formula "$FORMULA"; fi
}

main() {
  say "Setting up devdeck"
  preflight
  brew_ready
  trust
  if "$BREW" list --versions devdeck >/dev/null 2>&1; then
    quietly "Checking for a new devdeck" "$BREW" update --quiet
    say "Updating devdeck"
    "$BREW" upgrade "$FORMULA" || true # already the latest: nothing to do
  else
    say "Installing devdeck (with Node and tmux)"
    "$BREW" install "$FORMULA"
  fi
  devdeck=$("$BREW" --prefix)/bin/devdeck
  done_ "devdeck $("$devdeck" version)"

  if "$devdeck" status >/dev/null 2>&1; then "$devdeck" restart; else "$devdeck" start; fi
  done_ "devdeck is running"

  say "Installing the devdeck app"
  "$devdeck" desktop install --open
  done_ "All set: the devdeck app is in your Applications folder"
  echo "To start devdeck whenever you log in: devdeck autostart on"
}

main "$@"
