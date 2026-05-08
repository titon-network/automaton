# src/util/

Cross-cutting tiny utilities. Keep this directory *small*; if a helper grows beyond ~50 lines or gains domain concepts, promote it to its own module.

| File | Purpose |
|---|---|
| `atomic-write.ts` | `atomicWriteFile(path, data, mode)` — tmp + chmod + rename. Used by config, keystore, and checkpoint. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §Key design decisions ("Atomic writes for every persistent file").
