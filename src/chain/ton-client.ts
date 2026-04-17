// FailoverTonClient — a drop-in substitute for @ton/ton's `TonClient` that
// keeps a ring of N configured endpoints and, on transient failure, rotates
// to the next endpoint and retries with jittered exponential backoff.
//
// Why two exposure surfaces (`.call` + `.open`):
//   - `.call(fn)` is the primitive: any `(TonClient) => Promise<T>` runs through
//     the failover machinery. Use it for ad-hoc ops (getBalance, sendFile, …).
//   - `.open(contract)` returns an `OpenedContract<T>` whose every method
//     delegates through `.call`, so long-lived wrappers like
//     `KronosRegistry` / `ForgeTON` get failover for free — no per-call site
//     has to know a ring exists.
//
// What counts as "transient":
//   - Node-level network errors: ECONNRESET, ECONNREFUSED, ECONNABORTED,
//     ETIMEDOUT, ENOTFOUND, EAI_AGAIN, EPIPE — surfaced by axios as `code`.
//   - HTTP 429 (rate limit) and 5xx from the upstream — surfaced as
//     `response.status` on the axios error.
//   - Everything else (4xx non-429, malformed-response errors, exit-code
//     throws from runMethod) is permanent: we re-throw immediately so bad
//     requests don't spam the next endpoint.
//
// Backoff is "equal jitter": `sleep = base*2^attempt/2 + random(0, base*2^attempt/2)`,
// capped at maxBackoffMs. This gives decorrelation across N automatons
// retrying the same upstream without any one of them falling to zero delay.

import {
    Address,
    Contract,
    ContractGetMethodResult,
    ContractProvider,
    ContractState,
    OpenedContract,
    Sender,
    SendMode,
    StateInit,
    TupleItem,
    Transaction,
    Cell,
    openContract,
} from '@ton/core';
import { TonClient } from '@ton/ton';

import type { Network } from '../config/schema';
import { jitteredBackoff } from '../errors/backoff';

export interface EndpointSpec {
    url: string;
    apiKey?: string;
}

export interface FailoverTonClientOptions {
    network: Network;
    endpoints: EndpointSpec[];
    /** Per-request axios timeout (ms). Passed straight to TonClient. */
    timeoutMs?: number;
    /** Max total attempts across endpoints per `call` (including the first). */
    maxAttempts?: number;
    /** Base for exponential backoff (ms). Tests typically pass 0. */
    baseBackoffMs?: number;
    /** Cap on a single backoff sleep (ms). */
    maxBackoffMs?: number;
    /** Injected sleep — tests override with a no-op. */
    sleep?: (ms: number) => Promise<void>;
    /** Retry observer — logging / metrics hook. */
    onRetry?: (info: RetryInfo) => void;
}

export interface RetryInfo {
    attempt: number;
    error: unknown;
    fromEndpoint: string;
    nextEndpoint: string;
    sleepMs: number;
}

export class AllEndpointsFailedError extends Error {
    constructor(
        public readonly attempts: number,
        public readonly endpoints: readonly string[],
        public readonly lastError: unknown,
    ) {
        const lastMsg = lastError instanceof Error ? lastError.message : String(lastError);
        super(
            `all ${endpoints.length} endpoint(s) failed after ${attempts} attempt(s). ` +
                `Last error: ${lastMsg}`,
        );
        this.name = 'AllEndpointsFailedError';
        if (lastError instanceof Error && lastError.stack) {
            this.stack = `${this.stack}\nCaused by: ${lastError.stack}`;
        }
    }
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_BACKOFF_MS = 250;
const DEFAULT_MAX_BACKOFF_MS = 8_000;

const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'ERR_NETWORK',
]);

export function isTransientError(err: unknown): boolean {
    if (err === null || typeof err !== 'object') return false;
    const e = err as { code?: unknown; response?: unknown };

    if (typeof e.code === 'string' && NETWORK_ERROR_CODES.has(e.code)) {
        return true;
    }

    const response = e.response as { status?: unknown } | undefined;
    const status = response?.status;
    if (typeof status === 'number') {
        return status === 429 || (status >= 500 && status < 600);
    }

    return false;
}

export class FailoverTonClient {
    readonly network: Network;
    private readonly clients: readonly TonClient[];
    private readonly endpointUrls: readonly string[];
    private cursor = 0;
    private readonly timeoutMs: number;
    private readonly maxAttempts: number;
    private readonly baseBackoffMs: number;
    private readonly maxBackoffMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly onRetry: (info: RetryInfo) => void;

    constructor(options: FailoverTonClientOptions) {
        if (options.endpoints.length === 0) {
            throw new Error('FailoverTonClient requires at least one endpoint');
        }
        this.network = options.network;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
        this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
        this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
        this.sleep = options.sleep ?? defaultSleep;
        this.onRetry = options.onRetry ?? (() => {});

        this.clients = options.endpoints.map(
            (e) => new TonClient({ endpoint: e.url, apiKey: e.apiKey, timeout: this.timeoutMs }),
        );
        this.endpointUrls = options.endpoints.map((e) => e.url);
    }

    /** URL of the endpoint `.call` will hit on the next request. */
    get currentEndpoint(): string {
        return this.endpointUrls[this.cursor]!;
    }

    listEndpoints(): readonly string[] {
        return this.endpointUrls;
    }

    /**
     * Primitive: run `fn(tonClient)` with retry-and-rotate on transient errors.
     *
     * Concurrency caveat: `cursor` is mutated without synchronization. When
     * two `.call` invocations overlap in time, their rotation decisions can
     * interleave and temporarily skip an endpoint. Low impact (the round
     * eventually visits every endpoint) and inherent to the "shared ring"
     * design. Serialise explicitly at the caller if strict per-attempt
     * ordering matters.
     */
    async call<T>(fn: (client: TonClient) => Promise<T>): Promise<T> {
        let lastError: unknown = undefined;
        let attempts = 0;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            const client = this.clients[this.cursor]!;
            attempts = attempt;
            try {
                return await fn(client);
            } catch (err) {
                lastError = err;
                if (!isTransientError(err) || attempt === this.maxAttempts) {
                    break;
                }
                const fromEndpoint = this.endpointUrls[this.cursor]!;
                this.cursor = (this.cursor + 1) % this.clients.length;
                const nextEndpoint = this.endpointUrls[this.cursor]!;
                const sleepMs = jitteredBackoff({
                    attempt,
                    baseMs: this.baseBackoffMs,
                    maxMs: this.maxBackoffMs,
                });
                this.onRetry({ attempt, error: err, fromEndpoint, nextEndpoint, sleepMs });
                if (sleepMs > 0) {
                    await this.sleep(sleepMs);
                }
            }
        }

        if (isTransientError(lastError)) {
            throw new AllEndpointsFailedError(attempts, this.endpointUrls, lastError);
        }
        throw lastError;
    }

    /** Wrap a `Contract` so every provider call (`get*`/`send*`/`is*`) goes through `.call`. */
    open<T extends Contract>(contract: T): OpenedContract<T> {
        return openContract(contract, ({ address, init }) =>
            this.buildProvider(address, init),
        );
    }

    private buildProvider(address: Address, init: StateInit | null): ContractProvider {
        const call = <R>(fn: (client: TonClient) => Promise<R>) => this.call(fn);
        return {
            getState: (): Promise<ContractState> =>
                call((c) => c.provider(address, init).getState()),
            get: (name: string | number, args: TupleItem[]): Promise<ContractGetMethodResult> =>
                call((c) => c.provider(address, init).get(name, args)),
            external: (message: Cell): Promise<void> =>
                call((c) => c.provider(address, init).external(message)),
            internal: (
                via: Sender,
                args: {
                    value: bigint | string;
                    bounce?: boolean | null;
                    sendMode?: SendMode;
                    body?: Cell | string | null;
                },
            ): Promise<void> => call((c) => c.provider(address, init).internal(via, args)),
            open: <U extends Contract>(c: U): OpenedContract<U> => this.open(c),
            getTransactions: (
                addr: Address,
                lt: bigint,
                hash: Buffer,
                limit?: number,
            ): Promise<Transaction[]> =>
                call((c) => c.provider(address, init).getTransactions(addr, lt, hash, limit)),
        };
    }
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
