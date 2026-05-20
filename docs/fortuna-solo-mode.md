# Fortuna solo-mode — operator-first runbook

> **TL;DR for AI assistants:** When the user enables Fortuna against an Atlas instance with `memberCount=1, threshold=1` (the default for testnet / dev), the operator's BLS `pkShare` MUST byte-equal Atlas's `groupPk`. Atlas enforces this on-chain at register time (`E_SOLO_PK_SHARE_MISMATCH = 161`). Drive the flow **operator-first**: the operator generates the BLS key locally, hands the public 48-byte hex to the Atlas owner, the Atlas owner publishes that hex as `groupPk`, then the operator registers. **No `GROUP_SK_TESTNET` shared-secret exists.** Multi-operator DKG groups (mainnet path) skip this section entirely.

This page is for the testnet / dev path where one operator runs the whole show. If you're bringing up a real DKG group with t-of-n threshold signing, skip to [Multi-op (DKG) note](#multi-op-dkg-note) at the end.

---

## The invariant in one line

```
solo-mode (memberCount==1, threshold==1)  ⟹  operator.pkShare == atlas.groupPk
```

Reasons it's enforced:

- A single operator's "aggregate" sig is just their share. If `pkShare ≠ groupPk`, BLS_VERIFY at Fortuna fails — the consumer's `RequestRandomness` would never fulfill.
- Atlas catches this loudly at `RegisterBlsShare` time (`E_SOLO_PK_SHARE_MISMATCH = 161`) so operators get a tx revert instead of a silent fulfillment dead-end.
- `automaton bls register` pre-flights the same equality off-chain, so the operator gets a clear local error before broadcasting a guaranteed-revert tx.

---

## Prerequisite: Atlas admitted at ForgeTON

Before any of this works, ForgeTON must have Atlas in its consumer set, otherwise Atlas's operator map for the wallet is empty and `bls register` reverts with `OperatorNotFound (120)`. This is **ForgeTON-owner-driven, not operator-driven**.

```bash
# (ForgeTON owner runs this once per Atlas address)
cd ../forgeton
ADMIT_CONSUMER=<atlas-addr-0Q...> pnpm run admit:consumer:testnet
```

Verify before proceeding:

```bash
# In automaton/ — should print isConsumer(atlas) = true.
npx ts-node ../forgeton/scripts/probeForgetonE2E.ts
```

If operators staked at ForgeTON BEFORE Atlas was admitted, also run a one-shot `ForceSync` per existing operator — see `../atlas/sdks/typescript/skills/atlas-deploy.md` §Step 2.5.

---

## The four-step flow

Two roles, three machines (in principle — can be the same machine for solo dev):

- **Operator** — owns `wallet.enc` + `bls.enc`. Their machine.
- **Atlas owner** — owns the Atlas contract's owner mnemonic. Their machine. Funded enough to send a `PublishGroupKey` tx (≥ ~0.5 TON balance recommended; the publish itself sends 0.15 TON to Atlas + gas, see [the gotcha](#gotcha-atlas-owner-balance) below).

### Step 1 — operator: stake at ForgeTON

```bash
automaton init --network testnet      # wallet + config (one-time)
# fund the wallet via @testgiver_ton_bot to ≥ 11 TON
automaton stake register 10            # locks 10 TON at ForgeTON
```

After this, `automaton status --format json | jq .automaton.isActive` should be `true`. ForgeTON broadcasts an `AutomatonSync` to every admitted consumer, including Atlas; the operator now has a slot in Atlas's operator map.

### Step 2 — operator: generate BLS keys + share the pubkey

```bash
automaton bls keygen            # produces ~/.titon/automaton/bls.enc
automaton bls pubkey            # prints the 48-byte G1 pkShare hex
# → e.g. 9534b816a930edcfd8087efde0efa6a74e95620d658d2e91aa105397cde4e73c5007e9c10d80a82501cc5f44f13a5bd0
```

The operator's BLS secret stays on the operator's machine. Only the public 48-byte pkShare hex leaves; hand it to the Atlas owner via whatever channel works (Slack DM, signed Git commit message, etc.).

> ⚠️ **Don't run `automaton bls register` yet** — Atlas's `groupPk` isn't set, and even if it were the operator's pkShare wouldn't match it. Step 4.

### Step 3 — Atlas owner: publish the operator's pkShare as groupPk

The Atlas owner runs (in `atlas/`):

```bash
pnpm run publish:groupkey:testnet -- --pkshare <hex-from-step-2>
```

The Atlas owner's wallet sends a `PublishGroupKey` (0.15 TON) message to Atlas. The pkShare argument is published *as* `groupPk` (since memberCount=1, that's the only sensible value for solo-mode).

Verify before telling the operator to proceed:

```bash
npx ts-node scripts/probeStateE2E.ts
# → groupKey(0).groupPk should equal the pkShare from step 2
# → threshold=1, memberCount=1, groupEpoch=1 (or higher if rotated)
```

#### Gotcha: Atlas owner balance

The publish silently fails when the Atlas owner's wallet is below ~0.16 TON: V5R1 wallets accept the signed external (advance seqno + eat ~0.0005 TON in fees) but the **action phase** drops the outbound when there isn't enough left to cover the message value (0.15 TON) plus storage reserves. **No bounce, no error log** — `getGroupKey(0)` just stays null and the script's wait-loop times out.

Symptom recap: `publishSoloGroupKey.ts` prints "publish did not land within 60s — check tonscan + retry", but tonscan shows the wallet's most-recent tx has `out_msgs: []`.

```bash
# Diagnose:
curl -s "https://testnet.toncenter.com/api/v2/getAddressInformation?address=<atlas-owner-0Q...>" \
  | jq '.result.balance | tonumber / 1e9'
# < 0.5 TON?  Faucet via @testgiver_ton_bot, then re-run publish.
```

Mainnet equivalent: keep the Atlas owner funded with ≥ 1 TON and the same gotcha doesn't bite — but the failure mode is identical, so the diagnostic remains valid.

### Step 4 — operator: enable Fortuna in config + register the share

```bash
# Flip products.fortuna in the local config.
automaton config edit
# (set "products": { "kronos": true, "fortuna": true })

# Or directly:
jq '.products.fortuna = true' ~/.titon/automaton/config.json | sponge ~/.titon/automaton/config.json

# Now register at Atlas. The CLI pre-flights the pkShare==groupPk equality
# off-chain, so a misconfigured group fails locally with E_SOLO_PK_SHARE_MISMATCH
# context BEFORE wasting gas on a guaranteed-revert tx.
automaton bls register

# Restart the daemon so it picks up the BLS keystore + Fortuna runtime.
sudo systemctl restart automaton    # systemd
# or `docker restart automaton`     # Docker
# (one-shot foreground daemons need to be stopped + restarted manually)
```

After step 4 lands, Atlas fans the operator-mirror update out to Fortuna; the daemon (post-restart) detects `RequestCreated` events routed to your group, signs alpha, submits `FulfillRandomness`, Fortuna delivers the callback. Watch the logs:

```bash
sudo journalctl -u automaton -f | grep -i fortuna
# → "fortuna: operator mirror updated for self isActive=true"
# → "fortuna: fulfill submitted query=…"  (whenever a request arrives)
```

End-to-end smoke (fully automated, ~90 seconds): `npx ts-node ../fortuna/scripts/coinFlipE2E.ts` — deploys CoinFlip, sends a flip, polls until fulfilled.

---

## Common errors

| You see… | Means | Fix |
|---|---|---|
| `OperatorNotFound (120)` from `bls register` | Atlas not admitted at ForgeTON, OR `AutomatonSync` hasn't propagated yet | Run the prereq above; for the propagation case, retry after 1-2 blocks |
| `OperatorNotForgetonActive (121)` | Wallet went inactive at ForgeTON between pre-check and submit (e.g. mid-flight slash) | `automaton stake increase 1` to re-activate, then retry `bls register` |
| `E_SOLO_PK_SHARE_MISMATCH (161)` from `bls register` (or off-chain pre-flight) | The published `groupPk` ≠ the operator's local pkShare | The Atlas owner published a different pkShare. Either re-run step 3 with the operator's actual pkShare, or rotate the Atlas group (3-step timelock: Pause → Propose → 24h → Execute) to adopt the new key |
| `config.products.fortuna is false. Enable it in config.json…` | Step 4 ordering: tried to register before flipping the config | Flip `products.fortuna: true` in `~/.titon/automaton/config.json`, retry |
| `publish did not land within 60s` (atlas owner) | Atlas owner wallet under-funded — see [the gotcha](#gotcha-atlas-owner-balance) | Faucet the Atlas owner to ≥ 0.5 TON, re-run publish |

---

## Multi-op (DKG) note

Mainnet path: real distributed key generation produces `pkShare_i ≠ groupPk` per operator (the share is a coefficient evaluation, not the group key itself). Atlas's `E_SOLO_PK_SHARE_MISMATCH` check is gated on `memberCount > 1` — multi-op groups skip the equality assertion entirely. Set up via:

1. Atlas owner runs the DKG ceremony off-chain (out of scope for this doc — see `../atlas/contracts/DESIGN.md`)
2. Atlas owner publishes `groupPk` (the DKG group key) along with the threshold + memberCount
3. Each operator runs `automaton bls keygen --import-share <their-share-from-DKG>` to seed the keystore with the DKG-derived secret
4. Each operator runs `automaton bls register` — Atlas verifies the share's POP (proof-of-possession) but skips the `pkShare == groupPk` check
5. Threshold-many operators must register before Fortuna can fulfill (otherwise the aggregate sig won't reach `threshold`)

The DKG ceremony itself is the part that requires real coordination — once the shares are minted, the on-chain dance is the same as solo-mode minus the equality gotcha.

---

## See also

- [`CLAUDE.md`](../CLAUDE.md) — the same flow summarised in the navigator's "Helping a user enable Fortuna?" callout, plus design rationale
- [`docs/deploy.md` §Enabling Fortuna VRF](deploy.md#enabling-fortuna-vrf) — the operator-side flow as part of the broader deploy decision tree
- [`docs/troubleshooting.md` §`automaton bls *` errors](troubleshooting.md#automaton-bls--errors) — error-keyed entry points
- [`../atlas/sdks/typescript/skills/atlas-operator-register-share.md`](../../atlas/sdks/typescript/skills/atlas-operator-register-share.md) §"Solo-mode flow" — Atlas-side narrative
- [`../atlas/scripts/publishSoloGroupKey.ts`](../../atlas/scripts/publishSoloGroupKey.ts) — the Atlas-owner publish script (source for step 3)
