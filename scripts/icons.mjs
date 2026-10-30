// Builds public/icons.svg: a sprite with only the Lucide icons the UI uses (lucide-static is a dev dependency).
// Run after adding an icon name: node scripts/icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAMES = [
  'terminal', 'git-branch', 'folder', 'folder-git-2', 'folder-open', 'plus', 'x', 'menu', 'power', 'search', 'file-diff', 'code-xml',
  'server', 'play', 'square', 'rotate-cw', 'check', 'copy', 'layout-grid', 'settings', 'external-link', 'trash-2', 'chevron-left',
  'chevron-right', 'chevron-down', 'ellipsis', 'wrench', 'key-round', 'database', 'users', 'scroll-text', 'loader-circle',
  'triangle-alert', 'info', 'smartphone', 'sparkles', 'git-commit-horizontal', 'package', 'circle', 'arrow-up', 'arrow-down', 'monitor',
  'git-pull-request', 'git-pull-request-draft', 'git-pull-request-closed', 'git-merge', 'circle-check', 'circle-x', 'clock',
  'pin', 'pin-off', 'sun', 'moon', 'sun-moon', 'layout-dashboard', 'maximize-2',
  'pencil', 'panel-left', 'minimize-2', 'arrow-up-right', 'grip-vertical', 'command', 'send', 'palette', 'cpu', 'memory-stick', 'hard-drive', 'columns-2', 'rows-2', 'grid-2x2', 'bell',
  'folder-plus', 'folder-closed', 'folder-output', 'folder-input', 'folder-search', 'corner-left-up', 'git-fork', 'house', 'list-tree', 'paperclip', 'lock', 'lock-open',
];

const root = join(import.meta.dirname, '..');
const symbols = NAMES.map((n) => {
  const svg = readFileSync(join(root, 'node_modules', 'lucide-static', 'icons', `${n}.svg`), 'utf8');
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/\s*\n\s*/g, '');
  return `<symbol id="${n}" viewBox="0 0 24 24">${inner}</symbol>`;
});
writeFileSync(join(root, 'public', 'icons.svg'), `<svg xmlns="http://www.w3.org/2000/svg">\n<!-- Lucide icons (ISC license), https://lucide.dev -->\n${symbols.join('\n')}\n</svg>\n`);
console.log(`icons.svg: ${NAMES.length} icons`);
