// Sidebar folders: named groups for sessions, nothing to do with folders on disk. The list (and its order)
// lives in devdeck's state folder so an empty folder stays; which folder a session sits in is a tmux option.
// A locked folder keeps its sessions from being ended (and itself from being deleted) until it's unlocked.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_ROOT } from './state.ts';
import { listSessions, setFolder } from './tmux.ts';

const FILE = join(STATE_ROOT, 'folders.json');

const load = (): { folders: string[]; locked: string[] } => {
  try {
    const f = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
    return { folders: f.folders ?? [], locked: f.locked ?? [] };
  } catch {
    return { folders: [], locked: [] };
  }
};
const read = () => load().folders;
const save = (folders: string[], locked: string[]) => writeFileSync(FILE, `${JSON.stringify({ folders, locked: locked.filter((l) => folders.includes(l)) }, null, 2)}\n`);
const write = (folders: string[]) => save(folders, load().locked);

export const lockedFolders = () => load().locked;
export const isLocked = (folder: string) => !!folder && load().locked.includes(folder);
export function lockFolder(name: string, on: boolean) {
  const { folders, locked } = load();
  if (!folders.includes(name)) throw new Error(`no folder called "${name}"`);
  save(folders, on ? [...new Set([...locked, name])] : locked.filter((l) => l !== name));
}

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
  const { folders: list, locked } = load();
  if (from !== to && list.includes(to)) throw new Error(`a folder called "${to}" already exists`);
  save(list.includes(from) ? list.map((f) => (f === from ? to : f)) : [...list, to], locked.map((l) => (l === from ? to : l)));
  for (const s of await listSessions()) if (s.folder === from) await setFolder(s.name, to);
}

// Its sessions move out to the top level; nothing is closed.
export async function removeFolder(name: string) {
  write(read().filter((f) => f !== name));
  for (const s of await listSessions()) if (s.folder === name) await setFolder(s.name, '');
}

export const orderFolders = (names: string[]) => write([...new Set(names.map(cleanFolder).filter(Boolean))]);
