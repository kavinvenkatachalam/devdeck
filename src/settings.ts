import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Settings = {
  roots: string[]; // folders offered in the New session picker
  license: string; // ToolJet license key; empty = skip
  login: { email: string; password: string }; // dev admin created on first start
};

export const FILE = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'devdeck', 'settings.json');

const DEFAULTS: Settings = { roots: ['~/Work'], license: '', login: { email: 'dev@tooljet.io', password: 'password' } };

export const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p);

export function loadSettings(): Settings {
  if (!existsSync(FILE)) return structuredClone(DEFAULTS);
  const s = JSON.parse(readFileSync(FILE, 'utf8'));
  return { ...DEFAULTS, ...s, login: { ...DEFAULTS.login, ...s.login } };
}

export function saveSettings(s: Settings) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
}
