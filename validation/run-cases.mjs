// Runs a fixture's cases against the Jest trace recorded at its pinned commit.
//
//   node validation/run-cases.mjs <fixture-dir> <workspace-root> [out.json] [name-filter]
//
// <fixture-dir> holds fixture.json (the pinned commit), the gzipped trace and
// cases/. <workspace-root> is a checkout of that commit, from the fixture's setup.sh.
//
// A case is `<name>.json` in cases/:
//   { "name", "category", "description",
//     "commit": "<sha>"          // a real commit, replayed onto the snapshot, or
//     "patch": "<file.patch>",   // a hand-written change, committed on the snapshot and reset afterwards
//     "expect": { "runAll"?: bool, "widenedProjects"?: [config files], "mustSelect"?: [tests],
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
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const src = new URL('../src/', import.meta.url);
const { analyze } = await import(new URL('analyze.ts', src));
const { collectChanges } = await import(new URL('changes.ts', src));
const { workspacePackages } = await import(new URL('workspace-linker.ts', src));
const { trackedFiles } = await import(new URL('git.ts', src));

const [fixtureDir, workspaceRoot, outFile, filter] = process.argv.slice(2);
const fixture = JSON.parse(readFileSync(join(fixtureDir, 'fixture.json'), 'utf8'));
const casesDir = join(fixtureDir, 'cases');
const git = (...args) => execFileSync('git', args, { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

const traces = new Map();
const traceFile = join(fixtureDir, fixture.trace);
const traceText = traceFile.endsWith('.gz') ? gunzipSync(readFileSync(traceFile)).toString('utf8') : readFileSync(traceFile, 'utf8');
for (const line of traceText.split('\n').filter(Boolean)) {
  const { test, files, packages } = JSON.parse(line);
  traces.set(test, { files: new Set(files), packages: new Set(packages) });
}
const snapshot = fixture.commit;
if (git('rev-parse', 'HEAD') !== snapshot) throw new Error(`checkout ${snapshot} first`);
if (git('status', '--porcelain', '--untracked-files=no')) throw new Error('the fixture checkout has local changes');

const atSnapshot = new Set(trackedFiles(workspaceRoot));
const manifestPaths = ['package.json', ...workspacePackages(workspaceRoot, [...atSnapshot]).map((p) => `${p.root}/package.json`)];

const cases = readdirSync(casesDir)
  .filter((n) => n.endsWith('.json') && (!filter || n.includes(filter)))
  .sort()
  .map((n) => JSON.parse(readFileSync(join(casesDir, n), 'utf8')));

const floor = new Set((await analyze({ workspaceRoot, base: snapshot, head: snapshot, changeSet: { files: [], manifests: [], npmPackages: [] } })).projects.flatMap((p) => p.tests));
console.log(`floor: ${floor.size} tests run on every change`);

const results = [];
for (const c of cases) {
  const { report, changeSet, dropped } = c.commit ? await replayCommit(c) : await applyPatch(c);

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
    widenedProjects: report.projects.filter((p) => p.run === 'all').map((p) => `${p.configFile}: ${p.reasons.map((r) => r.rule).join(', ')}`),
    ms: report.timings.totalMs,
  };
  results.push(result);
  console.log(
    `${result.pass ? 'pass' : 'FAIL'} ${c.name.padEnd(36)} must=${String(result.mustRun).padStart(4)} selected=${String(result.selected).padStart(4)}/${total} (+${result.aboveFloor})${result.runAll.length ? ' ALL' : ''}${result.widenedProjects.length ? ` widened=${result.widenedProjects.length}` : ''}${dropped ? ` dropped=${dropped}` : ''}`,
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
  for (const config of expect.widenedProjects ?? []) {
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


/** A real commit's changes, taken as a change set at the snapshot. Paths that do not exist there are dropped. */
async function replayCommit(c) {
  const full = collectChanges(workspaceRoot, `${c.commit}~1`, c.commit, manifestPaths);
  const files = full.files.filter((f) => atSnapshot.has(f.path)).map((f) => ({ path: f.path, status: 'modified' }));
  const changeSet = { ...full, files };
  const report = await analyze({ workspaceRoot, base: snapshot, head: snapshot, changeSet });
  return { report, changeSet, dropped: full.files.length - files.length };
}

/** A hand-written patch, committed on the detached HEAD so the analyzer diffs it exactly as CI would, then reset. */
async function applyPatch(c) {
  git('apply', '--index', resolve(casesDir, c.patch));
  git('-c', 'user.name=jest-impact', '-c', 'user.email=cases@jest-impact', 'commit', '-q', '--no-verify', '-m', c.name);
  try {
    const report = await analyze({ workspaceRoot, base: snapshot, head: 'HEAD' });
    const changeSet = collectChanges(workspaceRoot, snapshot, 'HEAD', manifestPaths);
    return { report, changeSet, dropped: 0 };
  } finally {
    git('reset', '-q', '--hard', snapshot);
  }
}
