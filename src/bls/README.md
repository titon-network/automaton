# src/bls/

BLS12-381 identity for Fortuna VRF — separate from the TON wallet. The BLS secret signs alphas; `bls.enc` mirrors the wallet keystore's discipline (scrypt + AES-256-GCM + atomic write + tamper checks).

| File | Purpose |
|---|---|
| `index.ts` | Barrel — re-exports the primitives the worker uses (`signAlpha`, `blsPublicKey`, `randomBlsSecret`). Crypto comes from `@titon-network/fortuna-sdk`; this layer is the keystore + automaton-side glue. |
| `keystore.ts` | `lockBlsKeystore` / `saveBlsKeystore` / `loadBlsKeystore` / `unlockBlsKeystore`. `BLS_KEYSTORE_VERSION` is `z.literal(N)` — bump on shape changes. Plaintext stores the 48-byte G1 pkShare so `automaton bls pubkey` works without a password. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §Key design decisions ("BLS identity is decoupled from the TON wallet"). Touchpoints: `src/cli/commands/bls.ts` (CLI surface), `src/products/fortuna.ts` (worker uses pkShare + secret), `src/worker/fortuna.ts` (signs + submits FulfillRandomness).
