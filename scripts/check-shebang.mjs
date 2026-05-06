#!/usr/bin/env node
// Post-build safety check — verifies that the compiled CLI entry still
// starts with a `#!/usr/bin/env node` shebang. TypeScript's `tsc` does
// preserve the shebang in the emitted JS, but a future tsconfig tweak
// (e.g. switching to `bundler` module resolution) could silently drop
// it, and the resulting bin would fail with `SyntaxError` when invoked
// directly via `./dist/cli/index.js`.
//
// Also checks:
//   - no UTF-8 BOM (would shift the shebang past position 0)
//   - file exists (sanity)
//
// Runs as part of `prepublishOnly` — a broken bin ships to npm
// otherwise.

import { readFileSync, existsSync } from 'node:fs';

const CLI = 'dist/cli/index.js';

if (!existsSync(CLI)) {
    console.error(`check-shebang: ${CLI} not found — did 'pnpm run build' run?`);
    process.exit(1);
}

const buf = readFileSync(CLI);

// BOM: EF BB BF at the head shifts everything by 3 bytes.
if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    console.error(`check-shebang: ${CLI} has a UTF-8 BOM — shebang will not be honoured`);
    process.exit(1);
}

if (buf[0] !== 0x23 /* # */ || buf[1] !== 0x21 /* ! */) {
    console.error(`check-shebang: ${CLI} is missing the '#!' shebang`);
    process.exit(1);
}

const firstLine = buf.slice(0, buf.indexOf(0x0a /* \n */)).toString('utf8');
if (!/node/.test(firstLine)) {
    console.error(`check-shebang: ${CLI} shebang does not reference node — got '${firstLine}'`);
    process.exit(1);
}

console.log(`check-shebang: ${CLI} OK (${firstLine})`);
