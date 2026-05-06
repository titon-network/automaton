import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    testTimeout: 30_000,
    maxWorkers: 1,
    workerIdleMemoryLimit: '1GB',
    // Fail-fast environment sanity checks — see tests/preflight.ts.
    globalSetup: '<rootDir>/tests/preflight.ts',
};

export default config;
