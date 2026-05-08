// `automaton init` — first-run setup.
//
// Two modes:
//   - Interactive (the default when run on a TTY). Walks the operator
//     through network choice, wallet creation / import, password entry,
//     and confirmation before anything hits disk.
//   - Non-interactive (when every required flag is supplied). Intended
//     for CI / Docker / Ansible, where the human has already generated
//     a mnemonic and stored the password in a secret store.
//
// Flags:
//   --network <testnet|mainnet>   — skips the network prompt
//   --import-mnemonic <file>      — skips the create-vs-import + paste prompt
//   --password-file <file>        — skips the password + confirm prompts
//   --rpc-url <url>               — pin the RPC endpoint URL (skips the prompt)
//   --rpc-api-key <key>           — attach an apiKey to the RPC endpoint
//
// When every required flag is set and stdin is not a TTY, no prompts fire.
// Partial flag sets narrow the interactive flow — e.g. `--network=testnet`
// alone skips only step 1. `--rpc-url` defaults to the public toncenter
// endpoint for the chosen network when omitted (rate-limited ~1 req/s);
// operators with their own RPC pass `--rpc-url ...` (and optionally
// `--rpc-api-key ...`). Both flags edit only the freshly-written config —
// the keystore is RPC-agnostic.
//
// Anti-overwrite guard:
//   If either config.json or wallet.enc already exists, `init` refuses
//   rather than silently overwrite. The operator can re-run after
//   `rm`ing both, or point at a clean TITON_HOME. We also hold the
//   automaton lockfile during init so two concurrent invocations can't
//   race past the fresh-install check.
//
// Crash safety:
//   Keystore is written first, config second. If the config write fails
//   mid-run (disk-full, EACCES), we roll back the keystore so the next
//   init attempt doesn't hit the fresh-install guard with only half the
//   state present.
//
// Security note:
//   The generate-new-mnemonic branch prints 24 words to stdout. We gate
//   it behind a confirmation prompt ("have you written it down?") to
//   reduce accidental scroll-back leakage. For CI / scripted onboarding,
//   operators should generate the mnemonic out-of-band and use
//   --import-mnemonic instead; the generate branch is interactive-only.

import { existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import { Command } from 'commander';
import { fromNano } from '@ton/core';
import { FORGETON_DEFAULTS } from '@titon-network/forgeton-sdk';
import {
    configPath,
    defaultConfig,
    saveConfig,
    walletPath,
    type Network,
} from '../../config';
import { NetworkSchema, EndpointSchema, type Endpoint } from '../../config/schema';
import { acquireLock, releaseLock } from '../../chain/lockfile';
import {
    generateMnemonic,
    getPasswordWithConfirmation,
    lockKeystore,
    saveKeystore,
    validateMnemonic,
    walletFromMnemonic,
    type LockOptions,
} from '../../wallet';
import { promptChoice, promptConfirm, promptText } from '../prompt';

// A 24-word BIP-39 mnemonic is ~200 bytes. Caps at 4 KB so a misrouted
// file path (e.g. /etc/shadow) surfaces as "too large" instead of silently
// loading megabytes. Password files likewise: a reasonable operator
// password fits in 256 bytes; anything bigger is almost certainly the
// wrong file.
const MAX_MNEMONIC_FILE_BYTES = 4 * 1024;
const MAX_PASSWORD_FILE_BYTES = 256;

interface InitOptions {
    network?: string;
    importMnemonic?: string;
    passwordFile?: string;
    rpcUrl?: string;
    rpcApiKey?: string;
}

/** Test-only hook — drops scrypt work factor so the suite doesn't take minutes. */
export interface RunInitOverrides {
    kdfN?: number;
}

export function registerInitCommand(program: Command): void {
    program
        .command('init')
        .description(
            'First-run setup — writes ~/.titon/automaton/{config.json,wallet.enc}. Interactive by default; pass --network / --import-mnemonic / --password-file / --rpc-url / --rpc-api-key for non-interactive runs.',
        )
        .option('--network <network>', 'testnet or mainnet (skips the prompt)')
        .option(
            '--import-mnemonic <file>',
            'path to a file containing a 24-word mnemonic; whitespace-separated. Skips the create-vs-import flow.',
        )
        .option(
            '--password-file <file>',
            'path to a file containing the keystore password. Skips the password + confirmation prompts.',
        )
        .option(
            '--rpc-url <url>',
            'TON RPC endpoint URL. Defaults to the public toncenter endpoint for the chosen network (rate-limited ~1 req/s). Pass your own to use toncenter pro, dton.io, a self-hosted `ton-http-api`, or any other JSON-RPC compatible endpoint.',
        )
        .option(
            '--rpc-api-key <key>',
            'API key for the RPC endpoint (sent as `?api_key=...` per toncenter convention). Optional — omit for free public endpoints or self-hosted instances that do not require auth.',
        )
        .action(async (options: InitOptions) => {
            await runInit(options);
        });
}

export async function runInit(
    options: InitOptions,
    overrides: RunInitOverrides = {},
): Promise<void> {
    const configFile = configPath();
    const walletFile = walletPath();

    // Check before any prompts fire — we shouldn't waste the operator's
    // time asking for a new mnemonic just to refuse to write it.
    assertNoExistingInstall(configFile, walletFile);

    // Acquire the shared automaton lock so two concurrent init invocations
    // can't race past the fresh-install check. Also blocks init while the
    // daemon is running — overwriting the keystore out from under a live
    // process would be a footgun worth actively preventing.
    acquireLock();
    try {
        const network = await resolveNetwork(options.network);
        const mnemonic = await resolveMnemonic(options.importMnemonic);
        const password = await resolvePassword(options.passwordFile);
        const endpoints = await resolveEndpoints(network, options.rpcUrl, options.rpcApiKey);

        const lockOpts: LockOptions = {};
        if (overrides.kdfN !== undefined) lockOpts.kdfN = overrides.kdfN;
        const keystore = await lockKeystore(mnemonic, password, network, lockOpts);

        saveKeystore(keystore, walletFile);
        try {
            const cfg = defaultConfig(network);
            cfg.endpoints = endpoints;
            saveConfig(cfg, configFile);
        } catch (err) {
            // Roll back the keystore so the next init attempt isn't locked
            // out by the fresh-install guard seeing half-written state.
            try {
                unlinkSync(walletFile);
            } catch (rollbackErr) {
                // Rollback failed — the wallet file is orphaned. Surface it
                // so the operator knows to clean up before re-running init
                // (the fresh-install guard will refuse otherwise, with
                // confusing "refusing to overwrite" output).
                const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
                process.stderr.write(
                    `warn: keystore rollback failed (${msg}); ` +
                        `delete ${walletFile} manually before re-running 'automaton init'.\n`,
                );
            }
            throw err;
        }

        printSuccess({
            configFile,
            walletFile,
            network,
            address: keystore.address,
            endpoint: endpoints[0]!,
        });
    } finally {
        releaseLock();
    }
}

function assertNoExistingInstall(configFile: string, walletFile: string): void {
    const existing: string[] = [];
    if (existsSync(configFile)) existing.push(configFile);
    if (existsSync(walletFile)) existing.push(walletFile);
    if (existing.length > 0) {
        throw new Error(
            `refusing to overwrite existing files:\n` +
                existing.map((p) => `  ${p}`).join('\n') +
                `\n\nRemove them first, or set TITON_HOME to a clean directory.`,
        );
    }
}

async function resolveNetwork(flag: string | undefined): Promise<Network> {
    if (flag !== undefined) {
        const parsed = NetworkSchema.safeParse(flag);
        if (!parsed.success) {
            throw new Error(
                `--network must be one of ${NetworkSchema.options.join(' | ')}, got: ${flag}`,
            );
        }
        return parsed.data;
    }
    return promptChoice<Network>('Network?', ['testnet', 'mainnet'], { default: 'testnet' });
}

async function resolveMnemonic(importFile: string | undefined): Promise<string[]> {
    if (importFile !== undefined) {
        const words = readMnemonicFile(importFile);
        if (!(await validateMnemonic(words))) {
            throw new Error(
                `--import-mnemonic: file does not contain a valid 24-word BIP-39 mnemonic: ${importFile}`,
            );
        }
        return words;
    }

    const choice = await promptChoice('Wallet', ['new', 'import'], { default: 'new' });
    if (choice === 'import') return promptMnemonicPaste();
    return generateAndConfirmMnemonic();
}

async function promptMnemonicPaste(): Promise<string[]> {
    process.stdout.write(
        '\n  Paste your 24-word mnemonic (space- or newline-separated).\n' +
            '  Warning: the words will ECHO to the terminal as you type.\n\n',
    );
    while (true) {
        const raw = await promptText('Mnemonic');
        const words = raw.split(/\s+/).filter((w) => w.length > 0);
        if (await validateMnemonic(words)) return words;
        process.stdout.write(
            `  Not a valid 24-word BIP-39 mnemonic (got ${words.length} word(s)). Try again.\n`,
        );
    }
}

function readFlagFile(flag: string, path: string, maxBytes: number): string {
    let size: number;
    try {
        size = statSync(path).size;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${flag}: cannot read file: ${msg}`);
    }
    if (size > maxBytes) {
        throw new Error(
            `${flag}: file ${path} is ${size} bytes (max ${maxBytes}). ` +
                `Refusing to load — this is almost certainly the wrong file.`,
        );
    }
    try {
        return readFileSync(path, 'utf8');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`${flag}: cannot read file: ${msg}`);
    }
}

function readMnemonicFile(path: string): string[] {
    const raw = readFlagFile('--import-mnemonic', path, MAX_MNEMONIC_FILE_BYTES);
    return raw.split(/\s+/).filter((w) => w.length > 0);
}

async function generateAndConfirmMnemonic(): Promise<string[]> {
    const mnemonic = await generateMnemonic();
    process.stdout.write(
        '\n  WARNING: the next 24 words are your ONLY key to recover this wallet.\n' +
            '  Write them down on paper and store them somewhere safe BEFORE continuing.\n\n',
    );
    for (let i = 0; i < mnemonic.length; i += 6) {
        const row = mnemonic
            .slice(i, i + 6)
            .map((w, j) => `${String(i + j + 1).padStart(2, ' ')}. ${w.padEnd(9, ' ')}`)
            .join('  ');
        process.stdout.write(`    ${row}\n`);
    }
    process.stdout.write('\n');

    const confirmed = await promptConfirm(
        'Have you written the mnemonic down in a safe place?',
        { default: false },
    );
    if (!confirmed) {
        throw new Error(
            'aborting: mnemonic not confirmed as backed up. No files were written.',
        );
    }
    return mnemonic;
}

async function resolvePassword(passwordFile: string | undefined): Promise<string> {
    if (passwordFile !== undefined) {
        const raw = readFlagFile('--password-file', passwordFile, MAX_PASSWORD_FILE_BYTES);
        // Strip every trailing line terminator (handles LF, CRLF, and mixed).
        // `echo "pw" > file` produces a trailing LF; Windows editors produce
        // CRLF. A password ending in whitespace is almost certainly a mistake.
        const password = raw.replace(/[\r\n]+$/, '');
        if (password.length === 0) {
            throw new Error(`--password-file: ${passwordFile} is empty`);
        }
        return password;
    }
    return getPasswordWithConfirmation();
}

async function resolveEndpoints(
    network: Network,
    urlFlag: string | undefined,
    apiKeyFlag: string | undefined,
): Promise<Endpoint[]> {
    // Treat an empty-string apiKey from the shell (`--rpc-api-key ''`) as
    // "no key". An empty-string apiKey written to config.json would round-
    // trip through the schema (`z.string().optional()` accepts ""), but the
    // intent is always "no auth", never "auth with empty string".
    const normalizedKey = apiKeyFlag !== undefined && apiKeyFlag.length > 0 ? apiKeyFlag : undefined;

    // Flag-driven path: short-circuit prompts entirely. `--rpc-api-key`
    // alone (no `--rpc-url`) means "use the default URL but attach this
    // key" — the common shape for a toncenter-pro upgrade.
    if (urlFlag !== undefined || normalizedKey !== undefined) {
        const url = urlFlag ?? defaultConfig(network).endpoints[0]!.url;
        return [parseFlagEndpoint(url, normalizedKey)];
    }
    // Non-TTY (CI) path with no flags: use the network default. We don't
    // prompt because `promptConfirm` would throw NotInteractiveError; the
    // operator who hits this branch has already passed every other flag
    // (network / mnemonic / password) and just hasn't pinned an RPC.
    if (!process.stdin.isTTY) {
        return defaultConfig(network).endpoints;
    }
    const useDefault = await promptConfirm(
        `Use the public toncenter ${network} RPC (rate-limited ~1 req/s)?`,
        { default: true },
    );
    if (useDefault) return defaultConfig(network).endpoints;

    return [await promptCustomEndpoint()];
}

/** Validate a flag-supplied endpoint. Throws on parse failure with the flag-name prefix the operator can correlate to their CLI invocation. */
function parseFlagEndpoint(url: string, apiKey: string | undefined): Endpoint {
    const candidate = { url, ...(apiKey !== undefined ? { apiKey } : {}) };
    const parsed = EndpointSchema.safeParse(candidate);
    if (!parsed.success) {
        const issues = parsed.error.issues.map((issue) => issue.message).join('; ');
        throw new Error(`--rpc-url: invalid endpoint (${issues})`);
    }
    return parsed.data;
}

/** Interactive endpoint prompt with retry-on-invalid. Mirrors `promptMnemonicPaste`'s "ask again until valid" loop — typos shouldn't kill the whole `init` flow. */
async function promptCustomEndpoint(): Promise<Endpoint> {
    while (true) {
        const url = await promptText('RPC URL');
        const rawKey = await promptText('API key (blank for none)', { allowEmpty: true });
        const apiKey = rawKey.length > 0 ? rawKey : undefined;
        const candidate = { url, ...(apiKey !== undefined ? { apiKey } : {}) };
        const parsed = EndpointSchema.safeParse(candidate);
        if (parsed.success) return parsed.data;
        const issues = parsed.error.issues.map((issue) => issue.message).join('; ');
        process.stdout.write(`  Invalid endpoint (${issues}). Try again.\n`);
    }
}

function printSuccess(details: {
    configFile: string;
    walletFile: string;
    network: Network;
    address: string;
    endpoint: Endpoint;
}): void {
    const minStake = fromNano(FORGETON_DEFAULTS.minStake);
    const minFund = Number(minStake) + 1;
    const endpointKey = details.endpoint.apiKey === undefined ? '(no apiKey)' : '(apiKey set)';
    process.stdout.write(
        `\n  Wallet address (${details.network}, non-bounceable): ${details.address}\n` +
            `  Keystore:                               ${details.walletFile}\n` +
            `  Config:                                 ${details.configFile}\n` +
            `  RPC endpoint:                           ${details.endpoint.url} ${endpointKey}\n` +
            `\n` +
            `  Next steps:\n` +
            `    automaton doctor                 # verify install\n` +
            `    # Fund the wallet address above with at least ${minFund} TON (${minStake} stake + 1 gas reserve).\n` +
            `    automaton stake register <amount>  # register on-chain with collateral\n` +
            `    automaton run                      # start the daemon\n`,
    );
}
