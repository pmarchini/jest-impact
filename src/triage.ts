import { packageName } from './jest/evaluate.ts';

export type SovraError =
  | { kind: 'unresolved'; file: string; specifier: string }
  | { kind: 'dynamic'; file: string; line: number; message: string; code: string }
  | { kind: 'other'; file?: string; message: string };

export type TriagedError = SovraError & {
  /** `ignore`: safe to skip. `uncertain`: the file may depend on anything. `global`: run everything. */
  verdict: 'ignore' | 'uncertain' | 'global';
  reason: string;
};

export type TriageContext = {
  workspacePackages: Set<string>;
  /** Packages known to come from npm: declared in a manifest or present in the lockfile. */
  npmPackages: Set<string>;
  /** moduleNameMapper patterns sovra could not apply, from every Jest project. */
  unmappedPatterns: RegExp[];
};

const UNRESOLVED = /^\[(.+?)\]\nCannot find module '(.+)'$/s;
const DIAGNOSTIC = /^\s*x (.+?)\n.*?,-\[(.+?):(\d+):(\d+)\]/s;

/** sovra reports errors as strings; this recovers the file and the kind of problem. */
export function parseSovraError(raw: string): SovraError {
  const unresolved = UNRESOLVED.exec(raw);
  if (unresolved) return { kind: 'unresolved', file: unresolved[1]!, specifier: unresolved[2]! };
  const diagnostic = DIAGNOSTIC.exec(raw);
  if (diagnostic) {
    const line = Number(diagnostic[3]);
    const column = Number(diagnostic[4]);
    return {
      kind: 'dynamic',
      file: diagnostic[2]!,
      line,
      message: diagnostic[1]!.trim(),
      code: sourceLine(raw, line).slice(column - 1),
    };
  }
  const file = /^\[(.+?)\]/.exec(raw)?.[1];
  return { kind: 'other', file, message: raw.trim() };
}

/** The source line a miette diagnostic quotes, such as ` 6 | jest.mock('./c', ...)`. */
function sourceLine(raw: string, line: number): string {
  const match = new RegExp(`^\\s*${line} \\| (.*)$`, 'm').exec(raw);
  return match?.[1] ?? '';
}

// jest.mock('./x', factory) replaces the module, so the real file is never loaded.
const MOCK_WITH_FACTORY = /^jest\.(mock|doMock|unstable_mockModule|setMock)\(\s*(['"`])[^'"`$]+\2\s*,/;

export function triage(error: SovraError, context: TriageContext): TriagedError {
  if (error.kind === 'dynamic') {
    if (MOCK_WITH_FACTORY.test(error.code)) {
      return { ...error, verdict: 'ignore', reason: 'jest.mock with a factory replaces the module' };
    }
    return { ...error, verdict: 'uncertain', reason: error.message };
  }
  if (error.kind === 'other') {
    return error.file
      ? { ...error, verdict: 'uncertain', reason: 'sovra could not analyse this file' }
      : { ...error, verdict: 'global', reason: 'sovra reported an error without a file' };
  }
  const { specifier } = error;
  if (context.unmappedPatterns.some((re) => re.test(specifier))) {
    return { ...error, verdict: 'uncertain', reason: `moduleNameMapper rewrites '${specifier}' in a way sovra cannot follow` };
  }
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) {
    return { ...error, verdict: 'uncertain', reason: `local import '${specifier}' does not resolve` };
  }
  const name = packageName(specifier);
  if (context.workspacePackages.has(name)) {
    return { ...error, verdict: 'uncertain', reason: `workspace package import '${specifier}' does not resolve` };
  }
  if (context.npmPackages.has(name) || context.npmPackages.has(`@types/${name.replace('@', '').replace('/', '__')}`)) {
    return { ...error, verdict: 'ignore', reason: 'third-party package, matched by name through npm: entries' };
  }
  return { ...error, verdict: 'uncertain', reason: `'${specifier}' is neither a workspace package nor a known dependency` };
}
