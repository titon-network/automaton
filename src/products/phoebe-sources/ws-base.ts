// Shared WebSocket plumbing for CEX adapters. Every adapter (Binance,
// Coinbase, Kraken, etc.) inherits one persistent connection with the
// following hardening:
//
//   - Equal-jitter exponential backoff (1s → 30s cap, full jitter)
//   - Per-attempt connect timeout (default 15s) so a stuck TCP/TLS
//     handshake doesn't pin a "connecting" forever
//   - Silence timeout (default 60s) — force-reconnect if no messages
//     have arrived since either the last tick OR connect (catches
//     "connected but server stopped streaming" — common after the
//     remote hits a rolling restart and forgets our subscription)
//   - Heartbeat ping/pong with bounded pong deadline (default 10s)
//   - Backoff reset only after STABLE_UPTIME_MS (60s) of healthy
//     connection — prevents a flapping endpoint from re-trying at
//     the 1s floor every cycle
//   - All timers cleaned up on every close path (open-timeout,
//     silence-timer, ping-timer, pong-deadline)
//
// Subclasses implement `url()`, `subscribeMessage(symbols)`, and
// `handleMessage(raw, emit)`. They don't touch the socket directly.
//
// `ws` is loaded lazily so tests that exercise only the aggregator
// don't fail when the package isn't installed.

import type { PriceSource, SourceLogger, TickCallback } from './types';

type RawWebSocket = {
    on(
        event: 'open' | 'close' | 'error' | 'message' | 'pong' | 'ping',
        cb: (...args: any[]) => void,
    ): void;
    send(data: string): void;
    close(code?: number): void;
    ping?(data?: unknown): void;
    readyState: number;
};

interface WsClientOpts {
    /** Max bytes per inbound frame (zip-bomb defense). */
    maxPayload?: number;
    /** Disable permessage-deflate — a 1 KB compressed frame can decode
     *  to a 100 MiB payload (zip bomb). We don't need compression at
     *  the volumes CEX market data runs at. */
    perMessageDeflate?: boolean;
    /** Reject non-UTF-8 — every CEX sends valid JSON; non-UTF-8 is
     *  either corruption or attack. */
    skipUTF8Validation?: boolean;
}

interface WsCtor {
    new (url: string, opts?: WsClientOpts): RawWebSocket;
    OPEN: number;
}

let cachedWsCtor: WsCtor | null = null;
async function loadWs(): Promise<WsCtor> {
    if (cachedWsCtor !== null) return cachedWsCtor;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('ws') as { default?: WsCtor } & WsCtor;
    cachedWsCtor = (mod as any).default ?? mod;
    return cachedWsCtor!;
}

/** Internal hook for tests — lets a mock WebSocket constructor replace
 *  the real `ws` import. Tests call `setWsCtor(MockCtor)` before
 *  starting adapters and `setWsCtor(null)` to restore. */
export function setWsCtor(ctor: WsCtor | null): void {
    cachedWsCtor = ctor;
}

const HEALTH_MAX_GAP_MS = 30_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_SILENCE_TIMEOUT_MS = 60_000;
const DEFAULT_PONG_TIMEOUT_MS = 10_000;
const DEFAULT_STABLE_UPTIME_MS = 60_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1_048_576; // 1 MiB — CEX tick frames are <1 KB
const PERSISTENT_FAILURE_THRESHOLD = 10;

export interface WsAdapterOpts {
    readonly logger: SourceLogger;
    /** Initial backoff in ms. Doubles up to `maxBackoffMs`. Default 1_000. */
    readonly initialBackoffMs?: number;
    /** Cap on exponential backoff. Default 30_000. */
    readonly maxBackoffMs?: number;
    /** Per-attempt connect timeout. If `open` doesn't fire within this
     *  window, the socket is force-closed and the next backoff cycle
     *  begins. Default 15_000. */
    readonly connectTimeoutMs?: number;
    /** Force-reconnect threshold after the LAST inbound message (or
     *  open, whichever is later). Default 60_000 — long enough that a
     *  legitimately quiet pair doesn't churn the connection, short
     *  enough that a server that silently stopped streaming gets
     *  caught within a minute. */
    readonly silenceTimeoutMs?: number;
    /** Maximum delay between sending a ping and receiving the matching
     *  pong before we treat the connection as half-open and reconnect.
     *  Default 10_000. */
    readonly pongTimeoutMs?: number;
    /** Connection must remain open this long without a close event
     *  before we reset the backoff floor. Default 60_000. */
    readonly stableUptimeMs?: number;
    /** Max bytes per inbound frame. Default 1 MiB — defense against
     *  a hostile or compromised server sending a single 100 MiB
     *  payload to OOM the daemon. */
    readonly maxPayloadBytes?: number;
    /** Injected sleep — defaults to setTimeout. Tests inject a deterministic shim. */
    readonly sleep?: (ms: number) => Promise<void>;
    /** Injected clock — defaults to Date.now. */
    readonly nowMs?: () => number;
}

export abstract class WsAdapterBase implements PriceSource {
    abstract readonly name: string;

    protected readonly logger: SourceLogger;
    private readonly initialBackoffMs: number;
    private readonly maxBackoffMs: number;
    private readonly connectTimeoutMs: number;
    private readonly silenceTimeoutMs: number;
    private readonly pongTimeoutMs: number;
    private readonly stableUptimeMs: number;
    private readonly maxPayloadBytes: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly nowMs: () => number;

    private ws: RawWebSocket | null = null;
    private symbols: readonly string[] = [];
    private emit: TickCallback = () => undefined;
    private lastTickMs = 0;
    private stopped = false;
    private connectLoop: Promise<void> | null = null;
    /** Per-source counter that resets on any successful open. After
     *  PERSISTENT_FAILURE_THRESHOLD consecutive failed attempts we
     *  escalate from warn → error so misconfigured URLs / dead
     *  endpoints surface in operator alerting rather than getting
     *  buried in the reconnect noise. */
    private consecutiveFailures = 0;
    /** Reference to the subscribed-symbols Set — adapters use this
     *  to drop ticks for symbols a hostile feed echoes that we
     *  didn't subscribe to (defense against cache-OOM). */
    protected subscribedSymbols: ReadonlySet<string> = new Set();

    constructor(opts: WsAdapterOpts) {
        this.logger = opts.logger;
        this.initialBackoffMs = opts.initialBackoffMs ?? 1_000;
        this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
        this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
        this.silenceTimeoutMs = opts.silenceTimeoutMs ?? DEFAULT_SILENCE_TIMEOUT_MS;
        this.pongTimeoutMs = opts.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
        this.stableUptimeMs = opts.stableUptimeMs ?? DEFAULT_STABLE_UPTIME_MS;
        this.maxPayloadBytes = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
        this.sleep =
            opts.sleep ??
            ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        this.nowMs = opts.nowMs ?? (() => Date.now());
    }

    protected abstract url(): string;
    protected abstract subscribeMessage(symbols: readonly string[]): string;
    protected abstract handleMessage(raw: string, emit: TickCallback): void;

    /** Subclass hook: send ping frames every `pingIntervalMs` once
     *  open. The base class enforces a pong-deadline tied to each ping.
     *  Default = null (no heartbeat). Coinbase/Kraken use this; Binance
     *  doesn't need it (the upstream sends its own keepalive). */
    protected pingIntervalMs(): number | null {
        return null;
    }

    async start(symbols: readonly string[], onTick: TickCallback): Promise<void> {
        if (this.connectLoop !== null) {
            throw new Error(`${this.name}: start() called twice without stop()`);
        }
        this.symbols = symbols;
        this.subscribedSymbols = new Set(symbols);
        this.emit = (symbol, tick) => {
            // Race guard: messages that arrive between stop() and
            // close-handler cleanup must NOT flow downstream — the
            // manager may already be tearing down its consumers.
            if (this.stopped) return;
            // Cache-OOM defense: drop ticks for symbols we didn't
            // subscribe to. A hostile or buggy server echoing
            // arbitrary symbols (or sending a stream for an unrelated
            // pair) would otherwise grow the manager's cache Map
            // without bound.
            if (!this.subscribedSymbols.has(symbol)) return;
            this.lastTickMs = this.nowMs();
            onTick(symbol, tick);
        };
        this.stopped = false;
        // Kick off the connect/reconnect loop in the background. We do
        // NOT await first-message — bootstrap continues regardless of
        // which exchanges are slow to deliver. The loop survives until
        // stop().
        this.connectLoop = this.runConnectLoop().catch((err) => {
            this.logger.error(`${this.name}: connect loop crashed`, {
                error: err instanceof Error ? err.message : String(err),
            });
        });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        const ws = this.ws;
        this.ws = null;
        if (ws !== null) {
            try {
                ws.close();
            } catch {
                // swallow — already closing
            }
        }
        if (this.connectLoop !== null) {
            await this.connectLoop;
            this.connectLoop = null;
        }
    }

    isHealthy(): boolean {
        const Ws = cachedWsCtor;
        if (Ws === null) return false;
        if (this.ws === null) return false;
        if (this.ws.readyState !== Ws.OPEN) return false;
        if (this.lastTickMs === 0) return false;
        return this.nowMs() - this.lastTickMs <= HEALTH_MAX_GAP_MS;
    }

    private async runConnectLoop(): Promise<void> {
        await loadWs();
        let backoffMs = this.initialBackoffMs;

        while (!this.stopped) {
            const openedAt = await this.connectOnce();
            if (openedAt !== null) {
                // Any successful open resets the persistent-failure
                // counter; the backoff floor only resets once we've
                // sustained the connection for stableUptimeMs.
                this.consecutiveFailures = 0;
                const stableFor = this.nowMs() - openedAt;
                if (stableFor >= this.stableUptimeMs) {
                    backoffMs = this.initialBackoffMs;
                }
            } else {
                this.consecutiveFailures += 1;
                // Escalate to error so misconfigured URLs / dead
                // endpoints surface in operator alerting rather than
                // get buried in reconnect noise.
                if (this.consecutiveFailures === PERSISTENT_FAILURE_THRESHOLD) {
                    this.logger.error(`${this.name}: persistent connect failure`, {
                        consecutiveFailures: this.consecutiveFailures,
                        url: this.url(),
                        hint: 'check endpoint URL, DNS, TLS, and connectivity',
                    });
                }
            }
            if (this.stopped) break;
            // Equal-jitter: sleep base/2 + random(0, base/2).
            const half = backoffMs / 2;
            const jitter = Math.floor(Math.random() * half);
            const sleepFor = half + jitter;
            this.logger.warn(`${this.name}: reconnecting`, { sleepMs: sleepFor });
            await this.sleep(sleepFor);
            backoffMs = Math.min(backoffMs * 2, this.maxBackoffMs);
        }
    }

    /** Per-source health/diagnostics — exposed for `doctor` /
     *  `/readyz` so the operator can see whether a specific source
     *  is in a persistent-failure state without grepping logs. */
    consecutiveFailureCount(): number {
        return this.consecutiveFailures;
    }

    /** Open one ws connection; resolve when it closes (cleanly or
     *  forcibly). Returns the open-event timestamp (ms) on success so
     *  the loop can decide whether to reset backoff, or null if open
     *  never fired. */
    private async connectOnce(): Promise<number | null> {
        const Ws = await loadWs();
        const url = this.url();
        let ws: RawWebSocket;
        try {
            // Frame-size cap + no permessage-deflate: zip-bomb defense.
            // A hostile / compromised exchange endpoint must not be
            // able to OOM the daemon with one 100 MiB frame or a
            // 1 KB compressed frame that decodes to gigabytes.
            ws = new Ws(url, {
                maxPayload: this.maxPayloadBytes,
                perMessageDeflate: false,
                skipUTF8Validation: false,
            });
        } catch (err) {
            this.logger.warn(`${this.name}: construct failed`, {
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        }
        this.ws = ws;

        return new Promise<number | null>((resolve) => {
            let openedAt: number | null = null;
            let pingTimer: NodeJS.Timeout | null = null;
            let pongDeadline: NodeJS.Timeout | null = null;
            let silenceTimer: NodeJS.Timeout | null = null;
            let connectTimer: NodeJS.Timeout | null = null;
            let resolved = false;

            const forceClose = (reason: string): void => {
                this.logger.warn(`${this.name}: force-close`, { reason });
                try {
                    ws.close();
                } catch {
                    // already closing
                }
            };

            const cleanup = (): void => {
                if (pingTimer !== null) {
                    clearInterval(pingTimer);
                    pingTimer = null;
                }
                if (pongDeadline !== null) {
                    clearTimeout(pongDeadline);
                    pongDeadline = null;
                }
                if (silenceTimer !== null) {
                    clearTimeout(silenceTimer);
                    silenceTimer = null;
                }
                if (connectTimer !== null) {
                    clearTimeout(connectTimer);
                    connectTimer = null;
                }
                if (this.ws === ws) this.ws = null;
            };

            const bumpSilenceTimer = (): void => {
                if (silenceTimer !== null) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                    forceClose('silence-timeout');
                }, this.silenceTimeoutMs);
            };

            // Connect-attempt deadline: if `open` doesn't fire within
            // `connectTimeoutMs`, kill the socket and let the backoff
            // loop reconnect. Without this, a hung TCP/TLS handshake
            // can pin the loop forever.
            connectTimer = setTimeout(() => {
                if (openedAt === null) {
                    forceClose('connect-timeout');
                }
            }, this.connectTimeoutMs);

            ws.on('open', () => {
                openedAt = this.nowMs();
                if (connectTimer !== null) {
                    clearTimeout(connectTimer);
                    connectTimer = null;
                }
                this.logger.info(`${this.name}: connected`, { url });
                try {
                    ws.send(this.subscribeMessage(this.symbols));
                } catch (err) {
                    this.logger.warn(`${this.name}: subscribe send failed`, {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                bumpSilenceTimer();

                const pingMs = this.pingIntervalMs();
                if (pingMs !== null && typeof ws.ping === 'function') {
                    pingTimer = setInterval(() => {
                        try {
                            ws.ping!();
                        } catch {
                            return;
                        }
                        // Arm a pong deadline. If pong doesn't arrive
                        // in time, the connection is half-open —
                        // force-close + reconnect.
                        if (pongDeadline !== null) clearTimeout(pongDeadline);
                        pongDeadline = setTimeout(() => {
                            forceClose('pong-timeout');
                        }, this.pongTimeoutMs);
                    }, pingMs);
                }
            });

            ws.on('pong', () => {
                if (pongDeadline !== null) {
                    clearTimeout(pongDeadline);
                    pongDeadline = null;
                }
                // Pongs count as activity — bump silence timer.
                bumpSilenceTimer();
            });

            ws.on('message', (data: unknown) => {
                bumpSilenceTimer();
                const raw = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
                try {
                    this.handleMessage(raw, this.emit);
                } catch (err) {
                    this.logger.warn(`${this.name}: parse error`, {
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            });

            ws.on('error', (err: Error) => {
                // The `error` event is informational on `ws`; the
                // socket emits `close` right after. We log and let
                // the close-handler do the resolve.
                this.logger.warn(`${this.name}: ws error`, { error: err.message });
            });

            ws.on('close', () => {
                cleanup();
                if (resolved) return;
                resolved = true;
                this.logger.info(`${this.name}: disconnected`, {
                    everOpened: openedAt !== null,
                });
                resolve(openedAt);
            });
        });
    }
}
