# src/wallet/

Mnemonic → wallet derivation → encrypted keystore. Network-aware (V5R1 bakes the network global ID into the walletId).

| File | Purpose |
|---|---|
| `mnemonic.ts` | BIP-39 wrapper over `@ton/crypto`: `generateMnemonic`, `validateMnemonic`, `mnemonicToKeys`. |
| `wallet.ts` | `walletFromMnemonic(mnemonic, network)` — V5R1 derivation; same mnemonic yields different addresses per network. |
| `keystore.ts` | scrypt + AES-256-GCM lock/unlock, atomic save, zod-schema versioned. `KEYSTORE_VERSION` bumped on shape changes. |
| `prompt.ts` | Raw-mode hidden password prompt; honours `AUTOMATON_PASSWORD` env for non-TTY (Docker/systemd). |
| `index.ts` | Barrel. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §Key design decisions ("Keystore is network-aware", "Password flow: env-first, then TTY prompt", §Security hardening).
