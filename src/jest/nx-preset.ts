/**
 * Stand-ins for Nx's Jest helpers, used only when the workspace is not
 * installed. They mirror @nx/jest 21+ with Jest 30.
 */
export const NX_JEST_PRESET = {
  testMatch: ['**/?(*.)+(spec|test).?([mc])[jt]s?(x)'],
  resolver: '@nx/jest/plugins/resolver',
  moduleFileExtensions: ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs', 'html'],
  coverageReporters: ['html'],
  transform: {
    '^.+\\.(ts|js|mts|mjs|cts|cjs|html)$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  testEnvironment: 'jsdom',
  modulePathIgnorePatterns: ['<rootDir>/dist/', '<rootDir>/out-tsc/'],
  testEnvironmentOptions: {
    customExportConditions: ['node', 'require', 'default'],
  },
};

export const CONFIG_FALLBACKS: Record<string, unknown> = {
  '@nx/jest/preset': { __esModule: true, default: NX_JEST_PRESET, nxPreset: NX_JEST_PRESET },
  '@nrwl/jest/preset': { __esModule: true, default: NX_JEST_PRESET, nxPreset: NX_JEST_PRESET },
  '@nx/jest': {
    getJestProjects: () => [],
    getJestProjectsAsync: async () => [],
  },
};
