// Turns a repo's recent history into checked cases, using a Jest read trace as ground truth.
//
//   node validation/cases.mjs <workspace-root> <trace-dir> <commit-count> <out.json>
//
// The trace (from trace-jest.cjs) says which files and npm packages each test
// read at the snapshot commit. For every first-parent commit up to the snapshot,
// a test must run when it read a file the commit changed, read a package the
// lockfile diff changed, or is itself changed. The analyzer's selection must
// contain all of those; anything missing is a false negative.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { analyze } = await import(new URL('../src/analyze.ts', import.meta.url));
const [workspaceRoot, traceDir, count, outFile] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

const traces = new Map();
for (const name of readdirSync(traceDir).filter((n) => n.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(traceDir, name), 'utf8').split('\n').filter(Boolean)) {
    const { test, files, packages } = JSON.parse(line);
    traces.set(test, { files: new Set(files), packages: new Set(packages) });
  }
}
const snapshot = readFileSync(join(traceDir, 'COMMIT'), 'utf8').trim();
const start = git('rev-parse', 'HEAD');
const commits = git('log', '--first-parent', '--format=%H', `-${count}`, snapshot).split('\n');

const cases = [];
try {
  for (const sha of commits) {
    git('checkout', '-q', '--detach', sha);
    const report = await analyze({ workspaceRoot, base: `${sha}~1`, head: sha });
    const changed = new Set(git('diff', '--name-only', '--no-renames', `${sha}~1`, sha).split('\n').filter(Boolean));
    const changedPackages = new Set(report.changes.lockfile?.changedPackages ?? []);

    const mustRun = [];
    for (const [test, trace] of traces) {
      const file = [...trace.files].find((f) => changed.has(f));
      const pkg = file ? undefined : [...trace.packages].find((p) => changedPackages.has(p));
      if (file || pkg) mustRun.push({ test, because: file ?? `npm:${pkg}` });
    }
    const predicted = new Set(report.projects.flatMap((p) => p.tests));
    const misses = mustRun.filter((m) => !predicted.has(m.test));
    const total = report.projects.reduce((n, p) => n + p.totalTests, 0);
    const entry = {
      sha,
      subject: git('log', '-1', '--format=%s', sha),
      changedFiles: changed.size,
      mustRun: mustRun.length,
      selected: predicted.size,
      total,
      runAll: report.runAll.map((r) => r.rule),
      widenedProjects: report.projects.filter((p) => p.run === 'all').length,
      misses,
      ms: report.timings.totalMs,
    };
    cases.push(entry);
    console.log(
      `${sha.slice(0, 9)} must=${String(entry.mustRun).padStart(4)} selected=${String(entry.selected).padStart(4)}/${total} ${misses.length ? `MISSES=${misses.length}` : 'ok'} ${entry.runAll.length ? 'ALL ' : ''}${entry.subject.slice(0, 60)}`,
    );
  }
} finally {
  git('checkout', '-q', start);
}
writeFileSync(outFile, JSON.stringify({ snapshot, cases }, null, 2) + '\n');
const summary = {
  commits: cases.length,
  withMisses: cases.filter((c) => c.misses.length).length,
  runAll: cases.filter((c) => c.runAll.length).length,
  medianSelectedShare: median(cases.map((c) => c.selected / c.total)),
  medianMustRunShare: median(cases.map((c) => c.mustRun / c.total)),
};
console.log(summary);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 1000) / 1000;
}
