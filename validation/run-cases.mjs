// Runs the fixture cases against a Jest read trace taken at the snapshot commit.
//
//   node validation/run-cases.mjs <workspace> <trace-dir> <cases-dir> [out.json] [name-filter]
//
// A case is `<name>.json` in the cases dir:
//   { "name", "category", "description",
//     "commit": "<sha>"          // a real commit, replayed onto the snapshot, or
//     "patch": "<file.patch>",   // a hand-written change, applied to the snapshot checkout
//     "expect": { "runAll"?: bool, "wholeProjects"?: [config files], "mustSelect"?: [tests],
//                 "mustSkip"?: [tests], "uncertain"?: [files], "maxAboveFloor"?: n } }
//
// The floor is what an empty change selects: tests that reach a file with
// imports sovra cannot follow run on every change.
//
// A commit is replayed by taking its changed paths (and its lockfile and
// manifest diff) as a change set at the snapshot, so the trace, which was
// recorded at the snapshot, is exact ground truth for it. Paths that do not
// exist at the snapshot are dropped and counted.
//
// Ground truth: a test must run when it read a changed file, read a changed
// npm package, or is itself changed. Any such test the analyzer leaves out is
// a miss, and so is any expectation the case states that does not hold.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const src = new URL('../src/', import.meta.url);
const { analyze } = await import(new URL('analyze.ts', src));
const { collectChanges } = await import(new URL('changes.ts', src));
const { workspacePackages } = await import(new URL('workspace-linker.ts', src));
const { trackedFiles } = await import(new URL('git.ts', src));

const [workspace, traceDir, casesDir, outFile, filter] = process.argv.slice(2);
const git = (...args) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

const traces = new Map();
for (const name of readdirSync(traceDir).filter((n) => n.endsWith('.jsonl'))) {
  for (const line of readFileSync(join(traceDir, name), 'utf8').split('\n').filter(Boolean)) {
    const { test, files, packages } = JSON.parse(line);
    traces.set(test, { files: new Set(files), packages: new Set(packages) });
  }
}
const snapshot = readFileSync(join(traceDir, 'COMMIT'), 'utf8').trim();
if (git('rev-parse', 'HEAD') !== snapshot) throw new Error(`checkout ${snapshot} first`);
if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('the fixture checkout has local changes');

const atSnapshot = new Set(trackedFiles(workspace));
const manifestPaths = ['package.json', ...workspacePackages(workspace, [...atSnapshot]).map((p) => `${p.dir}/package.json`)];

const cases = readdirSync(casesDir)
  .filter((n) => n.endsWith('.json') && (!filter || n.includes(filter)))
  .sort()
  .map((n) => JSON.parse(readFileSync(join(casesDir, n), 'utf8')));

const floor = new Set((await analyze({ workspaceRoot: workspace, base: snapshot, head: snapshot, changeSet: { files: [], manifests: [], npmPackages: [] } })).projects.flatMap((p) => p.tests));
console.log(`floor: ${floor.size} tests run on every change`);

const results = [];
for (const c of cases) {
  let changeSet;
  let dropped = 0;
  let patchFile;
  if (c.commit) {
    const full = collectChanges(workspace, `${c.commit}~1`, c.commit, manifestPaths);
    const files = full.files
      .filter((f) => atSnapshot.has(f.path) || (dropped++, false))
      .map((f) => ({ path: f.path, status: 'modified' }));
    changeSet = { ...full, files };
  } else {
    patchFile = join(casesDir, c.patch);
    // --index, so added files are tracked and the analyzer sees them.
    git('apply', '--index', patchFile);
    const files = git('apply', '--numstat', '--summary', patchFile);
    changeSet = { files: patchStatuses(files), manifests: [], npmPackages: [] };
  }

  let report;
  try {
    report = await analyze({ workspaceRoot: workspace, base: snapshot, head: snapshot, changeSet });
  } finally {
    if (patchFile) git('apply', '-R', '--index', patchFile);
  }

  const changed = new Set(changeSet.files.map((f) => f.path));
  const changedPackages = new Set([...(changeSet.lockfile?.changedPackages ?? []), ...changeSet.manifests.flatMap((m) => m.dependencies)]);
  const mustRun = [];
  for (const [test, trace] of traces) {
    const file = [...trace.files].find((f) => changed.has(f));
    const pkg = file ? undefined : [...trace.packages].find((p) => changedPackages.has(p));
    if (file || pkg) mustRun.push({ test, because: file ?? `npm:${pkg}` });
  }
  const selected = new Set(report.projects.flatMap((p) => p.tests));
  const misses = mustRun.filter((m) => !selected.has(m.test));
  const failures = [...misses.map((m) => `missed ${m.test} (read ${m.because})`), ...checkExpect(c.expect ?? {}, report, selected, floor)];
  const total = report.projects.reduce((n, p) => n + p.totalTests, 0);
  const result = {
    name: c.name,
    category: c.category,
    pass: failures.length === 0,
    failures,
    changedFiles: changed.size,
    droppedFiles: dropped,
    mustRun: mustRun.length,
    selected: selected.size,
    total,
    aboveFloor: [...selected].filter((t) => !floor.has(t)).length,
    overSelected: selected.size - (mustRun.length - misses.length),
    runAll: report.runAll.map((r) => `${r.rule}: ${r.detail}`),
    wholeProjects: report.projects.filter((p) => p.run === 'all').map((p) => `${p.configFile}: ${p.reasons.map((r) => r.rule).join(', ')}`),
    ms: report.timings.totalMs,
  };
  results.push(result);
  console.log(
    `${result.pass ? 'pass' : 'FAIL'} ${c.name.padEnd(36)} must=${String(result.mustRun).padStart(4)} selected=${String(result.selected).padStart(4)}/${total} (+${result.aboveFloor})${result.runAll.length ? ' ALL' : ''}${result.wholeProjects.length ? ` whole=${result.wholeProjects.length}` : ''}${dropped ? ` dropped=${dropped}` : ''}`,
  );
  for (const f of failures.slice(0, 5)) console.log(`     ${f}`);
}
if (outFile) writeFileSync(outFile, JSON.stringify({ snapshot, results }, null, 2) + '\n');
console.log(`${results.filter((r) => r.pass).length}/${results.length} cases pass`);
process.exitCode = results.every((r) => r.pass) ? 0 : 1;

function checkExpect(expect, report, selected, floor) {
  const out = [];
  if (expect.runAll !== undefined && expect.runAll !== report.runAll.length > 0) {
    out.push(`expected runAll=${expect.runAll}, got ${report.runAll.length > 0}`);
  }
  for (const config of expect.wholeProjects ?? []) {
    if (report.projects.find((p) => p.configFile === config)?.run !== 'all') out.push(`expected the whole of ${config} to run`);
  }
  for (const test of expect.mustSelect ?? []) if (!selected.has(test)) out.push(`expected ${test} to be selected`);
  for (const test of expect.mustSkip ?? []) if (selected.has(test)) out.push(`expected ${test} to be skipped`);
  const uncertain = new Set(report.uncertainFiles.map((u) => u.file));
  for (const file of expect.uncertain ?? []) if (!uncertain.has(file)) out.push(`expected ${file} to be reported as uncertain`);
  const above = [...selected].filter((t) => !floor.has(t)).length;
  if (expect.maxAboveFloor !== undefined && above > expect.maxAboveFloor) out.push(`selected ${above} tests above the floor, expected at most ${expect.maxAboveFloor}`);
  return out;
}

function patchStatuses(summary) {
  const files = new Map();
  for (const line of summary.split('\n').filter(Boolean)) {
    const numstat = /^\S+\t\S+\t(.+)$/.exec(line);
    if (numstat) files.set(numstat[1], 'modified');
    const mode = /^ (create|delete) mode \d+ (.+)$/.exec(line);
    if (mode) files.set(mode[2], mode[1] === 'create' ? 'added' : 'deleted');
  }
  return [...files].map(([path, status]) => ({ path, status }));
}
