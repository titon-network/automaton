# src/bls/

BLS12-381 identity for Fortuna VRF + Themis reveals — separate from the TON wallet, but shared between the two products (the same Atlas group secret signs Fortuna alphas AND Themis reveal payloads). `bls.enc` mirrors the wallet keystore's discipline (scrypt + AES-256-GCM + atomic write + tamper checks).

| File | Purpose |
|---|---|
| `index.ts` | Barrel — re-exports the primitives the workers use (`signAlpha`, `blsPublicKey`, `randomBlsSecret`). Crypto comes from `@titon-network/fortuna-sdk`; this layer is the keystore + automaton-side glue. |
| `keystore.ts` | `lockBlsKeystore` / `saveBlsKeystore` / `loadBlsKeystore` / `unlockBlsKeystore`. `BLS_KEYSTORE_VERSION` is `z.literal(N)` — bump on shape changes. Plaintext stores the 48-byte G1 pkShare so `automaton bls pubkey` works without a password. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §Key design decisions ("BLS identity is decoupled from the TON wallet"). Touchpoints: `src/cli/commands/bls.ts` (CLI surface), `src/products/fortuna.ts` + `src/products/themis.ts` (both products bootstrapWorker using the same `bls.enc`), `src/worker/fortuna.ts` (signs + submits FulfillRandomness), `src/worker/themis.ts` (computes per-bid `D = sk · c1` and signs the reveal payload).
