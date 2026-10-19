import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectResult, Report } from './analyze.ts';

export function formatText(report: Report): string {
  const lines: string[] = [];
  const total = report.projects.reduce((n, p) => n + p.totalTests, 0);
  const selected = report.projects.reduce((n, p) => n + p.tests.length, 0);
  lines.push(`jest-impact ${report.base.slice(0, 10)}..${report.head.slice(0, 10)}: ${selected} of ${total} test files in ${report.projects.filter((p) => p.run !== 'none').length} of ${report.projects.length} projects`);
  if (report.runAll.length > 0) {
    lines.push('Running everything:');
    for (const reason of report.runAll) lines.push(`  ${describe(reason)}`);
  }
  for (const project of report.projects) {
    if (project.run === 'none') continue;
    lines.push(`${project.project}:${project.target}  ${project.run === 'all' ? 'all' : project.tests.length} of ${project.totalTests}`);
    if (report.runAll.length === 0) for (const reason of project.reasons) lines.push(`  because ${describe(reason)}`);
    if (project.run === 'some') for (const test of project.tests) lines.push(`  ${test}`);
  }
  if (report.uncertainFiles.length > 0) {
    lines.push(`${report.uncertainFiles.length} files have imports sovra cannot follow; tests that reach them always run (see --json).`);
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  lines.push(`analysis ${report.timings.totalMs} ms (sovra ${report.timings.sovraMs} ms)`);
  return lines.join('\n');
}

/**
 * One command per project that needs to run, passing explicit test paths to
 * the project's existing Jest target.
 */
export function formatNxCommands(report: Report, workspaceRoot: string): string {
  return report.projects
    .filter((p) => p.run !== 'none')
    .map((p) => nxCommand(p, workspaceRoot))
    .join('\n');
}

function nxCommand(project: ProjectResult, workspaceRoot: string): string {
  const base = `npx nx run ${project.project}:${project.target}`;
  if (project.run === 'all') return base;
  return `${base} --runTestsByPath ${project.tests.map((t) => shellQuote(join(workspaceRoot, t))).join(' ')}`;
}

/** Writes `<project>.txt` with one absolute test path per line, for projects that run only some tests. */
export function writeTestLists(report: Report, workspaceRoot: string, dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const project of report.projects) {
    const content = project.run === 'some' ? project.tests.map((t) => join(workspaceRoot, t)).join('\n') + '\n' : '';
    writeFileSync(join(dir, `${project.project.replaceAll('/', '__')}.${project.run}.txt`), content);
  }
}

function describe(reason: { rule: string; detail: string; file?: string }): string {
  return reason.file ? `${reason.detail} (${reason.file})` : reason.detail;
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}
