import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { NapiResolveOptions } from 'sovra';
import type { JestProjectConfig } from './jest/project-config.ts';

export type ResolverSetup = {
  options: NapiResolveOptions;
  /** moduleNameMapper entries sovra cannot express, per Jest config file. */
  unmappedPatterns: Map<string, RegExp[]>;
  warnings: string[];
};

const EXTENSION_ORDER = ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json'];

/**
 * Builds one set of resolver options for the whole workspace from the repo's
 * own config: tsconfig custom conditions, Jest extensions and prefix-shaped
 * moduleNameMapper entries.
 */
export function buildResolverOptions(workspaceRoot: string, configs: JestProjectConfig[], extraConditions: string[] = []): ResolverSetup {
  const warnings: string[] = [];
  const tsconfigFile = ['tsconfig.base.json', 'tsconfig.json'].map((f) => join(workspaceRoot, f)).find(existsSync);
  const customConditions = tsconfigFile ? readCustomConditions(tsconfigFile) : [];

  const declared = new Set(configs.flatMap((c) => c.moduleFileExtensions));
  const extensions = [...EXTENSION_ORDER.filter((e) => declared.has(e)), ...[...declared].filter((e) => !EXTENSION_ORDER.includes(e) && e !== 'node')];

  // A prefix alias is global in sovra, so two configs mapping it differently cannot both be honoured.
  const candidates = new Map<string, Set<string>>();
  for (const config of configs) {
    for (const [pattern, targets] of config.moduleNameMapper) {
      const mapped = prefixAlias(pattern, targets);
      if (mapped) candidates.set(mapped.key, (candidates.get(mapped.key) ?? new Set()).add(JSON.stringify(mapped.targets)));
    }
  }
  const alias: Record<string, string[]> = {};
  const unmappedPatterns = new Map<string, RegExp[]>();
  for (const config of configs) {
    const unmapped: RegExp[] = [];
    for (const [pattern, targets] of config.moduleNameMapper) {
      const mapped = prefixAlias(pattern, targets);
      if (mapped && candidates.get(mapped.key)!.size === 1) {
        alias[mapped.key] = mapped.targets;
      } else {
        if (mapped) warnings.push(`moduleNameMapper ${pattern} in ${config.configFile} maps differently in another project; its imports are treated as unresolved`);
        unmapped.push(new RegExp(pattern));
      }
    }
    unmappedPatterns.set(config.configFile, unmapped);
  }

  const modulePaths = [...new Set(configs.flatMap((c) => c.modulePaths))];
  const moduleDirectories = [...new Set(configs.flatMap((c) => c.moduleDirectories))];
  const options: NapiResolveOptions = {
    conditionNames: [...new Set([...extraConditions, ...customConditions, ...configs.flatMap((c) => c.exportConditions), 'require', 'node', 'browser', 'import', 'default'])],
    extensions: extensions.map((e) => '.' + e),
    extensionAlias: {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.jsx': ['.tsx', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    },
    builtinModules: true,
    modules: [...moduleDirectories, ...modulePaths],
    alias,
  };
  if (tsconfigFile) options.tsconfig = { configFile: tsconfigFile, references: 'auto' };
  return { options, unmappedPatterns, warnings };
}

/**
 * `^@app/(.*)$ -> /src/$1` becomes the alias `@app -> /src`, and
 * `^lodash$ -> lodash-es` becomes `lodash$ -> lodash-es`. Anything else
 * needs a real mapping step in sovra.
 */
export function prefixAlias(pattern: string, targets: string[]): { key: string; targets: string[] } | undefined {
  const literal = String.raw`((?:[\w@~.-]|\\[./@~-]|/)+)`;
  const prefix = new RegExp(`^\\^${literal}/\\(\\.\\*\\)\\$$`).exec(pattern);
  if (prefix && targets.every((t) => t.endsWith('/$1') && !t.slice(0, -3).includes('$'))) {
    return { key: unescape(prefix[1]!), targets: targets.map((t) => t.slice(0, -3)) };
  }
  const exact = new RegExp(`^\\^${literal}\\$$`).exec(pattern);
  if (exact && targets.every((t) => !t.includes('$'))) {
    return { key: unescape(exact[1]!) + '$', targets };
  }
  return undefined;
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/** customConditions from a tsconfig, following `extends` to relative files. */
function readCustomConditions(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file) || !existsSync(file)) return [];
  seen.add(file);
  const json = parseJsonc(readFileSync(file, 'utf8'));
  const own = json.compilerOptions?.customConditions;
  if (Array.isArray(own)) return own;
  const parents = Array.isArray(json.extends) ? json.extends : json.extends ? [json.extends] : [];
  for (const parent of parents) {
    if (typeof parent !== 'string' || !parent.startsWith('.')) continue;
    const parentFile = resolve(dirname(file), parent.endsWith('.json') ? parent : parent + '.json');
    const inherited = readCustomConditions(parentFile, seen);
    if (inherited.length > 0) return inherited;
  }
  return [];
}

/** JSON with comments and trailing commas, as tsconfig allows. */
export function parseJsonc(text: string): any {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i === 0) break;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
