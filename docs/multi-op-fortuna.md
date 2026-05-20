# Multi-op Fortuna — protocol design

> **Status: phase 1 design.** Schema + crypto primitives ship in this phase.
> The HTTP share-exchange transport, FortunaWorker rewire, and sandbox
> integration test follow in phases 2–3.

This document specifies how multiple unaffiliated automaton operators
collaborate to fulfill Fortuna VRF requests end-to-end on TON mainnet,
unlocking the "elite VRF service" posture the on-chain contracts
already support but the daemon does not yet implement.

---

## Why this is needed

Fortuna's `BLS_VERIFY` checks the submitted signature against the
**published group public key** (`groupPk` in Atlas), not against any
individual operator's `pkShare`. The daemon today (`src/worker/fortuna.ts`)
signs solo and submits — only valid when `groupPk == pkShare` (i.e.
solo-mode `memberCount=1, threshold=1`). To scale beyond one operator,
each operator must (a) compute its own partial signature and (b) collaborate
with peers to produce an aggregate that verifies against `groupPk`.

The on-chain contracts (`atlas`, `fortuna`) already accept any aggregate
that pairs correctly. **No contract changes required.**

---

## Threshold scheme — additive `t = n` (phase 1 target)

Multiple threshold schemes are mathematically possible:

| Scheme | Aggregation | Liveness needed | Suitable when |
|---|---|---|---|
| **Additive `t = n`** | naive sum: `agg = Σ partial_i` | All `n` must sign | Few operators, simple ceremony, no fault tolerance for missing operators |
| **Shamir `t < n`** | Lagrange interpolation: `agg = Σ λ_i · partial_i` | Any `t` of `n` | Real fault tolerance, more complex DKG ceremony |
| **Replicated solo** | identity (anyone's sig = aggregate) | Any one signs | Pure HA redundancy; no threshold security gain |

Phase 1 targets **additive `t = n`** because:

1. The crypto is trivial — `fortuna-sdk` already exports
   `aggregateSignatures(sigs)` (naive G2 sum) and `aggregateGroupPublicKey(sks)`
   (naive G1 sum).
2. Atlas's on-chain solo-mode invariant (`pkShare == groupPk` when
   `memberCount = 1, threshold = 1`) is not triggered for `n ≥ 2`, so each
   operator registers its own independent `pkShare` and Atlas accepts.
3. No DKG ceremony is strictly needed — each operator independently
   generates a fresh BLS secret via `automaton bls keygen`; the Atlas
   owner sums `pkShare_i` off-chain to produce `groupPk` and publishes.
   The full secret is **never** assembled anywhere — a property `replicated
   solo` cannot give you.
4. Fault-tolerance trade-off: if any one operator is offline, no requests
   can be fulfilled within the deadline. Consumers reclaim and refund.
   Acceptable for the team's 2-operator rollout because operator HA per
   region (EC2 auto-recover + restart-on-failure) is already strong.

**Phase 4+** can extend to Shamir `t < n` once additive is shipped + verified
in production.

---

## Off-chain protocol

### Roles

| | Role |
|---|---|
| **Operator** (`automaton`) | Holds one BLS share `s_i`, has known `pkShare_i = g^s_i`. Signs alpha + exchanges with peers + races to submit aggregate. |
| **Atlas owner** | One-shot ceremony: collects `pkShare_i` from each operator, sums to `groupPk`, publishes via `PublishGroupKey`. |
| **Consumer** | Calls `RequestRandomness` on Fortuna. Receives the VRF result via `VrfCallback`. Same as today. |

### Group setup ceremony (one-shot per group)

1. **Operators independently** run `automaton bls keygen` → produces a fresh
   bls.enc keystore + prints the 48-byte G1 `pkShare_i` hex.
2. Each operator hands their `pkShare_i` hex to the Atlas owner. **Public —
   not a secret.** Out-of-band channel of the operators' choosing (PR, email,
   on-chain ConfigUpdated event, etc.).
3. Atlas owner runs:
   ```
   cd /path/to/atlas
   pnpm run publish:groupkey:multi:mainnet -- \
     --pkshares <hex_1>,<hex_2>,...,<hex_n>
   ```
   The script (`atlas/scripts/publishMultiOpGroupKey.ts`) computes `groupPk = Σ pkShare_i`
   (G1 sum via `bls.longSignatures.aggregatePublicKeys`), auto-derives `memberCount = n,
   threshold = n` from the pkShare count, and sends `PublishGroupKey` to Atlas. The
   sibling script `publishSoloGroupKey.ts` deliberately refuses mainnet (single-key
   forgery risk); this script is mainnet-allowed because the additive `t = n` scheme
   has no single point of forgery — the group secret is never assembled anywhere.
4. Each operator runs `automaton bls register` once. Atlas's
   `RegisterBlsShare` handler records `pkShare_i` per `(groupId, operator
   address)`. Multi-op-mode skips the `pkShare == groupPk` equality check.
5. Atlas fires `OperatorActivationChanged → forgetonActive=true` once
   ForgeTON's `AutomatonSync` confirms the operator is staked. Atlas's
   active-operator-count reaches `n`.
6. The first `RequestRandomness` after step 5 can now be fulfilled.

### Per-request fulfillment flow

```
                ┌───────────────────────┐
                │  RequestCreated event │
                │  (Fortuna external-out)│
                └─────────┬─────────────┘
                          ▼
       ┌──────────────────────────────────┐
       │ Operator i: enqueue + compute α  │
       │     α = sha256(consumer || qid   │
       │              || seed || lt)      │
       └────────────────┬─────────────────┘
                        ▼
       ┌──────────────────────────────────┐
       │ Operator i: sign locally         │
       │     partial_i = signAlpha(s_i, α)│
       │     ∈ G2 (96 bytes)              │
       └────────────────┬─────────────────┘
                        ▼
       ┌──────────────────────────────────┐
       │ POST /fortuna/v1/share to peers  │
       │   body = { reqKey, partial }     │
       │   peer verifies vs sender's pkShare│
       └────────────────┬─────────────────┘
                        ▼
       ┌──────────────────────────────────┐
       │ Operator i: poll local cache for │
       │  partials from all n peers       │
       │  (own + others received via      │
       │   their POSTs to me)             │
       └────────────────┬─────────────────┘
                        ▼
       ┌──────────────────────────────────┐
       │ When all n partials present:     │
       │   agg = aggregateSignatures()    │
       │   leader = lowest pkShare-index  │
       │   leader submits FulfillRandomness │
       │   non-leaders wait T=30s         │
       │   if no on-chain landing, fall   │
       │   back to submitting             │
       └──────────────────────────────────┘
```

### Wire format

#### Share-exchange HTTP endpoint (each operator hosts one)

`POST /fortuna/v1/share`

Request body (JSON):
```json
{
  "groupEpoch": 17,
  "reqKey": "0x...",                  // hex of the bigint reqKey from RequestCreated
  "consumer": "EQ...",                // bounceable
  "queryId": "12345",
  "seed": "0x...",                    // hex of bigint seed
  "creationLt": "9876543210",         // string-bigint
  "fromAddress": "EQ...",             // sender's wallet (= sender's operator address)
  "fromPkShareHex": "0x...",          // sender's pkShare (96 hex chars)
  "partial": "0x..."                  // 96-byte G2 signature, hex
}
```

Receiver actions:
1. Look up `fromAddress` in the local peer-list (config). Reject if not a known peer.
2. Verify `fromPkShareHex` matches the `pkShare` Atlas reports for `fromAddress`
   (one-time read; cached per `groupEpoch`).
3. Re-compute `α` from `(consumer, queryId, seed, creationLt)` — must match
   what the sender claims (paranoia against malicious peer crafting α).
4. Verify the `partial` is a valid G2 signature of α under `fromPkShareHex`.
   `BLS_VERIFY(partial, fromPkShareHex, α)` must succeed.
5. Store in the local pending-share cache, keyed by `(reqKey, groupEpoch)`.
6. Return `{ "status": "ok" }`.

Failure cases (all return 400 + JSON `{ "error": "..." }`):
- Unknown sender → log + reject (potential probing)
- Stale epoch (sender's `groupEpoch` ≠ current Atlas-cached epoch) → reject
- Partial signature does not verify → log + reject (potential malicious peer; rate-limit)
- α mismatch → log + reject

Importantly: **the BLS signature is self-authenticating.** No TLS-cert pinning,
no shared secret between operators. A peer cannot forge another peer's partial
because they don't have the secret. Worst an adversary controlling the network
path can do is block / delay / censor — the exchange protocol is liveness-only
sensitive to that, not safety-sensitive.

#### Inbound + outbound batching

In phase 2 the daemon runs an HTTP server on a configurable port (default
`9091`, separate from `9090` metrics, also bound `127.0.0.1` by default but
operators expose to public via reverse proxy / firewall rule). Outbound
requests use a small fan-out: one POST per peer per request, `Promise.allSettled`
so a slow / down peer doesn't block the rest.

### Race + leader election

When operator `i` has all `n` partials cached locally for a request:

- If `i` is the **leader** (defined as: the operator with the **lowest
  `pkShare-index`** in the group, where index is just the position the
  Atlas owner assigned during `PublishGroupKey`): submit
  `FulfillRandomness(aggregate)` immediately.
- If `i` is a **non-leader**: wait `T_leader_grace = 30s` before submitting.
  In that window, watch for `RequestFulfilled` on Fortuna. If the leader's
  submission landed, the request gets dequeued via the normal event path
  and we don't need to do anything.
- If `T_leader_grace` elapses without a `RequestFulfilled`: fall back to
  submitting ourselves. (Leader is offline / partitioned / slow.) Ties
  broken by next-lowest index, etc. — naturally cascading.

This avoids most contention: 1 tx per request in the steady state. The only
duplicate-tx case is leader-down with poor liveness on the network path
(rare). Duplicate txs are cheap to bounce — the second submitter sees
`RequestFulfilled` first and aborts; if both land on-chain, the second
fails verify against `getRequest` (already deleted) and the daemon logs
race-lost as today.

---

## Schema additions (phase 1 ships these)

### config.json — `fortuna` block

```ts
fortuna: z.object({
    atlasAddress:        z.string().optional(),
    fortunaAddress:      z.string().optional(),
    peers:               z.array(z.object({
                             address:  z.string(),         // peer operator's wallet (UQ-form)
                             endpoint: z.string().url(),   // http(s)://host:port
                         })).optional().default([]),
    shareExchangePort:   z.number().int().min(1).max(65535).optional().default(9091),
    shareExchangeHost:   z.string().optional().default('127.0.0.1'),
    leaderGraceSec:      z.number().int().min(5).max(300).optional().default(30),
}).optional()
```

Solo-mode (no peers configured) → identical behavior to today: sign +
submit immediately. Multi-op-mode (≥1 peer configured) → enable the
exchange flow.

### bls.enc keystore

**No changes in phase 1.** The additive `t = n` scheme doesn't need
share-index in the keystore (each share is independent; aggregation is
naive sum). Phase 4 (Shamir `t < n`) would add `shareIndex: number` to
the keystore for Lagrange interpolation.

---

## Trust model

| Threat | Mitigation |
|---|---|
| Malicious peer sends a valid partial for a wrong `α` | Receiver re-derives α from `(consumer, queryId, seed, creationLt)` and rejects mismatches. |
| Malicious peer sends a partial NOT signed by their pkShare | `BLS_VERIFY(partial, sender_pkShare, α)` rejects. |
| Malicious peer DoS-floods the share endpoint | Rate-limit per `from-address`, drop unknown senders (only configured peers accepted). |
| Compromise of one operator's host (BLS secret leaked) | Attacker can produce that operator's partial. CANNOT produce the full aggregate alone (needs the others). Threshold security holds — the leak compromises that operator's pkShare integrity, not the group's. |
| All operators colluding to forge | Trust assumption: at least one operator is honest. Same as every threshold scheme. Mitigated by **operator decentralization** (different orgs, jurisdictions, stake). |
| Network partition → leader is unreachable | Non-leaders fall back after `leaderGraceSec`. Brief duplicate-tx period; second submitter loses race cleanly. |
| Two leaders disagree on who's the leader | Deterministic leader election by `pkShare-index` — no protocol disagreement possible. |

The key property: **operator decentralization is a precondition for elite VRF
posture, not the protocol's job to enforce.** The protocol works correctly
with `n=2` operators run by the same team — it just doesn't deliver elite-grade
security in that configuration. Live elite-grade VRF requires `n ≥ 3` operated
by unaffiliated entities with their own stake + slashing exposure.

---

## Operator setup

End-to-end ceremony for `n` operators forming a `t = n` group on mainnet. **Pre-condition:** every operator already has an EC2 deployment (per [`contrib/aws/ec2/`](../contrib/aws/ec2/) and `docs/deploy.md` §3) staked + active on ForgeTON.

### 1. Each operator generates a BLS share locally

```bash
# On each operator's local machine — NOT the EC2 instance.
TITON_HOME=~/.titon/automaton-mainnet-<REGION> \
    /path/to/automaton/dist/cli/index.js bls keygen
# → prompts for password (use the SAME password as the wallet keystore;
#   v1 same-password model has the daemon unlock both with one prompt)
# → writes ~/.titon/automaton-mainnet-<REGION>/automaton/bls.enc
# → prints the 96-hex pkShare

TITON_HOME=~/.titon/automaton-mainnet-<REGION> \
    /path/to/automaton/dist/cli/index.js bls pubkey
# → reprints the pkShare (no password needed; the public part is plaintext in bls.enc)
```

### 2. Operators hand pkShares to the Atlas owner

The pkShare is a public artifact. Channel of choice (PR, email, signal). The Atlas owner collects every operator's pkShare hex.

### 3. Atlas owner publishes the aggregate `groupPk`

```bash
cd /path/to/atlas
# .env.mainnet must contain ATLAS_OWNER_MNEMONIC (the wallet whose
# address is stored as Atlas's owner — separate from WALLET_MNEMONIC,
# which is the deployer wallet that paid deploy gas).
TONCENTER_API_KEY='<your-key>' pnpm run publish:groupkey:multi:mainnet -- \
    --pkshares <hex_1>,<hex_2>,<hex_3>,...
# Script: validates each pkShare (G1 subgroup), sums to groupPk via
# bls.longSignatures.aggregatePublicKeys, sends PublishGroupKey with
# memberCount=n, threshold=n. Auto-derives both from --pkshares count.
# Idempotent on match; errors loudly with rotation guidance on mismatch.
```

### 4. Each operator uploads `bls.enc` to SSM

```bash
cd automaton-mainnet/<REGION>     # (team-internal scaffold; external operators
                                   #  use their own per-region terraform root)
make upload-bls
```

### 5. Each operator updates terraform: `enable_fortuna` + `peer_ips`

In each region's per-region terraform:

```hcl
module "automaton" {
  ...
  enable_fortuna = true
  peer_ips       = ["<other-operator-1-EIP>", "<other-operator-2-EIP>", ...]
}
```

```bash
terraform apply
# → user_data hash changes; instance is replaced; peer SG rules added.
```

### 6. Each operator updates SSM `config.json` with the `fortuna.peers` block

```json
{
  "configVersion": 1, "network": "mainnet",
  ... existing fields ...
  "products": { "kronos": true, "fortuna": true },
  "fortuna": {
    "peers": [
      { "address": "<other-operator's-UQ-form-wallet>",
        "endpoint": "http://<other-operator-EIP>:9091" }
    ],
    "shareExchangeHost": "0.0.0.0"
  }
}
```

> **`http://` not `https://`** — peer share-exchange is plain HTTP. BLS signatures are self-authenticating on the wire (the receiver re-derives alpha + verifies the partial against the sender's on-chain pkShare). TLS would add no security and a CA infrastructure to maintain. The SG limits inbound TCP/9091 to peer EIPs only.

```bash
aws ssm put-parameter --overwrite --region <REGION> --type SecureString \
    --name /titon/automaton/<REGION>/config.json \
    --value "$(cat /tmp/config.json)"
# Then:
make restart    # ExecStartPre re-fetches the new config from SSM
```

### 7. Each operator registers their pkShare at Atlas

```bash
make bls-register
# → submits RegisterBlsShare; Atlas records the share against this
# operator's address. memberCount=2+ skips the solo-mode equality check;
# every operator's pkShare can be different.
```

### 8. Smoke-test end-to-end

```bash
cd /path/to/fortuna
AUTOMATON_PASSWORD='<eu-central-1 wallet password>' \
TONCENTER_API_KEY='<your-key>' \
    npx ts-node scripts/coinFlipMainnetE2E.ts
```

The script deploys CoinFlip on mainnet (using the eu-central-1 wallet as owner — easy to adapt to any signer wallet), sends a Flip, and polls until `flipsTotal` advances. Expected daemon flow logged on both regions:

```
fortuna: request enqueued
fortuna: signed + broadcast our partial peers=N ok=N
fortuna: submitting FulfillRandomness         ← leader only
fortuna: fulfillment verified                 ← leader only
fortuna: request fulfilled (weWon=true|false) ← all peers
```

Within ~1-2 minutes, the consumer's `getStats()` shows `flipsTotal` advanced. **That proves end-to-end multi-op VRF on mainnet** — every operator signed, exchange worked over HTTP, leader aggregated correctly, on-chain `BLS_VERIFY` against the published `groupPk` succeeded, callback delivered.

---

## What ships today (phase 1+2+3, automaton@0.8.0)

- Schema: `config.fortuna.{peers, shareExchangePort, shareExchangeHost, leaderGraceSec}`.
- Crypto: `aggregateFortunaPartials(partials)` in `src/bls`; unit-tested against on-chain `BLS_VERIFY` shape (`tests/aggregate.spec.ts`).
- HTTP transport: `src/daemon/share-exchange.ts` — `ShareCache` + inbound POST handler (BLS-verifies on the way in, rejects unknown senders + epoch mismatches) + outbound `broadcastShare` peer client.
- Worker: `src/worker/fortuna.ts` — multi-op tick (sign-locally → broadcast → wait-for-cache → leader-elected aggregate + submit). Solo-mode preserved bit-for-bit when `peers` is empty.
- Lifecycle: `ProductWorker.dispose?()` interface + `FortunaWorker.dispose()` close the share-exchange server on shutdown.
- Atlas-owner ceremony: `atlas/scripts/publishMultiOpGroupKey.ts` — mainnet-allowed; idempotent on match; errors loudly with rotation guidance on mismatch.
- EC2 module: `peer_ips` terraform variable wires SG ingress + egress on TCP/9091.
- Tests: `tests/share-exchange.spec.ts` (server + cache + outbound), `tests/multi-op-fortuna.spec.ts` (2-op integration with mocked broadcast). All 660 tests green.

## What's deferred

- **Phase 4 — Shamir `t < n`.** Real fault tolerance: any `t` of `n` operators can produce a valid aggregate via Lagrange interpolation. `bls.enc` keystore would gain `shareIndex`. Not yet implemented.
- **Phase 5 — Real DKG ceremony tool.** Pedersen-VSS or similar; no-trusted-coordinator key generation that produces shares without ever assembling the group secret anywhere. Replaces the current "operator generates their own secret + Atlas-owner-sums-pkShares" simple ceremony.
- **Operator-misbehavior slashing.** Atlas/Fortuna currently use only positive incentives (submitterReward + reclaim refund); slashing for VRF-protocol violations would need a `Slash` path in Fortuna + audit re-run.
