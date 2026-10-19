import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import { createRequire, isBuiltin } from 'node:module';
import { dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import vm from 'node:vm';
import { transform } from 'sucrase';

/**
 * Evaluates Jest config files without requiring the workspace to be installed.
 *
 * Local files (the config, presets it points at, helpers it requires, and
 * workspace packages they import) are transpiled with sucrase and run
 * in-process, fresh for each config, so code that reads process.cwd() sees the
 * directory of the config being loaded. Installed packages are required for
 * real; otherwise a stub stands in and the package name is recorded, so the
 * caller knows the config may be incomplete.
 */
export class ConfigEvaluator {
  readonly missingPackages = new Set<string>();
  private readonly cache = new Map<string, unknown>();
  /** Local files and package names each evaluated file required. */
  private readonly localDeps = new Map<string, Set<string>>();
  private readonly packageDeps = new Map<string, Set<string>>();
  private readonly fallbacks: Record<string, unknown>;

  constructor(fallbacks: Record<string, unknown> = {}) {
    this.fallbacks = fallbacks;
  }

  /** Loads a config file and resolves a function or promise export to a plain object. */
  async loadConfig(file: string): Promise<Record<string, unknown>> {
    if (file.endsWith('.json')) {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    }
    // A shared module can compute its exports from process.cwd(), so another config's copy is stale.
    this.cache.clear();
    let value = this.loadModule(file);
    value = interopDefault(value);
    if (typeof value === 'function') {
      value = await (value as () => unknown)();
    }
    value = await value;
    if (value === null || typeof value !== 'object') {
      throw new Error(`Jest config ${file} did not export an object`);
    }
    return value as Record<string, unknown>;
  }

  /** Requires a package the way the config at `fromFile` would, falling back to a stub. */
  requirePackage(specifier: string, fromFile: string): unknown {
    if (specifier in this.fallbacks) {
      try {
        return createRequire(fromFile)(specifier);
      } catch {
        return this.fallbacks[specifier];
      }
    }
    try {
      return createRequire(fromFile)(specifier);
    } catch {
      this.missingPackages.add(packageName(specifier));
      return missingModuleStub();
    }
  }

  /**
   * The file a bare specifier names when it is a workspace package rather than
   * an installed one: it resolves, through a symlink or not, outside node_modules.
   */
  workspaceModule(specifier: string, fromFile: string): string | undefined {
    if (isBuiltin(specifier)) return undefined;
    let file: string;
    try {
      file = realpathSync(createRequire(fromFile).resolve(specifier));
    } catch {
      return undefined;
    }
    if (file.split(sep).includes('node_modules')) return undefined;
    return LOCAL_EXTENSIONS.includes(extname(file)) ? file : undefined;
  }

  /** Every local file and package a config file pulled in, directly or through other local files. */
  dependenciesOf(file: string): { files: string[]; packages: string[] } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const visit = (current: string) => {
      if (files.has(current)) return;
      files.add(current);
      for (const name of this.packageDeps.get(current) ?? []) packages.add(name);
      for (const dep of this.localDeps.get(current) ?? []) visit(dep);
    };
    visit(file);
    return { files: [...files], packages: [...packages] };
  }

  loadModule(file: string): unknown {
    if (this.cache.has(file)) return this.cache.get(file);
    if (file.endsWith('.json')) {
      const json = JSON.parse(readFileSync(file, 'utf8'));
      this.cache.set(file, json);
      return json;
    }
    const source = readFileSync(file, 'utf8');
    const code = transform(source, {
      transforms: needsTypeScript(file) ? ['typescript', 'imports'] : ['imports'],
      filePath: file,
    }).code;
    const module = { exports: {} as unknown };
    this.cache.set(file, module.exports);
    const locals = new Set<string>();
    const packages = new Set<string>();
    this.localDeps.set(file, locals);
    this.packageDeps.set(file, packages);
    const localRequire = (specifier: string): unknown => {
      if (specifier.startsWith('.') || isAbsolute(specifier)) {
        const target = resolveLocal(resolve(dirname(file), specifier));
        if (target) {
          locals.add(target);
          return this.loadModule(target);
        }
      }
      const workspaceFile = this.workspaceModule(specifier, file);
      if (workspaceFile) {
        locals.add(workspaceFile);
        return this.loadModule(workspaceFile);
      }
      if (!isBuiltin(specifier)) packages.add(packageName(specifier));
      return this.requirePackage(specifier, file);
    };
    localRequire.resolve = (specifier: string, options?: { paths?: string[] }): string => {
      if (specifier.startsWith('.') || isAbsolute(specifier)) {
        const target = resolveLocal(resolve(dirname(file), specifier));
        if (target) return target;
      }
      try {
        return createRequire(file).resolve(specifier, options);
      } catch {
        this.missingPackages.add(packageName(specifier));
        return join(dirname(file), 'node_modules', specifier);
      }
    };
    const wrapper = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname) {${code}\n})`,
      { filename: file },
    ) as (...args: unknown[]) => void;
    wrapper(module.exports, localRequire, module, file, dirname(file));
    this.cache.set(file, module.exports);
    return module.exports;
  }
}

const LOCAL_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];

export function resolveLocal(path: string): string | undefined {
  if (isFile(path)) return path;
  for (const ext of LOCAL_EXTENSIONS) {
    if (isFile(path + ext)) return path + ext;
  }
  for (const ext of LOCAL_EXTENSIONS) {
    const index = resolve(path, 'index' + ext);
    if (isFile(index)) return index;
  }
  return undefined;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function needsTypeScript(file: string): boolean {
  return ['.ts', '.mts', '.cts'].includes(extname(file));
}

export function interopDefault(value: unknown): unknown {
  if (value && typeof value === 'object' && '__esModule' in value && 'default' in value) {
    return (value as { default: unknown }).default;
  }
  return value;
}

export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

/**
 * A value that tolerates any use: property access, calls, spreading and
 * awaiting. Spreading it contributes no keys.
 */
function missingModuleStub(): unknown {
  const target = () => undefined;
  const handler: ProxyHandler<typeof target> = {
    get(_target, key) {
      if (key === 'then') return undefined;
      if (key === Symbol.toPrimitive) return () => '';
      if (key === '__esModule') return false;
      return stub;
    },
    apply() {
      return stub;
    },
    construct() {
      return stub as object;
    },
    ownKeys() {
      return [];
    },
    getOwnPropertyDescriptor() {
      return undefined;
    },
  };
  const stub: unknown = new Proxy(target, handler);
  return stub;
}
