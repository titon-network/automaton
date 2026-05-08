// Sandbox harness — moved to src/playground/sandbox-runtime.ts so the
// production `automaton playground` command can reuse the same harness
// the integration tests build on. Tests still import via this path; the
// `@ton/test-utils` side-effect import installs jest matchers.

import '@ton/test-utils';

export { createSandboxHarness } from '../../src/playground/sandbox-runtime';
export type { SandboxHarness } from '../../src/playground/sandbox-runtime';
