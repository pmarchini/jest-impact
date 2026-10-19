// Preload for Jest (NODE_OPTIONS=--require) that records, per test file, every
// file the test reads while it runs. Jest workers run one test file at a time,
// so each read between a Runtime's creation and its teardown belongs to that test.
//
// TRACE_ROOT: workspace root (absolute, trailing slash). TRACE_DIR: output dir.
// Writes one JSON object per test to TRACE_DIR/<pid>.jsonl:
//   { test, files, packages, reads }
// `files` and `packages` are what the test depends on: every module Jest's
// registry executed for it, plus every non-code file it read. `reads` is every
// workspace file read, which also includes files ts-jest only type-checks.
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = process.env.TRACE_ROOT;
const outDir = process.env.TRACE_DIR;
const realReadFileSync = fs.readFileSync;
const realAppend = fs.appendFileSync;

let current; // { test, files: Set, packages: Set, reads: Set }
const CODE = /\.[cm]?[jt]sx?$/;

function packageOf(file) {
  const rest = file.slice(file.lastIndexOf('/node_modules/') + '/node_modules/'.length).split('/');
  return rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

function record(file) {
  if (!current || typeof file !== 'string' || !file.startsWith(root)) return;
  if (file.includes('/node_modules/')) {
    if (!CODE.test(file)) current.packages.add(packageOf(file));
    return;
  }
  const rel = file.slice(root.length);
  current.reads.add(rel);
  // The resolver reads every package.json it passes; one the test requires shows up as a module instead.
  if (!CODE.test(file) && path.basename(file) !== 'package.json') current.files.add(rel);
}

function recordModule(file) {
  if (!current || typeof file !== 'string' || !file.startsWith(root)) return;
  if (file.includes('/node_modules/')) current.packages.add(packageOf(file));
  else current.files.add(file.slice(root.length));
}

/** Every module the runtime has executed; called before the registry is cleared. */
function harvest(runtime) {
  for (const registry of [runtime._moduleRegistry, runtime._isolatedModuleRegistry, runtime._esmoduleRegistry, runtime._cjsNamedExports]) {
    if (registry && typeof registry.keys === 'function') for (const key of registry.keys()) recordModule(key);
  }
}

function flush() {
  if (!current) return;
  const line = JSON.stringify({ test: current.test, files: [...current.files].sort(), packages: [...current.packages].sort(), reads: [...current.reads].sort() });
  realAppend.call(fs, path.join(outDir, `${process.pid}.jsonl`), line + '\n');
  current = undefined;
}

fs.readFileSync = function (file, ...rest) {
  record(typeof file === 'string' ? file : file instanceof URL ? file.pathname : undefined);
  return realReadFileSync.call(this, file, ...rest);
};
const realReadFile = fs.readFile;
fs.readFile = function (file, ...rest) {
  record(typeof file === 'string' ? file : undefined);
  return realReadFile.call(this, file, ...rest);
};

// jest-runner constructs one Runtime per test file: (config, env, resolver, transformer, cacheFS, options, testPath).
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  const loaded = realLoad.call(this, request, ...rest);
  if (request !== 'jest-runtime' || loaded.__traced) return loaded;
  const Runtime = loaded.default;
  class TracedRuntime extends Runtime {
    constructor(...args) {
      flush();
      const testPath = args[6];
      current = { test: testPath.slice(root.length), files: new Set([testPath.slice(root.length)]), packages: new Set(), reads: new Set() };
      super(...args);
    }
    _execModule(localModule, ...args) {
      recordModule(localModule.filename);
      return super._execModule(localModule, ...args);
    }
    resetModules(...args) {
      harvest(this);
      return super.resetModules(...args);
    }
    teardown(...args) {
      harvest(this);
      const result = super.teardown(...args);
      flush();
      return result;
    }
  }
  return new Proxy(loaded, {
    get: (target, key) => (key === 'default' ? TracedRuntime : key === '__traced' ? true : target[key]),
  });
};

process.on('exit', flush);
