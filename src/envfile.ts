import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export type Env = Record<string, string>;

export function readEnv(file: string): Env {
  return existsSync(file) ? (parseEnv(readFileSync(file, 'utf8')) as Env) : {};
}

// Replace keys in place (keeping comments and order); append the ones that weren't there.
export function setKeys(content: string, updates: Env): string {
  const pending = new Map(Object.entries(updates));
  const out = content.split('\n').map((l) => {
    const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1];
    if (key && pending.has(key)) {
      const v = pending.get(key);
      pending.delete(key);
      return `${key}=${v}`;
    }
    return l;
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [k, v] of pending) out.push(`${k}=${v}`);
  return `${out.join('\n')}\n`;
}

export function writeEnv(file: string, base: string, updates: Env) {
  writeFileSync(file, setKeys(base, updates));
}
