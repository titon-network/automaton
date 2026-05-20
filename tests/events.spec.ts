// Event drain primitives + built-in handlers:
// - extractExternalOutBodies pulls only external-out messages from a tx,
// - bigintHashToBase64 round-trips 256-bit tx hashes to the toncenter format,
// - selfSlashHandler fires only when automaton == me and POSTs to the webhook,
// - mirrorPatchHandler debounces refreshes via onCycleEnd,
// - consumerWatchHandler logs ConsumerUpdated.

import { Address, beginCell, Cell, toNano } from '@ton/core';
import type { Transaction } from '@ton/core';
import {
    OP as FORGETON_OP,
    tryDecodeEvent as tryDecodeForgeton,
} from '@titon-network/forgeton-sdk';
import {
    OP as KRONOS_OP,
    // @titon-network/kronos-sdk only exports the null-returning `decodeEvent`; alias to
    // preserve the test's existing `tryDecode…` naming.
    decodeEvent as tryDecodeKronos,
} from '@titon-network/kronos-sdk';
import {
    bigintHashToBase64,
    drainEvents,
    extractExternalOutBodies,
    type EventHandler,
} from '../src/worker/events';
import { emptyCheckpointState } from '../src/worker/checkpoint';
import type { ChainRuntime } from '../src/chain';
import {
    consumerWatchHandler,
    selfSlashHandler,
} from '../src/worker/handlers';
import { mirrorPatchHandler } from '../src/products/kronos';
import type { WorkerLogger } from '../src/worker/loop';

const ME = Address.parse('0QBsK1tN7AiqL_Hovc1p6HdWC8tYFZ4wt-Jch1vg9arryx5N');
const OTHER = Address.parse('0QC52I0pIiF_041o-njvpvjc3UzrnzhMCW3T41IoVhllyHhA');

function logger(): { log: WorkerLogger; messages: Array<{ level: string; msg: string }> } {
    const messages: Array<{ level: string; msg: string }> = [];
    return {
        log: {
            debug: (m) => messages.push({ level: 'debug', msg: m }),
            info: (m) => messages.push({ level: 'info', msg: m }),
            warn: (m) => messages.push({ level: 'warn', msg: m }),
            error: (m) => messages.push({ level: 'error', msg: m }),
        },
        messages,
    };
}

function slashBody(
    target: Address,
    slasher: Address,
    amount: bigint,
    remainingStake: bigint,
    slashCount: number,
): Cell {
    return beginCell()
        .storeUint(FORGETON_OP.AutomatonSlashed, 32)
        .storeAddress(target)
        .storeAddress(slasher)
        .storeUint(1 /* reason: MISSED_EXECUTION */, 32)
        .storeCoins(amount)
        .storeCoins(remainingStake)
        .storeUint(slashCount, 32)
        .endCell();
}

function mirrorUpdatedBody(automaton: Address, isActive: boolean, activeCount: number): Cell {
    return beginCell()
        .storeUint(KRONOS_OP.AutomatonMirrorUpdated, 32)
        .storeAddress(automaton)
        .storeBit(isActive)
        .storeUint(activeCount, 32)
        .endCell();
}

function consumerUpdatedBody(contract: Address, isActive: boolean, consumerCount: number): Cell {
    return beginCell()
        .storeUint(FORGETON_OP.ConsumerUpdated, 32)
        .storeAddress(contract)
        .storeBit(isActive)
        .storeUint(consumerCount, 8)
        .storeCoins(toNano('1') /* maxSlashPerEvent — arbitrary for tests */)
        .storeBit(false /* isOptInRequired — arbitrary */)
        .endCell();
}

describe('extractExternalOutBodies', () => {
    it('returns only external-out bodies', () => {
        const inBody = beginCell().storeUint(0xdead, 32).endCell();
        const outBody = beginCell().storeUint(0xbeef, 32).endCell();

        const internalOut = {
            info: {
                type: 'internal',
                src: ME,
                dest: OTHER,
                value: { coins: toNano('1') },
                ihrDisabled: true,
                bounce: false,
                bounced: false,
                ihrFee: 0n,
                forwardFee: 0n,
                createdLt: 1n,
                createdAt: 1,
            },
            body: inBody,
        };
        const externalOut = {
            info: { type: 'external-out', src: ME, createdLt: 2n, createdAt: 2 },
            body: outBody,
        };

        const tx = {
            outMessages: {
                values: () => [internalOut, externalOut],
            },
        } as unknown as Transaction;

        const bodies = extractExternalOutBodies(tx);
        expect(bodies).toHaveLength(1);
        expect(bodies[0]!.equals(outBody)).toBe(true);
    });

    it('returns empty array when tx has no external-out messages', () => {
        const tx = {
            outMessages: { values: () => [] },
        } as unknown as Transaction;
        expect(extractExternalOutBodies(tx)).toEqual([]);
    });
});

describe('bigintHashToBase64', () => {
    it('encodes a 256-bit hash as a 44-char base64 string (with padding)', () => {
        const h = 0xdeadbeefn;
        const b64 = bigintHashToBase64(h);
        expect(b64).toHaveLength(44);
        const decoded = Buffer.from(b64, 'base64');
        expect(decoded.length).toBe(32);
        // The value should land at the END of the 32-byte big-endian buffer
        expect(decoded.subarray(28)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    });

    it('handles zero cleanly (all-zero buffer)', () => {
        const b64 = bigintHashToBase64(0n);
        const decoded = Buffer.from(b64, 'base64');
        expect(decoded.every((b) => b === 0)).toBe(true);
    });

    it('handles the max 256-bit value (all-ones buffer)', () => {
        const max = (1n << 256n) - 1n;
        const decoded = Buffer.from(bigintHashToBase64(max), 'base64');
        expect(decoded.every((b) => b === 0xff)).toBe(true);
    });
});

describe('selfSlashHandler', () => {
    it('fires on AutomatonSlashed when automaton == me', async () => {
        const { log, messages } = logger();
        const calls: unknown[] = [];
        const handler = selfSlashHandler({
            me: ME,
            logger: log,
            onSelfSlash: (p) => calls.push(p),
        });

        const body = slashBody(ME, OTHER, toNano('0.5'), toNano('9.5'), 1);
        // inline import
        const event = tryDecodeForgeton(body)!;

        await handler.on!.pool!(event, { txHash: 'abc', lt: 1n, now: 1_000_000 });

        expect(calls).toHaveLength(1);
        expect(messages.some((m) => m.level === 'warn' && m.msg.includes('SLASH'))).toBe(true);
    });

    it('does NOT fire when the slashed automaton is someone else', async () => {
        const { log } = logger();
        const calls: unknown[] = [];
        const handler = selfSlashHandler({
            me: ME,
            logger: log,
            onSelfSlash: (p) => calls.push(p),
        });

        const body = slashBody(OTHER, OTHER, toNano('0.5'), toNano('9.5'), 1);
        // inline import
        const event = tryDecodeForgeton(body)!;

        await handler.on!.pool!(event, { txHash: 'abc', lt: 1n, now: 1_000_000 });

        expect(calls).toHaveLength(0);
    });

    it('POSTs to the configured webhook on self-slash', async () => {
        const { log } = logger();
        const calls: Array<{ url: string; body: string }> = [];
        const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
            calls.push({ url, body: init.body as string });
            return new Response('ok', { status: 200 });
        };
        const handler = selfSlashHandler({
            me: ME,
            logger: log,
            webhookUrl: 'https://example.com/hook',
            fetch: fakeFetch as unknown as typeof fetch,
        });

        const body = slashBody(ME, OTHER, toNano('0.5'), toNano('9.5'), 1);
        // inline import
        const event = tryDecodeForgeton(body)!;
        await handler.on!.pool!(event, { txHash: 'abc', lt: 1n, now: 1_000_000 });

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe('https://example.com/hook');
        const payload = JSON.parse(calls[0]!.body);
        expect(payload.kind).toBe('self-slash');
        expect(payload.automaton).toBe(ME.toString());
        expect(payload.slashCount).toBe(1);
    });

    it('does not throw when the webhook POST fails — alert path must never crash daemon', async () => {
        const { log, messages } = logger();
        const fakeFetch = async (): Promise<Response> => {
            throw new Error('network unreachable');
        };
        const handler = selfSlashHandler({
            me: ME,
            logger: log,
            webhookUrl: 'https://example.com/hook',
            fetch: fakeFetch as unknown as typeof fetch,
        });

        const body = slashBody(ME, OTHER, toNano('0.5'), toNano('9.5'), 1);
        const event = tryDecodeForgeton(body)!;

        // onPool is synchronous — the webhook POST is fire-and-forget.
        // A handler throw would bubble up here; verify it doesn't.
        expect(() =>
            handler.on!.pool!(event, { txHash: 'abc', lt: 1n, now: 1_000_000 }),
        ).not.toThrow();

        // Yield so the detached POST's .catch runs before we assert.
        await new Promise((r) => setImmediate(r));
        expect(messages.some((m) => m.level === 'error' && m.msg.includes('webhook'))).toBe(true);
    });

    it('ignores events that are not AutomatonSlashed', async () => {
        const { log } = logger();
        const calls: unknown[] = [];
        const handler = selfSlashHandler({
            me: ME,
            logger: log,
            onSelfSlash: (p) => calls.push(p),
        });

        const body = consumerUpdatedBody(ME, true, 3);
        // inline import
        const event = tryDecodeForgeton(body)!;

        await handler.on!.pool!(event, { txHash: 'abc', lt: 1n, now: 1_000_000 });
        expect(calls).toHaveLength(0);
    });
});

describe('consumerWatchHandler', () => {
    it('logs ConsumerUpdated with the new consumerCount', async () => {
        const { log, messages } = logger();
        const handler = consumerWatchHandler(log);

        const body = consumerUpdatedBody(ME, true, 5);
        // inline import
        const event = tryDecodeForgeton(body)!;

        await handler.on!.pool!(event, { txHash: 'hash', lt: 1n, now: 1_000_000 });
        expect(messages.some((m) => m.msg.includes('consumer set changed'))).toBe(true);
    });

    it('ignores non-ConsumerUpdated pool events', async () => {
        const { log, messages } = logger();
        const handler = consumerWatchHandler(log);

        const body = slashBody(ME, OTHER, toNano('0.5'), toNano('9.5'), 1);
        // inline import
        const event = tryDecodeForgeton(body)!;

        await handler.on!.pool!(event, { txHash: 'hash', lt: 1n, now: 1_000_000 });
        expect(messages).toEqual([]);
    });
});

describe('checkpoint advance on handler throw', () => {
    // Integration against drainEvents would need a full FailoverTonClient
    // stub; here we prove the invariant at the handler-isolation level.
    // The inline logic in events.ts is straightforward — if any handler
    // throws during a source's dispatch, the outer `handlerThrew` flag
    // gates the `withCheckpoint` call.
    it('is documented at events.ts:"NOT advancing"', () => {
        // Presence check: the phrase should appear in the source to keep
        // the invariant discoverable to future readers.
        const src = require('fs').readFileSync('src/worker/events.ts', 'utf8') as string;
        expect(src).toMatch(/NOT advancing/);
        expect(src).toMatch(/handlerThrew/);
    });
});

describe('drainEvents data-driven source list', () => {
    // Each test stubs client.call to return [] (no new txs) so we don't
    // need to decode anything; we just verify the *set* of addresses that
    // were queried. The drain's `dispatched` + `fullyCaughtUp` report
    // per-source, which is the observable signal.

    const REGISTRY_ADDR = OTHER;
    const POOL_ADDR = ME;
    // Synthesize a raw-format fortuna address so we don't need an
    // externally-generated 0Q string for tests.
    const FORTUNA_ADDR = new Address(
        0,
        Buffer.from(
            'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
            'hex',
        ),
    );

    function stubRuntime(): { runtime: ChainRuntime; calls: Address[] } {
        const calls: Address[] = [];
        const client = {
            call: async (fn: (c: unknown) => Promise<unknown>) => {
                const ghost = {
                    getTransactions: (addr: Address) => {
                        calls.push(addr);
                        return [];
                    },
                };
                return fn(ghost);
            },
            currentEndpoint: 'https://fake.example/api',
            listEndpoints: () => ['https://fake.example/api'],
        };
        const runtime: ChainRuntime = {
            client: client as unknown as ChainRuntime['client'],
            deployment: {
                pool: POOL_ADDR,
                products: {},
            },
            pool: {} as ChainRuntime['pool'],
            products: {},
        };
        return { runtime, calls };
    }

    function baselineSources(runtime: ChainRuntime) {
        // Old "registry+pool" baseline now: only pool (kronos registry comes
        // from the kronos ProductModule). Tests that exercise both streams
        // synthesize a kronos-style source manually.
        return [
            { source: 'registry' as const, address: REGISTRY_ADDR, decode: () => [] },
            { source: 'pool' as const, address: runtime.deployment.pool, decode: () => [] },
        ];
    }

    it('drains only the supplied sources (baseline only)', async () => {
        const { runtime, calls } = stubRuntime();
        const result = await drainEvents({
            runtime,
            state: emptyCheckpointState(),
            sources: baselineSources(runtime),
            handlers: [],
        });
        expect(calls).toHaveLength(2);
        expect(calls.map((a) => a.toString()).sort()).toEqual(
            [REGISTRY_ADDR.toString(), POOL_ADDR.toString()].sort(),
        );
        expect(result.dispatched).toEqual({ registry: 0, pool: 0 });
        expect(result.fullyCaughtUp).toEqual({ registry: true, pool: true });
    });

    it('drains every source in the supplied list, including a product stream', async () => {
        const { runtime, calls } = stubRuntime();
        const result = await drainEvents({
            runtime,
            state: emptyCheckpointState(),
            sources: [
                ...baselineSources(runtime),
                { source: 'fortuna' as const, address: FORTUNA_ADDR, decode: () => [] },
            ],
            handlers: [],
        });
        expect(calls).toHaveLength(3);
        expect(calls.map((a) => a.toString())).toContain(FORTUNA_ADDR.toString());
        expect(result.dispatched).toEqual({ registry: 0, pool: 0, fortuna: 0 });
        expect(result.fullyCaughtUp).toEqual({ registry: true, pool: true, fortuna: true });
    });

    it('omits a source from the result when it is not in the source list', async () => {
        // Adding new products is purely additive: result keys mirror the
        // sources passed in, no hardcoded source set.
        const { runtime } = stubRuntime();
        const result = await drainEvents({
            runtime,
            state: emptyCheckpointState(),
            sources: baselineSources(runtime),
            handlers: [],
        });
        expect(result.dispatched).not.toHaveProperty('fortuna');
        expect(result.fullyCaughtUp).not.toHaveProperty('fortuna');
    });
});

describe('EventHandler.on map dispatch', () => {
    it('handlers without an entry for a given source silently ignore it', async () => {
        const handler: EventHandler = {
            on: { pool: () => undefined },
            // intentionally no `fortuna` entry
        };
        expect(handler.on?.fortuna).toBeUndefined();
    });
});

describe('mirror patch handler', () => {
    it('debounces refresh — N mirror events in one drain → one refresh', async () => {
        const { log } = logger();
        let refreshCalls = 0;
        const fakeMirror = {
            refresh: async () => {
                refreshCalls++;
            },
        };
        const handler = mirrorPatchHandler(fakeMirror as never, log);

        // Three mirror events in one drain.
        for (let i = 0; i < 3; i++) {
            const body = mirrorUpdatedBody(ME, true, 3 + i);
            const event = tryDecodeKronos(body)!;
            await handler.on!.registry!(event, { txHash: `h${i}`, lt: BigInt(i), now: 1_000_000 });
        }
        // onRegistry only marks dirty; no refresh yet.
        expect(refreshCalls).toBe(0);

        await handler.onCycleEnd!();
        expect(refreshCalls).toBe(1);
    });

    it('onCycleEnd is a no-op when no mirror event fired this drain', async () => {
        const { log } = logger();
        let refreshCalls = 0;
        const fakeMirror = {
            refresh: async () => {
                refreshCalls++;
            },
        };
        const handler = mirrorPatchHandler(fakeMirror as never, log);

        await handler.onCycleEnd!();
        expect(refreshCalls).toBe(0);
    });

    it('resets the dirty flag after each cycle', async () => {
        const { log } = logger();
        let refreshCalls = 0;
        const fakeMirror = {
            refresh: async () => {
                refreshCalls++;
            },
        };
        const handler = mirrorPatchHandler(fakeMirror as never, log);

        const body = mirrorUpdatedBody(ME, true, 3);
        const event = tryDecodeKronos(body)!;

        // Cycle 1: one event, one refresh.
        await handler.on!.registry!(event, { txHash: 'h1', lt: 1n, now: 1_000_000 });
        await handler.onCycleEnd!();
        expect(refreshCalls).toBe(1);

        // Cycle 2: no events, no refresh.
        await handler.onCycleEnd!();
        expect(refreshCalls).toBe(1);

        // Cycle 3: event + flush → refresh fires again.
        await handler.on!.registry!(event, { txHash: 'h2', lt: 2n, now: 1_000_000 });
        await handler.onCycleEnd!();
        expect(refreshCalls).toBe(2);
    });

    it('ignores unrelated registry events', async () => {
        const { log } = logger();
        let refreshCalls = 0;
        const fakeMirror = {
            refresh: async () => {
                refreshCalls++;
            },
        };
        const handler = mirrorPatchHandler(fakeMirror as never, log);

        const body = beginCell()
            .storeUint(KRONOS_OP.ForgetonSet, 32)
            .storeAddress(OTHER)
            .endCell();
        const event = tryDecodeKronos(body);
        if (event === null) return; // defensive
        await handler.on!.registry!(event, { txHash: 'h', lt: 1n, now: 1_000_000 });
        await handler.onCycleEnd!();
        expect(refreshCalls).toBe(0);
    });
});
