// `automaton bls ...` — BLS12-381 identity + Atlas share lifecycle.
//
// Subcommands:
//   keygen           — generate a new random BLS secret, encrypt + save
//   pubkey           — print the G1 pkShare (no password; public-readable)
//   register         — submit RegisterBlsShare to Atlas (enters the DKG set)
//   deregister       — submit DeregisterBlsShare (leaves the DKG set)
//
// The BLS secret is held in a separate encrypted keystore (bls.enc) from
// the TON wallet (wallet.enc). Same scrypt+AES-GCM discipline; today the
// password is shared (single unlock on daemon startup).

import { Command } from 'commander';
import { fromNano, toNano, type OpenedContract, type Sender } from '@ton/core';
import { Atlas, DEFAULT_GROUP_ID } from '@titon-network/atlas-sdk';
import type { AtlasConfigReply, GroupKeyReply, OperatorShareReply } from '@titon-network/atlas-sdk';

import { loadConfig } from '../../config';
import {
    blsKeystoreExists,
    loadBlsKeystore,
    lockBlsKeystore,
    randomBlsSecret,
    saveBlsKeystore,
    unlockBlsKeystore,
} from '../../bls';
import {
    getPassword,
    getPasswordWithConfirmation,
    loadKeystore,
    unlockKeystore,
    type AutomatonWallet,
} from '../../wallet';
import {
    buildChainRuntime,
    sendAndConfirm,
    senderFor,
    type ChainRuntime,
} from '../../chain';
import { blsPath } from '../../config/paths';

// Headroom above Atlas's own `minGasForRegister` floor so the message has
// breathing room for fwd/fees even if the chain is under load.
const ATLAS_GAS_BUFFER = toNano('0.05');
// Buffer for the wallet's own tx on top of the attached value — same
// rationale as WALLET_GAS_BUFFER in stake.ts.
const WALLET_GAS_BUFFER = toNano('0.1');

export function registerBlsCommand(program: Command): void {
    const bls = program
        .command('bls')
        .description(
            'BLS12-381 identity and Atlas share lifecycle. Required when products.fortuna is enabled.',
        );

    bls.command('keygen')
        .description('Generate a new random BLS secret and encrypt it to disk (bls.enc).')
        .option('--force', 'overwrite any existing bls.enc without confirmation', false)
        .action(async (opts: { force: boolean }) => {
            await handleKeygen(opts);
        });

    bls.command('pubkey')
        .description('Print the public G1 pkShare (hex) from bls.enc. No password required.')
        .action(async () => {
            await handlePubkey();
        });

    bls.command('register')
        .description(
            'Register the BLS pkShare at Atlas (submits RegisterBlsShare). ' +
                'Must be admitted at ForgeTON first (run `automaton stake register` beforehand).',
        )
        .option('--group-id <id>', 'Atlas groupId (default 0)', '0')
        .action(async (opts: { groupId: string }) => {
            await handleRegister(opts);
        });

    bls.command('deregister')
        .description('Deregister the BLS pkShare at Atlas (submits DeregisterBlsShare).')
        .option('--group-id <id>', 'Atlas groupId (default 0)', '0')
        .action(async (opts: { groupId: string }) => {
            await handleDeregister(opts);
        });
}

async function handleKeygen(opts: { force: boolean }): Promise<void> {
    if (blsKeystoreExists() && !opts.force) {
        throw new Error(
            `BLS keystore already exists at ${blsPath()}. ` +
                `Re-run with --force to overwrite, or delete the file first.\n` +
                `  WARNING: overwriting discards the secret. If the corresponding pkShare is ` +
                `registered at Atlas, you will need to deregister + re-register after keygen.`,
        );
    }

    const password = await getPasswordWithConfirmation(
        'New BLS keystore password: ',
        'Confirm BLS keystore password: ',
    );

    process.stdout.write('  Generating BLS secret (BLS12-381 min-pk)...\n');
    const secret = randomBlsSecret();
    const blob = lockBlsKeystore(secret, password);
    saveBlsKeystore(blob);

    process.stdout.write(
        `  Saved: ${blsPath()}\n` +
            `  pkShare: ${blob.publicKey}\n\n` +
            `  Next steps:\n` +
            `    1. Back up ${blsPath()} safely — this is your BLS secret.\n` +
            `    2. Register the share at Atlas:\n` +
            `         automaton bls register\n`,
    );
}

async function handlePubkey(): Promise<void> {
    const blob = loadBlsKeystore();
    process.stdout.write(blob.publicKey + '\n');
}

interface BlsContext {
    runtime: ChainRuntime;
    atlas: OpenedContract<Atlas>;
    wallet: AutomatonWallet;
    sender: Sender;
    blsPublicKey: string;
    atlasConfig: AtlasConfigReply;
    existing: OperatorShareReply | null;
    groupId: number;
}

async function loadBlsContext(groupIdRaw: string): Promise<BlsContext> {
    const groupId = parseGroupId(groupIdRaw);

    const config = loadConfig();
    if (!config.products.fortuna) {
        throw new Error(
            'config.products.fortuna is false. Enable it in config.json (and add the ' +
                'atlas/fortuna addresses under config.fortuna) before registering a BLS share.',
        );
    }

    const walletKeystore = loadKeystore();
    const blsKeystore = loadBlsKeystore();
    const runtime = buildChainRuntime(config);

    const atlas = runtime.products.fortuna?.atlas as
        | import('@ton/core').OpenedContract<import('@titon-network/atlas-sdk').Atlas>
        | undefined;
    if (atlas === undefined) {
        throw new Error(
            'chain runtime has no Atlas handle — this is a bug (products.fortuna was true ' +
                'but the fortuna ProductModule did not supply an atlas contract).',
        );
    }

    const password = await getPassword({ prompt: 'Keystore password: ' });
    const wallet = await unlockKeystore(walletKeystore, password);
    // Unlock BLS to validate the password also decrypts it — catches "forgot
    // the BLS password" before sending the tx. We don't keep the secret here;
    // `register` doesn't need it (only the pubkey goes on-chain), and
    // `deregister` needs nothing at all.
    unlockBlsKeystore(blsKeystore, password);

    const [atlasConfig, existing] = await Promise.all([
        atlas.getConfig(),
        atlas.getOperatorShare(groupId, wallet.address),
    ]);

    return {
        runtime,
        atlas,
        wallet,
        sender: senderFor(runtime.client, wallet),
        blsPublicKey: blsKeystore.publicKey,
        atlasConfig,
        existing,
        groupId,
    };
}

async function handleRegister(opts: { groupId: string }): Promise<void> {
    const ctx = await loadBlsContext(opts.groupId);

    if (ctx.existing !== null && ctx.existing.hasShare) {
        const onChainPk = ctx.existing.pkShare.toString('hex');
        if (onChainPk === ctx.blsPublicKey) {
            throw new Error(
                `BLS share already registered at Atlas with this exact pkShare. ` +
                    `Nothing to do — the automaton is in the active set for group ${ctx.groupId}.`,
            );
        }
        throw new Error(
            `a DIFFERENT BLS share is registered at Atlas for this wallet:\n` +
                `  on-chain pkShare: ${onChainPk}\n` +
                `  local    pkShare: ${ctx.blsPublicKey}\n` +
                `Run \`automaton bls deregister\` first, then re-register.`,
        );
    }

    // Atlas enforces that the operator is active in ForgeTON before accepting
    // RegisterBlsShare. Pre-check so the error is explanatory instead of a raw
    // E_NOT_ACTIVE revert.
    const poolRecord = await ctx.runtime.pool.getAutomaton(ctx.wallet.address);
    if (poolRecord === null) {
        throw new Error(
            'not registered at ForgeTON. Run `automaton stake register <amount>` first.',
        );
    }
    if (!poolRecord.isActive) {
        throw new Error(
            'ForgeTON record is not active. Atlas will reject RegisterBlsShare on inactive operators.',
        );
    }

    // Solo-mode pkShare-vs-groupPk tripwire — see assertSoloModeGroupMatch
    // below for the why. The check fires only when memberCount=1 +
    // threshold=1; multi-op DKG groups are skipped because individual
    // pkShares are aggregate contributions, not equal to groupPk.
    const groupKey = await ctx.atlas.getGroupKey(ctx.groupId);
    assertSoloModeGroupMatch(groupKey, ctx.blsPublicKey);

    const value = ctx.atlasConfig.minGasForRegister + ATLAS_GAS_BUFFER;
    await assertWalletFunded(ctx, value);

    const pkShare = Buffer.from(ctx.blsPublicKey, 'hex');

    process.stdout.write(
        `  Submitting RegisterBlsShare (group=${ctx.groupId}, value=${fromNano(value)} TON)...\n` +
            `    pkShare: ${ctx.blsPublicKey}\n`,
    );

    const result = await sendAndConfirm(
        ctx.runtime.client,
        ctx.wallet,
        () =>
            ctx.atlas.sendRegisterBlsShare(ctx.sender, {
                value,
                groupId: ctx.groupId,
                pkShare,
            }),
        {
            verify: async () => {
                const post = await ctx.atlas.getOperatorShare(ctx.groupId, ctx.wallet.address);
                if (post === null || !post.hasShare) {
                    throw new Error(
                        'atlas.getOperatorShare(me) returned no registered share after send',
                    );
                }
                if (post.pkShare.toString('hex') !== ctx.blsPublicKey) {
                    throw new Error(
                        `atlas stored pkShare ${post.pkShare.toString('hex')}, expected ${ctx.blsPublicKey}`,
                    );
                }
            },
            origin: 'atlas',
        },
    );

    process.stdout.write(
        `  Verified (seqno ${result.seqnoBefore} → ${result.seqnoAfter}).\n` +
            `  Tx:   ${result.txHash}\n` +
            `  View: ${result.explorerUrl}\n`,
    );
}

async function handleDeregister(opts: { groupId: string }): Promise<void> {
    const ctx = await loadBlsContext(opts.groupId);

    if (ctx.existing === null || !ctx.existing.hasShare) {
        throw new Error(
            `no BLS share registered at Atlas for group ${ctx.groupId}. Nothing to deregister.`,
        );
    }

    const value = ctx.atlasConfig.minGasForRegister + ATLAS_GAS_BUFFER;
    await assertWalletFunded(ctx, value);

    process.stdout.write(
        `  Submitting DeregisterBlsShare (group=${ctx.groupId}, value=${fromNano(value)} TON)...\n`,
    );

    const result = await sendAndConfirm(
        ctx.runtime.client,
        ctx.wallet,
        () =>
            ctx.atlas.sendDeregisterBlsShare(ctx.sender, {
                value,
                groupId: ctx.groupId,
            }),
        {
            verify: async () => {
                const post = await ctx.atlas.getOperatorShare(ctx.groupId, ctx.wallet.address);
                if (post !== null && post.hasShare) {
                    throw new Error('atlas still reports a registered share after deregister');
                }
            },
            origin: 'atlas',
        },
    );

    process.stdout.write(
        `  Verified (seqno ${result.seqnoBefore} → ${result.seqnoAfter}).\n` +
            `  Tx:   ${result.txHash}\n` +
            `  View: ${result.explorerUrl}\n`,
    );
}

async function assertWalletFunded(ctx: BlsContext, value: bigint): Promise<void> {
    const required = value + WALLET_GAS_BUFFER;
    const balance = await ctx.runtime.client.getBalance(ctx.wallet.address);
    if (balance < required) {
        throw new Error(
            `wallet balance ${fromNano(balance)} TON is below required ${fromNano(required)} TON. ` +
                `Fund ${ctx.wallet.address.toString({ bounceable: false })} first.`,
        );
    }
}

/**
 * Solo-mode pkShare-vs-groupPk tripwire (defense-in-depth).
 *
 * Atlas now ENFORCES `pkShare == groupPk` on-chain in solo-mode (see
 * `atlas/contracts/atlas.tolk:handleRegisterBlsShare` — reverts with
 * `E_SOLO_PK_SHARE_MISMATCH = 161`). This pre-flight catches the same
 * mismatch BEFORE the tx is sent so the operator gets a clear error and
 * doesn't burn registration gas on a guaranteed revert.
 *
 * Correct solo-mode onboarding flow:
 *   1. Operator: `automaton bls keygen` → generates own secret, owns the
 *      bls.enc keystore.
 *   2. Operator: `automaton bls pubkey` → prints the 48-byte (96-hex)
 *      G1 pkShare. **This is public** — safe to share over any channel.
 *   3. Operator hands the pkShare hex to the Atlas-owner / protocol team.
 *   4. Atlas owner: `pnpm run publish:groupkey:testnet -- --pkshare <hex>`
 *      — publishes that pkShare AS groupPk (1-shot per groupId).
 *   5. Operator: `automaton bls register` — Atlas's on-chain invariant
 *      `pkShare == groupPk` succeeds because the operator's pkShare is
 *      exactly what was published.
 *
 * If this pre-flight fires, something has drifted out-of-band: a fresh
 * `automaton bls keygen` overwrote the keystore, the wrong bls.enc was
 * copied, or the publishGroupKey script was run with a different operator's
 * pkShare. The fix is to either restore the keystore that matches groupPk,
 * or rotate the group (3-step timelock) to adopt a new pkShare.
 *
 * The check fires only when `memberCount=1, threshold=1` (solo). In a real
 * DKG (memberCount > 1), individual pkShares are aggregate contributions
 * and DON'T have to equal groupPk — so this check is correctly skipped on
 * mainnet (which won't ship in solo-mode).
 *
 * Exported for unit testing — see `tests/bls-solo-mode.spec.ts`.
 */
export function assertSoloModeGroupMatch(
    groupKey: GroupKeyReply | null,
    blsPublicKeyHex: string,
): void {
    if (groupKey === null) {
        // No group published yet. Surface a clearer error than the bare
        // E_GROUP_KEY_NOT_SET (140) Atlas would emit on register, since the
        // operator can't unblock themselves — the Atlas owner must publish
        // first. The handleRegister caller still proceeds to send (in case
        // the group is published between this check and the tx); Atlas's
        // contract-level check is the safety net.
        throw new Error(
            'no group key published at Atlas yet (atlas.getGroupKey(0) === null). ' +
                'Hand your `automaton bls pubkey` output to the Atlas owner / protocol team ' +
                'and have them run `pnpm run publish:groupkey:testnet -- --pkshare <your-hex>` ' +
                'in the atlas/ repo before retrying `automaton bls register`. See ' +
                '../atlas/sdk/skills/atlas-operator-register-share.md §"Solo-mode flow".',
        );
    }
    if (groupKey.memberCount !== 1 || groupKey.threshold !== 1) return; // multi-op DKG → skip
    if (groupKey.groupPk.toString('hex') === blsPublicKeyHex) return; // match — solo OK

    throw new Error(
        `solo-mode pkShare mismatch: this Atlas group (epoch ${groupKey.groupEpoch}) was published in ` +
            `solo-mode (memberCount=1, threshold=1) with a groupPk that does NOT match your local pkShare:\n` +
            `  groupPk:        ${groupKey.groupPk.toString('hex')}\n` +
            `  local pkShare:  ${blsPublicKeyHex}\n` +
            `In solo-mode, pkShare must equal groupPk — Atlas enforces this on-chain ` +
            `(E_SOLO_PK_SHARE_MISMATCH = 161); we catch it here so you don't burn gas on a ` +
            `guaranteed revert.\n\n` +
            `Likely causes:\n` +
            `  - your bls.enc was overwritten by a fresh \`automaton bls keygen\` (the new pkShare ` +
            `is unrelated to what was published as groupPk)\n` +
            `  - the wrong bls.enc was copied onto this machine\n` +
            `  - publishSoloGroupKey was run with a different operator's pkShare\n\n` +
            `Fix: restore the bls.enc that matches the published groupPk, OR ask the Atlas owner to ` +
            `rotate the group (3-step timelock) to adopt your current pkShare. Solo-mode is dev/test ` +
            `only — production deployments use multi-op DKG, in which case this check is skipped ` +
            `(individual pkShares are aggregate contributions, not equal to groupPk).`,
    );
}

function parseGroupId(raw: string): number {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0 || n > 255) {
        throw new Error(`--group-id must be 0-255, got: ${raw}`);
    }
    // Today only DEFAULT_GROUP_ID is supported per Atlas v1 (PLAN.md §0.6).
    // Explicit check here — the contract's assertion is a bare revert code
    // which is less helpful than a prose message.
    if (n !== DEFAULT_GROUP_ID) {
        throw new Error(
            `--group-id ${n} is not supported yet. Atlas v1 accepts only groupId ${DEFAULT_GROUP_ID} ` +
                `(single-group operation; multi-group lands in v2).`,
        );
    }
    return n;
}

