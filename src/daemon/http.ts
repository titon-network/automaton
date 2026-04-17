// Health + metrics HTTP server.
//
// Exposes three routes on `config.metricsPort`:
//
//   GET /metrics   — prom-client text exposition (Content-Type:
//                    `text/plain; version=0.0.4`). Scraped by
//                    Prometheus / Grafana / Alertmanager.
//   GET /healthz   — liveness: 200 iff the poll loop completed an
//                    iteration within `2 × pollIntervalMs`. A stuck
//                    worker will stop ticking, healthz goes red, and
//                    Kubernetes / systemd `Restart=on-failure`
//                    (together with a liveness probe) restarts us.
//   GET /readyz    — readiness: 200 iff every sub-check passes.
//                    Sub-checks: lockfile held + wallet unlocked +
//                    stake currently active + last RPC call succeeded.
//                    Returns the per-check status in the body so an
//                    operator curl'ing the endpoint sees exactly what
//                    broke.
//
// Bind host: 127.0.0.1 by default (local-only). Operators who scrape
// from another host put a reverse proxy in front, or override via
// `metricsHost` in config. This is the conservative default —
// exposing a bare metrics endpoint on 0.0.0.0 is a common footgun
// that leaks operational topology to anyone on the network.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import type { Registry } from 'prom-client';
import type { WorkerLogger } from '../worker/loop';

const PROM_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

export interface LivenessSnapshot {
    /** Unix seconds at the end of the most recent successful cycle. */
    lastCycleCompletedAt: number;
    /** Config value so the handler can compute the staleness threshold. */
    pollIntervalMs: number;
}

export interface ReadinessCheck {
    name: string;
    ok: boolean;
    detail?: string;
}

export interface HealthServerOptions {
    port: number;
    host?: string;
    registry: Registry;
    /** Returns a live snapshot each request. Cheap — just reads state. */
    liveness: () => LivenessSnapshot;
    /** Returns an array of pass/fail sub-checks each request. */
    readiness: () => ReadinessCheck[];
    logger: WorkerLogger;
}

export interface HealthServer {
    port: number;
    host: string;
    close: () => Promise<void>;
}

/**
 * Start the health + metrics server. Resolves once bound (so the
 * orchestrator knows it can announce readiness without racing the
 * first scrape). Call `close()` on shutdown.
 */
export function startHealthServer(options: HealthServerOptions): Promise<HealthServer> {
    const host = options.host ?? '127.0.0.1';

    const server = createServer((req, res) => handleRequest(req, res, options));
    // `keepAliveTimeout` of 5s is plenty for scrape workloads; default
    // is 5s in node anyway but we set it explicitly so the shutdown
    // path knows the ceiling.
    server.keepAliveTimeout = 5_000;

    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(options.port, host, () => {
            server.removeAllListeners('error');
            // Read the actual port — if the caller passed 0 (ephemeral),
            // `options.port` is still 0 here; `server.address()` returns
            // the kernel-assigned port.
            const addr = server.address();
            const boundPort =
                addr !== null && typeof addr === 'object' ? addr.port : options.port;
            options.logger.info('health server listening', {
                host,
                port: boundPort,
            });
            resolve({
                port: boundPort,
                host,
                close: () => closeServer(server),
            });
        });
    });
}

async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    options: HealthServerOptions,
): Promise<void> {
    if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain' });
        res.end('method not allowed\n');
        return;
    }
    // Strip query string for routing — we don't use any params today,
    // but `?debug=1` shouldn't mis-route.
    const path = (req.url ?? '/').split('?')[0];

    try {
        switch (path) {
            case '/metrics':
                await handleMetrics(res, options.registry);
                return;
            case '/healthz':
                handleHealthz(res, options.liveness());
                return;
            case '/readyz':
                handleReadyz(res, options.readiness());
                return;
            default:
                res.writeHead(404, { 'content-type': 'text/plain' });
                res.end('not found\n');
                return;
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        options.logger.error('health server handler threw', { path, error: msg });
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal server error\n');
    }
}

async function handleMetrics(res: ServerResponse, registry: Registry): Promise<void> {
    const body = await registry.metrics();
    res.writeHead(200, { 'content-type': PROM_CONTENT_TYPE });
    res.end(body);
}

function handleHealthz(res: ServerResponse, snapshot: LivenessSnapshot): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const stalenessSec = nowSec - snapshot.lastCycleCompletedAt;
    // Threshold: 2× pollIntervalMs (converted to seconds). Floor of 10s
    // so a fast poll interval + single slow RPC doesn't trip the probe.
    const thresholdSec = Math.max(10, Math.ceil((snapshot.pollIntervalMs * 2) / 1000));
    const healthy =
        snapshot.lastCycleCompletedAt > 0 && stalenessSec <= thresholdSec;
    const body = {
        status: healthy ? 'ok' : 'fail',
        lastCycleCompletedAt: snapshot.lastCycleCompletedAt,
        stalenessSeconds: stalenessSec,
        thresholdSeconds: thresholdSec,
    };
    res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body) + '\n');
}

function handleReadyz(res: ServerResponse, checks: ReadinessCheck[]): void {
    const allOk = checks.every((c) => c.ok);
    const body = {
        status: allOk ? 'ok' : 'fail',
        checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
    };
    res.writeHead(allOk ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body) + '\n');
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        // Force-close idle keep-alive sockets so shutdown doesn't wait
        // out the 5s keepAliveTimeout on idle scraper connections.
        server.closeIdleConnections?.();
    });
}
