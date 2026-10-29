// Sidebar folders: named groups for sessions, nothing to do with folders on disk. The list (and its order)
// lives in devdeck's state folder so an empty folder stays; which folder a session sits in is a tmux option.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_ROOT } from './state.ts';
import { listSessions, setFolder } from './tmux.ts';

const FILE = join(STATE_ROOT, 'folders.json');

const read = (): string[] => {
  try {
    return existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')).folders ?? [] : [];
  } catch {
    return [];
  }
};
const write = (folders: string[]) => writeFileSync(FILE, `${JSON.stringify({ folders }, null, 2)}\n`);

export const cleanFolder = (s: unknown) => String(s ?? '').trim().slice(0, 40);

// Folders a session names but the list lost (edited by hand, another devdeck) still show.
export function folders(sessions: { folder: string }[]) {
  const list = read();
  for (const s of sessions) if (s.folder && !list.includes(s.folder)) list.push(s.folder);
  return list;
}

export function addFolder(name: string) {
  const list = read();
  if (!list.includes(name)) write([...list, name]);
}

export async function renameFolder(from: string, to: string) {
  const list = read();
  if (from !== to && list.includes(to)) throw new Error(`a folder called "${to}" already exists`);
  write(list.includes(from) ? list.map((f) => (f === from ? to : f)) : [...list, to]);
  for (const s of await listSessions()) if (s.folder === from) await setFolder(s.name, to);
}

// Its sessions move out to the top level; nothing is closed.
export async function removeFolder(name: string) {
  write(read().filter((f) => f !== name));
  for (const s of await listSessions()) if (s.folder === name) await setFolder(s.name, '');
}

export const orderFolders = (names: string[]) => write([...new Set(names.map(cleanFolder).filter(Boolean))]);
