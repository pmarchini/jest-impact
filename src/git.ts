import { execFileSync } from 'node:child_process';

export type ChangedFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
};

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
}

export function resolveCommit(workspaceRoot: string, ref: string): string {
  return git(workspaceRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
}

/**
 * Files that differ between base and head. Renames are reported as a deletion
 * plus an addition so both paths count as changed.
 */
export function changedFiles(workspaceRoot: string, base: string, head: string): ChangedFile[] {
  const out = git(workspaceRoot, ['diff', '--name-status', '--no-renames', '-z', base, head]);
  const parts = out.split('\0').filter(Boolean);
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const code = parts[i]!;
    const path = parts[i + 1]!;
    const status = code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified';
    files.push({ path, status });
  }
  return files;
}

/** Tracked files at the current checkout, relative to the repo root. */
export function trackedFiles(workspaceRoot: string): string[] {
  return git(workspaceRoot, ['ls-files', '-z']).split('\0').filter(Boolean);
}

/** File content at a commit, or undefined when the file does not exist there. */
export function showFile(workspaceRoot: string, commit: string, path: string): string | undefined {
  try {
    return execFileSync('git', ['show', `${commit}:${path}`], {
      cwd: workspaceRoot,
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

export function currentHead(workspaceRoot: string): string {
  return git(workspaceRoot, ['rev-parse', 'HEAD']).trim();
}
