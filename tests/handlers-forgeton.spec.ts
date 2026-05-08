// forgetonAwarenessHandler + forgetonHealthHandler — every event-kind
// branch the handlers explicitly switch on, plus the address-filter
// invariant (events naming OTHER must be silently dropped).
//
// These two factories cover lines 177-229 and 246-276 of
// src/worker/handlers.ts — the hottest unit-level gap surfaced by the
// coverage report. The selfSlash + consumerWatch branches already have
// tests in events.spec.ts; this file rounds out the file.

import { Address, toNano } from '@ton/core';
import type { ForgetonEvent } from '@titon-network/forgeton-sdk';
import {
    forgetonAwarenessHandler,
    forgetonHealthHandler,
    selfSlashHandler,
} from '../src/worker/handlers';
import { captureLogger } from './helpers/logger';
import { fakeAddress, fakeTxContext } from './helpers/fixtures';

const ME = Address.parse('0QBsK1tN7AiqL_Hovc1p6HdWC8tYFZ4wt-Jch1vg9arryx5N');
const OTHER = Address.parse('0QC52I0pIiF_041o-njvpvjc3UzrnzhMCW3T41IoVhllyHhA');
const CONSUMER = fakeAddress(0xcc);

describe('forgetonAwarenessHandler', () => {
    describe('stake-lifecycle events filter on automaton == me', () => {
        it.each([
            { kind: 'AutomatonRegistered', extras: { stake: toNano('100') } },
            { kind: 'StakeIncreased', extras: { addedStake: toNano('1'), totalStake: toNano('101') } },
            { kind: 'UnstakeRequested', extras: { availableAt: 9_999_999 } },
            { kind: 'UnstakeCancelled', extras: {} },
            { kind: 'Unstaked', extras: { amount: toNano('100'), remainingStake: 0n } },
        ])('logs at info when $kind names me', async ({ kind, extras }) => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event = { kind, opcode: 0, automaton: ME, ...extras } as unknown as ForgetonEvent;
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toHaveLength(1);
            expect(messages[0]!.level).toBe('info');
            expect(messages[0]!.msg).toContain(`forgeton: ${kind} for self`);
        });

        it.each([
            { kind: 'AutomatonRegistered', extras: { stake: toNano('100') } },
            { kind: 'StakeIncreased', extras: { addedStake: toNano('1'), totalStake: toNano('101') } },
            { kind: 'UnstakeRequested', extras: { availableAt: 9_999_999 } },
            { kind: 'UnstakeCancelled', extras: {} },
            { kind: 'Unstaked', extras: { amount: toNano('100'), remainingStake: 0n } },
        ])('silently drops $kind for OTHER', async ({ kind, extras }) => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event = { kind, opcode: 0, automaton: OTHER, ...extras } as unknown as ForgetonEvent;
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toEqual([]);
        });
    });

    describe('AutomatonOptInChanged', () => {
        it('logs at info when this automaton flips opt-in for some consumer', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'AutomatonOptInChanged',
                opcode: 0,
                automaton: ME,
                consumer: CONSUMER,
                isOptedIn: true,
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toHaveLength(1);
            expect(messages[0]!.level).toBe('info');
            expect(messages[0]!.msg).toContain('opt-in flag changed for self');
            expect(messages[0]!.fields?.consumer).toBe(CONSUMER.toString());
            expect(messages[0]!.fields?.isOptedIn).toBe(true);
        });

        it('silently drops AutomatonOptInChanged for OTHER', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'AutomatonOptInChanged',
                opcode: 0,
                automaton: OTHER,
                consumer: CONSUMER,
                isOptedIn: true,
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toEqual([]);
        });
    });

    describe('AutomatonPruned', () => {
        it('logs at warn when owner prunes this automaton', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'AutomatonPruned',
                opcode: 0,
                automaton: ME,
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toHaveLength(1);
            expect(messages[0]!.level).toBe('warn');
            expect(messages[0]!.msg).toContain('PRUNED');
        });

        it('silently drops AutomatonPruned for OTHER', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'AutomatonPruned',
                opcode: 0,
                automaton: OTHER,
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toEqual([]);
        });
    });

    describe('PausedChanged', () => {
        it('logs at warn on pause (does NOT filter — pool-wide signal)', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'PausedChanged',
                opcode: 0,
                isPaused: true,
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toHaveLength(1);
            expect(messages[0]!.level).toBe('warn');
            expect(messages[0]!.msg).toContain('PAUSED');
        });

        it('logs at info on unpause', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'PausedChanged',
                opcode: 0,
                isPaused: false,
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toHaveLength(1);
            expect(messages[0]!.level).toBe('info');
            expect(messages[0]!.msg).toContain('resumed');
        });
    });

    describe('ForceSyncTriggered', () => {
        it('logs at info when owner force-syncs this automaton', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'ForceSyncTriggered',
                opcode: 0,
                automaton: ME,
                isActive: true,
                consumerCount: 3,
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toHaveLength(1);
            expect(messages[0]!.level).toBe('info');
            expect(messages[0]!.msg).toContain('ForceSync for self');
            expect(messages[0]!.fields?.isActive).toBe(true);
            expect(messages[0]!.fields?.consumerCount).toBe(3);
        });

        it('silently drops ForceSyncTriggered for OTHER', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'ForceSyncTriggered',
                opcode: 0,
                automaton: OTHER,
                isActive: true,
                consumerCount: 3,
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toEqual([]);
        });
    });

    describe('events outside the awareness scope', () => {
        it('silently drops ForgetonConfigUpdated (handled by health handler instead)', async () => {
            const { log, messages } = captureLogger();
            const handler = forgetonAwarenessHandler(ME, log);

            const event: ForgetonEvent = {
                kind: 'ForgetonConfigUpdated',
                opcode: 0,
                minStake: toNano('100'),
                unstakeCooldown: 86_400,
                syncGasCost: toNano('0.05'),
                minStorageReserve: toNano('1'),
                minGasForRegister: toNano('0.5'),
                minGasForUnstake: toNano('0.5'),
                maxSlashPerConsumerPerDay: toNano('1000'),
            };
            await handler.on!.pool!(event, fakeTxContext());

            expect(messages).toEqual([]);
        });
    });
});

describe('forgetonHealthHandler', () => {
    it('logs ForgetonConfigUpdated at info with the new tunables', async () => {
        const { log, messages } = captureLogger();
        const handler = forgetonHealthHandler(log);

        const event: ForgetonEvent = {
            kind: 'ForgetonConfigUpdated',
            opcode: 0,
            minStake: toNano('200'),
            unstakeCooldown: 172_800,
            syncGasCost: toNano('0.06'),
            minStorageReserve: toNano('1'),
            minGasForRegister: toNano('0.5'),
            minGasForUnstake: toNano('0.5'),
            maxSlashPerConsumerPerDay: toNano('2000'),
        };
        await handler.on!.pool!(event, fakeTxContext());

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('pool config updated');
        expect(messages[0]!.fields?.minStake).toBe(toNano('200').toString());
        expect(messages[0]!.fields?.unstakeCooldown).toBe(172_800);
        expect(messages[0]!.fields?.syncGasCost).toBe(toNano('0.06').toString());
    });

    it('logs ConsumerSlashCapUpdated at info with the new cap', async () => {
        const { log, messages } = captureLogger();
        const handler = forgetonHealthHandler(log);

        const event: ForgetonEvent = {
            kind: 'ConsumerSlashCapUpdated',
            opcode: 0,
            consumer: CONSUMER,
            maxSlashPerEvent: toNano('5'),
        };
        await handler.on!.pool!(event, fakeTxContext());

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('info');
        expect(messages[0]!.msg).toContain('consumer slash cap updated');
        expect(messages[0]!.fields?.consumer).toBe(CONSUMER.toString());
        expect(messages[0]!.fields?.maxSlashPerEvent).toBe(toNano('5').toString());
    });

    it('logs CodeUpdated at warn (operator may need to re-sync SDK)', async () => {
        const { log, messages } = captureLogger();
        const handler = forgetonHealthHandler(log);

        const event: ForgetonEvent = {
            kind: 'CodeUpdated',
            opcode: 0,
            codeHash: 0xdeadbeefn,
            oldCodeHash: 0xcafef00dn,
            timestamp: 1_700_000_000,
        };
        await handler.on!.pool!(event, fakeTxContext());

        expect(messages).toHaveLength(1);
        expect(messages[0]!.level).toBe('warn');
        expect(messages[0]!.msg).toContain('pool code upgraded');
        expect(messages[0]!.fields?.codeHash).toBe('deadbeef');
        expect(messages[0]!.fields?.oldCodeHash).toBe('cafef00d');
    });

    it('silently drops events outside its scope (e.g. AutomatonRegistered)', async () => {
        const { log, messages } = captureLogger();
        const handler = forgetonHealthHandler(log);

        const event: ForgetonEvent = {
            kind: 'AutomatonRegistered',
            opcode: 0,
            automaton: ME,
            stake: toNano('100'),
        };
        await handler.on!.pool!(event, fakeTxContext());

        expect(messages).toEqual([]);
    });

    it('silently drops AutomatonSlashed (selfSlashHandler handles that)', async () => {
        const { log, messages } = captureLogger();
        const handler = forgetonHealthHandler(log);

        const event: ForgetonEvent = {
            kind: 'AutomatonSlashed',
            opcode: 0,
            automaton: ME,
            slasher: OTHER,
            reason: 1,
            amount: toNano('1'),
            remainingStake: toNano('99'),
            slashCount: 1,
        };
        await handler.on!.pool!(event, fakeTxContext());

        expect(messages).toEqual([]);
    });
});

describe('selfSlashHandler — webhook non-OK status', () => {
    it('logs an error when the webhook responds with a non-OK status', async () => {
        const { log, messages } = captureLogger();
        const fakeFetch = async (): Promise<Response> => new Response('rate limited', { status: 429 });
        const handler = selfSlashHandler({
            me: ME,
            logger: log,
            webhookUrl: 'https://example.com/hook',
            fetch: fakeFetch as unknown as typeof fetch,
        });

        const event: ForgetonEvent = {
            kind: 'AutomatonSlashed',
            opcode: 0,
            automaton: ME,
            slasher: OTHER,
            reason: 1,
            amount: toNano('0.5'),
            remainingStake: toNano('9.5'),
            slashCount: 1,
        };
        await handler.on!.pool!(event, fakeTxContext());

        // Detached POST — yield once so the .then/.finally chain runs.
        await new Promise((r) => setImmediate(r));

        const errLine = messages.find(
            (m) => m.level === 'error' && m.msg.includes('webhook POST non-OK'),
        );
        expect(errLine).toBeDefined();
        expect(errLine!.fields?.status).toBe(429);
        expect(errLine!.fields?.url).toBe('https://example.com/hook');
    });
});
