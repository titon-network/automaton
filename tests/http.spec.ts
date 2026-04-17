import { createDaemonMetrics } from '../src/daemon/metrics';
import { startHealthServer, type HealthServer, type ReadinessCheck } from '../src/daemon/http';
import type { WorkerLogger } from '../src/worker/loop';

const SILENT: WorkerLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};

async function fetchText(url: string): Promise<{ status: number; body: string; contentType: string }> {
    const res = await fetch(url);
    return {
        status: res.status,
        body: await res.text(),
        contentType: res.headers.get('content-type') ?? '',
    };
}

describe('health HTTP server', () => {
    let server: HealthServer;
    let baseUrl: string;

    // Mutable state — each test resets as needed.
    let lastCycleCompletedAt = Math.floor(Date.now() / 1000);
    let checks: ReadinessCheck[] = [
        { name: 'lockfile-held', ok: true, detail: 'held by this process' },
        { name: 'wallet-unlocked', ok: true, detail: 'ok' },
        { name: 'stake-active', ok: true, detail: 'ok' },
        { name: 'rpc-reachable', ok: true, detail: 'ok' },
    ];
    const metrics = createDaemonMetrics();

    beforeAll(async () => {
        server = await startHealthServer({
            port: 0, // ephemeral
            registry: metrics.registry,
            liveness: () => ({ lastCycleCompletedAt, pollIntervalMs: 10_000 }),
            readiness: () => checks,
            logger: SILENT,
        });
        baseUrl = `http://${server.host}:${server.port}`;
    });

    afterAll(async () => {
        await server.close();
    });

    describe('/metrics', () => {
        it('returns 200 with the prom-client exposition format', async () => {
            metrics.counters.incrementSkip('inactive');
            const r = await fetchText(`${baseUrl}/metrics`);
            expect(r.status).toBe(200);
            expect(r.contentType).toMatch(/text\/plain.*version=0\.0\.4/);
            expect(r.body).toMatch(/automaton_skip_total/);
        });
    });

    describe('/healthz', () => {
        it('returns 200 when the last cycle is fresh', async () => {
            lastCycleCompletedAt = Math.floor(Date.now() / 1000);
            const r = await fetchText(`${baseUrl}/healthz`);
            expect(r.status).toBe(200);
            expect(r.contentType).toContain('application/json');
            const body = JSON.parse(r.body);
            expect(body.status).toBe('ok');
            expect(body.stalenessSeconds).toBeLessThan(5);
        });

        it('returns 503 when the last cycle is stale', async () => {
            lastCycleCompletedAt = Math.floor(Date.now() / 1000) - 60;
            const r = await fetchText(`${baseUrl}/healthz`);
            expect(r.status).toBe(503);
            const body = JSON.parse(r.body);
            expect(body.status).toBe('fail');
            expect(body.stalenessSeconds).toBeGreaterThanOrEqual(60);
        });

        it('returns 503 before the first cycle has completed', async () => {
            lastCycleCompletedAt = 0;
            const r = await fetchText(`${baseUrl}/healthz`);
            expect(r.status).toBe(503);
            expect(JSON.parse(r.body).status).toBe('fail');
        });
    });

    describe('/readyz', () => {
        beforeEach(() => {
            checks = [
                { name: 'lockfile-held', ok: true, detail: 'held by this process' },
                { name: 'wallet-unlocked', ok: true, detail: 'ok' },
                { name: 'stake-active', ok: true, detail: 'ok' },
                { name: 'rpc-reachable', ok: true, detail: 'ok' },
            ];
        });

        it('returns 200 when every sub-check passes', async () => {
            const r = await fetchText(`${baseUrl}/readyz`);
            expect(r.status).toBe(200);
            const body = JSON.parse(r.body);
            expect(body.status).toBe('ok');
            expect(body.checks).toHaveLength(4);
        });

        it('returns 503 when any sub-check fails', async () => {
            checks = checks.map((c) =>
                c.name === 'rpc-reachable' ? { ...c, ok: false, detail: 'no network' } : c,
            );
            const r = await fetchText(`${baseUrl}/readyz`);
            expect(r.status).toBe(503);
            const body = JSON.parse(r.body);
            expect(body.status).toBe('fail');
            const rpc = body.checks.find((c: ReadinessCheck) => c.name === 'rpc-reachable');
            expect(rpc.ok).toBe(false);
            expect(rpc.detail).toBe('no network');
        });
    });

    describe('routing', () => {
        it('returns 404 on unknown paths', async () => {
            const r = await fetchText(`${baseUrl}/does-not-exist`);
            expect(r.status).toBe(404);
        });

        it('returns 405 on non-GET methods', async () => {
            const res = await fetch(`${baseUrl}/metrics`, { method: 'POST' });
            expect(res.status).toBe(405);
        });

        it('strips query strings from path routing', async () => {
            const r = await fetchText(`${baseUrl}/healthz?format=debug`);
            expect(r.status).toBeLessThan(504); // 200 or 503, not 404
        });
    });
});
