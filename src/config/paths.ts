// Filesystem paths — every location the automaton writes to lives here.
//
// Functions (not constants) because we want each call to re-read env vars.
// That lets tests set `process.env.TITON_HOME = tmpdir` before each case
// without restarting the module system.
//
// Two env overrides:
//   TITON_HOME        — root directory. Defaults to ~/.titon.
//   AUTOMATON_CONFIG  — absolute path to an alternate config.json (skips
//                        the default filename under TITON_HOME/automaton/).

import { homedir } from 'os';
import { join } from 'path';

export function titonHome(): string {
    return process.env.TITON_HOME ?? join(homedir(), '.titon');
}

export function automatonDir(): string {
    return join(titonHome(), 'automaton');
}

export function configPath(): string {
    return process.env.AUTOMATON_CONFIG ?? join(automatonDir(), 'config.json');
}

export function walletPath(): string {
    return join(automatonDir(), 'wallet.enc');
}

export function statePath(): string {
    return join(automatonDir(), 'state.json');
}

export function lockPath(): string {
    return join(automatonDir(), 'automaton.lock');
}

export function logsDir(): string {
    return join(automatonDir(), 'logs');
}
