// Long actions (set up, start, stop, remove) run as jobs the UI polls: a checklist of steps plus a live log.
import { randomUUID } from 'node:crypto';
import { CmdError } from './sh.ts';

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type Step = { id: string; label: string; status: StepStatus; detail?: string };
export type Job = {
  id: string;
  path: string;
  title: string;
  status: 'running' | 'done' | 'failed';
  steps: Step[];
  log: string[];
  error?: string;
  hint?: string;
  startedAt: number;
  endedAt?: number;
};

export type Ctx = {
  log: (line: string) => void;
  step: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  skip: (id: string, detail: string) => void;
  detail: (id: string, detail: string) => void;
};

const MAX_LOG = 500;
const jobs = new Map<string, Job>();

export const getJob = (id: string) => jobs.get(id);
export const activeJob = (path: string) => [...jobs.values()].find((j) => j.path === path && j.status === 'running');
export const lastJob = (path: string) => [...jobs.values()].filter((j) => j.path === path).sort((a, b) => b.startedAt - a.startedAt)[0];

export function startJob(path: string, title: string, steps: [string, string][], fn: (ctx: Ctx) => Promise<void>): Job {
  const running = activeJob(path);
  if (running) return running; // one job per checkout; a second click just shows the current one
  const job: Job = { id: randomUUID(), path, title, status: 'running', steps: steps.map(([id, label]) => ({ id, label, status: 'pending' })), log: [], startedAt: Date.now() };
  jobs.set(job.id, job);

  const find = (id: string) => {
    let s = job.steps.find((x) => x.id === id);
    if (!s) job.steps.push((s = { id, label: id, status: 'pending' }));
    return s;
  };
  const log = (line: string) => {
    job.log.push(line.replace(/\x1b\[[0-9;]*m/g, '')); // no colour codes in the UI log
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
  };
  const ctx: Ctx = {
    log,
    async step(id, fn) {
      const s = find(id);
      s.status = 'running';
      try {
        const out = await fn();
        if (s.status === 'running') s.status = 'done';
        return out;
      } catch (e) {
        s.status = 'failed';
        throw e;
      }
    },
    skip(id, detail) {
      Object.assign(find(id), { status: 'skipped', detail });
    },
    detail(id, detail) {
      find(id).detail = detail;
    },
  };

  fn(ctx)
    .then(() => {
      job.status = 'done';
      for (const s of job.steps) if (s.status === 'pending') s.status = 'skipped';
    })
    .catch((e) => {
      job.status = 'failed';
      job.error = e instanceof Error ? e.message : String(e);
      job.hint = e instanceof CmdError ? e.hint : undefined;
      log(`✗ ${job.error}`);
    })
    .finally(() => {
      job.endedAt = Date.now();
    });

  // Old finished jobs are dropped after an hour.
  for (const [id, j] of jobs) if (j.endedAt && Date.now() - j.endedAt > 3_600_000) jobs.delete(id);
  return job;
}
