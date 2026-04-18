# Security policy

`@titon/automaton` is the binary that operators run on their own infrastructure to stake and execute Kronos jobs on TON. A vulnerability here puts operator stake at risk. Please report responsibly.

## Supported versions

| Version | Security patches |
|---|---|
| `0.1.x` | ✅ until a successor `0.2` ships |
| `< 0.1` | ❌ (pre-release development snapshots) |

Once `0.2` ships, the latest two minor versions receive patches. Older lines get critical-fix only.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security-sensitive reports.**

Preferred channels:
- Email `security@titon.network` with `[automaton]` in the subject.
- Or use GitHub's [private vulnerability reporting](https://github.com/titon-network/automaton/security/advisories/new).

Please include:

1. Affected version (`automaton --version` output).
2. Reproduction: the exact command / environment that triggers the issue.
3. Impact: what an attacker could achieve (lost stake, key exfiltration, remote code execution, denial of service, slash-for-no-reason, etc.).
4. Any proposed fix or workaround.

We aim to acknowledge within 48 hours and ship a patch within 7 days for high-severity issues (stake-loss, key-material exposure). Lower-severity issues (rate-limiting edge cases, metric noise) may take longer.

## What counts as a vulnerability

Good candidates:
- Mnemonic or keystore password leakage via logs, metrics, or error messages (pino redacts `password` / `mnemonic` / `privateKey` / `seed` / `secretKey`; escaping that list is a bug).
- Unauthorised file-system access or privilege escalation.
- Arbitrary-code execution in any code path reachable from `automaton run` with a malformed config, bad RPC response, or crafted event body.
- Any path that lets a non-operator cause the daemon to spend more than `config.maxGasPerExecute` or sign unintended transactions.
- RPC-response-driven crashes that can't be recovered by restarting (corrupting state.json, lockfile, etc.).

**Not vulnerabilities:**
- `automaton doctor` flagging low balance or missing config — that's intentional.
- Transient RPC failures causing cycle misses — handled by backoff + retry.
- Operator losing funds by running `stake withdraw` prematurely or mis-handling their mnemonic.
- `pnpm audit` findings in transitive dev-only dependencies (those don't ship).

## Hardening expected of operators

- Back up the 24-word mnemonic on paper, in multiple locations. `wallet.enc` + password is the day-to-day auth; the mnemonic is the only recovery key.
- Never commit `wallet.enc` to version control (even encrypted).
- Run the daemon as its own unprivileged user (`contrib/automaton.service` ships a hardened systemd unit).
- Keep the host OS patched. The automaton's Docker image is distroless + non-root (UID 65532) to limit blast radius if the node process is compromised.
- Monitor `/metrics` for `automaton_self_slash_total` — any increase warrants investigation.

## Cryptography

- **Keystore:** scrypt (N=131072, r=8, p=1, salt=16B) → AES-256-GCM (96-bit random nonce, 128-bit auth tag). Per-lock salt + nonce.
- **Mnemonic:** BIP-39 (24 words), validated on every unlock.
- **Address derivation:** `@ton/crypto` + `WalletContractV5R1` (network-aware).

No rolled-our-own crypto. If you believe one of the above primitives is mis-used (wrong length, reused nonce, unvalidated tag), that's a reportable issue.
