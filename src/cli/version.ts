// Read the package version at runtime so `automaton --version` matches
// whatever is actually installed. Avoids drift between a hardcoded constant
// and the published package.json.

import { readFileSync } from 'fs';
import { join } from 'path';

interface PackageJson {
    version: string;
}

export function pkgVersion(): string {
    // dist/cli/version.js → ../../package.json
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
    return pkg.version;
}
