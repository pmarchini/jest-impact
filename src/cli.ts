#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { analyze, type Report } from './analyze.ts';
import { repoRoot } from './git.ts';
import { formatGitlabPipeline, formatNxCommands, formatText, writeTestLists } from './output.ts';

const HELP = `Usage: jest-impact [options]

Lists the Jest test files in each Nx project that changes between two commits can affect.
Run it in a checkout of the head commit.

Options:
  --base <ref>        Base commit (default: $NX_BASE or main)
  --head <ref>        Head commit (default: $NX_HEAD or HEAD)
  --cwd <dir>         Workspace root (default: the git repository containing the current directory)
  --format <format>   text, json, nx or gitlab (default: text)
  --gitlab-include <file>  With --format gitlab: a local file the child pipeline includes (repeatable)
  --gitlab-extends <job>   With --format gitlab: a hidden job every generated job extends
  --json <file>       Also write the full JSON report to <file>
  --out-dir <dir>     Write one test list per project to <dir>
  --nx-graph <file>   Project graph from \`nx graph --file\`, for exact project names
  --no-link           Do not symlink workspace packages into node_modules
  -h, --help          Show this help
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      cwd: { type: 'string' },
      format: { type: 'string', default: 'text' },
      json: { type: 'string' },
      'out-dir': { type: 'string' },
      'nx-graph': { type: 'string' },
      'gitlab-include': { type: 'string', multiple: true },
      'gitlab-extends': { type: 'string' },
      'no-link': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const workspaceRoot = repoRoot(resolve(values.cwd ?? process.cwd()));
  const report = await analyze({
    workspaceRoot,
    base: values.base ?? process.env.NX_BASE ?? 'main',
    head: values.head ?? process.env.NX_HEAD ?? 'HEAD',
    nxGraph: values['nx-graph'] && resolve(values['nx-graph']),
    link: !values['no-link'],
  });
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2) + '\n');
  if (values['out-dir']) writeTestLists(report, workspaceRoot, resolve(values['out-dir']));
  const output = formatReport(report, values, workspaceRoot);
  if (output) process.stdout.write(output + '\n');
  return 0;
}

function formatReport(report: Report, values: { format?: string; 'gitlab-include'?: string[]; 'gitlab-extends'?: string }, workspaceRoot: string): string {
  switch (values.format) {
    case 'json':
      return JSON.stringify(report, null, 2);
    case 'nx':
      return formatNxCommands(report, workspaceRoot);
    case 'gitlab':
      return formatGitlabPipeline(report, { include: values['gitlab-include'], extends: values['gitlab-extends'] });
    default:
      return formatText(report);
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`jest-impact: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  },
);
