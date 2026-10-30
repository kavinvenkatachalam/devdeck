// The pull request for a worktree's branch, from GitHub via `gh` (uses your gh login).
// GitHub is asked when devdeck first sees a branch, and again only when you press reload (⟳ in the header):
// no polling in the background. The list never waits on GitHub; it shows the cached answer.
import { capture } from './sh.ts';
import { cleanEnv } from './tmux.ts';

export type Checks = { passed: number; failed: number; pending: number; failing: { name: string; url?: string }[] };
export type PR = {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  draft: boolean;
  review: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | '';
  // reviews asked for and not given yet (a re-request after changes keeps review = CHANGES_REQUESTED until they review)
  requested: string[];
  conflicts: boolean;
  base: string;
  additions: number;
  deletions: number;
  updatedAt: string;
  closedAt: string; // merged or closed at ('' while open)
  headOid: string;
  checks: Checks;
};

const FIELDS = 'number,title,url,state,isDraft,reviewDecision,reviewRequests,mergeable,baseRefName,headRefOid,updatedAt,closedAt,mergedAt,additions,deletions,statusCheckRollup';
const RETRY = 300_000; // gh missing / not logged in / offline: asked again after 5 min, so a first try that failed recovers
// long-lived branches have release PRs or fork PRs with the same head name; not "this worktree's PR"
const SKIP = new Set(['main', 'master', 'develop']);

const cache = new Map<string, { at: number; failed?: boolean; value?: PR | null; pending?: Promise<void> }>();

// Branches that ever went to GitHub: on a remote, or set to track one (that stays after the remote branch is
// deleted on merge). Only these can have a PR, so a branch never pushed costs no GitHub request.
// One git call per repo, refreshed every minute; undefined until the first answer.
const pushedCache = new Map<string, { at: number; value?: Set<string>; pending?: Promise<void> }>();
function readPushed(repo: string) {
  const c = pushedCache.get(repo) ?? { at: 0 };
  c.at = Date.now();
  pushedCache.set(repo, c);
  c.pending = Promise.all([
    capture('git', ['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/'], { cwd: repo, env: cleanEnv() }),
    capture('git', ['config', '--get-regexp', '^branch\\..*\\.merge$'], { cwd: repo, env: cleanEnv() }),
  ]).then(([remote, tracking]) => {
    c.value = new Set([...remote.out.split('\n'), ...tracking.out.split('\n').map((l) => /^branch\.(.*)\.merge /.exec(l)?.[1] ?? '')].filter(Boolean));
  });
  return c.pending;
}
function pushed(repo: string) {
  const c = pushedCache.get(repo);
  if (!c || Date.now() - c.at > 60_000) readPushed(repo);
  return pushedCache.get(repo)?.value;
}
const unpushed = (repo: string, branch: string) => !pushed(repo)?.has(branch);

// gh reports every run of a check (re-runs, pushes); keep the latest per workflow + name.
export function summarize(rollup: any[]): Checks {
  const latest = new Map<string, any>();
  for (const c of rollup ?? []) {
    const key = `${c.workflowName ?? ''}/${c.name ?? c.context}`;
    const prev = latest.get(key);
    if (!prev || (c.startedAt ?? '') >= (prev.startedAt ?? '')) latest.set(key, c);
  }
  const out: Checks = { passed: 0, failed: 0, pending: 0, failing: [] };
  for (const c of latest.values()) {
    const result = c.__typename === 'StatusContext' ? c.state : c.status === 'COMPLETED' ? c.conclusion : 'PENDING';
    if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(result)) {
      out.failed++;
      out.failing.push({ name: c.name ?? c.context, url: c.detailsUrl ?? c.targetUrl });
    } else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING'].includes(result) || !result) out.pending++;
    else if (result === 'SUCCESS') out.passed++;
    // SKIPPED / NEUTRAL don't count either way
  }
  return out;
}

async function fetchPr(repo: string, branch: string): Promise<PR | null> {
  const r = await capture('gh', ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '5', '--json', FIELDS], { cwd: repo, env: cleanEnv() });
  if (r.code !== 0) throw new Error(r.err || 'gh failed');
  const list = JSON.parse(r.out || '[]');
  const p = list.find((x: any) => x.state === 'OPEN') ?? list[0]; // newest first
  if (!p) return null;
  return {
    number: p.number,
    title: p.title,
    url: p.url,
    state: p.state,
    draft: p.isDraft,
    review: p.reviewDecision ?? '',
    requested: (p.reviewRequests ?? []).map((r: any) => r.login ?? r.name ?? r.slug).filter(Boolean),
    conflicts: p.state === 'OPEN' && p.mergeable === 'CONFLICTING',
    base: p.baseRefName,
    additions: p.additions,
    deletions: p.deletions,
    updatedAt: p.updatedAt,
    closedAt: p.mergedAt || p.closedAt || '',
    headOid: p.headRefOid,
    checks: summarize(p.statusCheckRollup),
  };
}

function refresh(key: string, repo: string, branch: string) {
  const c = cache.get(key) ?? { at: 0 };
  if (c.pending) return c.pending;
  c.pending = (async () => {
    try {
      c.value = await fetchPr(repo, branch);
      c.failed = false;
    } catch {
      c.failed = true;
    }
    c.at = Date.now();
    c.pending = undefined;
  })();
  cache.set(key, c);
  return c.pending;
}

// When the worktree's HEAD commit was made (it never changes for a given commit, so it's looked up once).
const headTimes = new Map<string, number>();
function headTime(repo: string, head: string) {
  const key = `${repo}\0${head}`;
  if (!headTimes.has(key)) {
    headTimes.set(key, NaN); // looking it up
    capture('git', ['log', '-1', '--format=%ct', head], { cwd: repo, env: cleanEnv() }).then((r) => headTimes.set(key, Number(r.out) * 1000 || NaN));
  }
  return headTimes.get(key)!;
}

// A merged / closed PR shows as such until the worktree has work made after it closed: then that's new work
// without a PR yet, and a long-lived branch (lts-3.16) doesn't show an old release PR. A worktree behind the PR
// (more was pushed on GitHub) still shows it.
function current(pr: PR | null | undefined, repo: string, head: string) {
  if (!pr || pr.state === 'OPEN' || (head && pr.headOid.startsWith(head))) return pr; // worktree list gives a short HEAD
  const made = head ? headTime(repo, head) : NaN;
  return made <= Date.parse(pr.closedAt) ? pr : null;
}

// undefined = not known yet, null = no PR for this branch
export function prFor(repo: string, branch: string | undefined, head: string): PR | null | undefined {
  if (!branch || SKIP.has(branch)) return undefined;
  if (unpushed(repo, branch)) return null;
  const key = `${repo}\0${branch}`;
  const c = cache.get(key);
  if (!c || (c.failed && !c.pending && Date.now() - c.at > RETRY)) refresh(key, repo, branch); // first sight, or a failed try
  return current(cache.get(key)?.value, repo, head);
}

// You opened this worktree (or a session in it): its PR afresh, one GitHub call, unless it was asked within 15 s
// (flipping between two worktrees doesn't ask again and again).
export async function refreshPr(repo: string, branch: string) {
  if (!branch || SKIP.has(branch)) return;
  await readPushed(repo); // pushed since?
  if (unpushed(repo, branch)) return;
  const key = `${repo}\0${branch}`;
  const c = cache.get(key);
  if (c && !c.pending && Date.now() - c.at < 15_000) return;
  await refresh(key, repo, branch);
}

// Reload: which branches are pushed (git, local), then every branch's PR afresh from GitHub, all at once.
// Branches pushed since are asked about by the list that follows (first sight).
export async function refreshPrs() {
  await Promise.all([...pushedCache.keys()].map(readPushed));
  await Promise.all([...cache.keys()].map((key) => {
    const [repo, branch] = key.split('\0');
    return unpushed(repo, branch) ? undefined : refresh(key, repo, branch);
  }));
}
