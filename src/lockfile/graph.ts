/** A package manager lockfile reduced to what the change collector needs. */
export type LockGraph = {
  packages: Map<string, LockPackage>;
  /** Ids of the packages each workspace (or the root) declares directly. */
  directDependencies: Set<string>;
};

export type LockPackage = {
  id: string;
  name: string;
  /** Changes whenever the installed content of the package could change. */
  fingerprint: string;
  dependencies: string[];
};

export type LockfileChanges = {
  /** Every package added, removed or changed between the two lockfiles. */
  changedPackages: string[];
  /** Direct dependencies with a changed package anywhere below them. */
  affectedDirectDependencies: string[];
};

export function diffLockGraphs(base: LockGraph, head: LockGraph): LockfileChanges {
  const changedIds = new Set<string>();
  const changedNames = new Set<string>();
  for (const [id, pkg] of head.packages) {
    if (base.packages.get(id)?.fingerprint !== pkg.fingerprint) {
      changedIds.add(id);
      changedNames.add(pkg.name);
    }
  }
  for (const [id, pkg] of base.packages) {
    if (!head.packages.has(id)) changedNames.add(pkg.name);
  }

  const reaches = dependsOnChanged(head, changedIds);
  const affected = new Set<string>();
  for (const id of head.directDependencies) {
    const pkg = head.packages.get(id);
    if (pkg && reaches(id)) affected.add(pkg.name);
  }
  // A direct dependency dropped from head no longer resolves; its importers changed or now fail.
  for (const id of base.directDependencies) {
    if (!head.packages.has(id)) {
      const pkg = base.packages.get(id);
      if (pkg) affected.add(pkg.name);
    }
  }
  return { changedPackages: [...changedNames].sort(), affectedDirectDependencies: [...affected].sort() };
}

/** Marks every package that has a changed package at or below it. */
function dependsOnChanged(graph: LockGraph, changed: Set<string>): (id: string) => boolean {
  const dependents = new Map<string, string[]>();
  for (const pkg of graph.packages.values()) {
    for (const dep of pkg.dependencies) {
      let list = dependents.get(dep);
      if (!list) dependents.set(dep, (list = []));
      list.push(pkg.id);
    }
  }
  const tainted = new Set(changed);
  const queue = [...changed];
  while (queue.length > 0) {
    for (const parent of dependents.get(queue.pop()!) ?? []) {
      if (!tainted.has(parent)) {
        tainted.add(parent);
        queue.push(parent);
      }
    }
  }
  return (id) => tainted.has(id);
}

/** `@scope/name@1.2.3(peer@1)` and `name@npm:1.2.3` both give the package name. */
export function nameFromSpec(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}
