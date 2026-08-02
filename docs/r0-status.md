# R0 Agent Repository Status

Current round scope is `R0 Production Baseline & Repository Bootstrap` plus the
first `R1-P0 deterministic mock vertical slice`. This document is repository
evidence only and does not update the accepted Notion Roadmap percentage.

Implemented in this round:

- strict TypeScript toolchain: typecheck, format, lint, unit/contract tests,
  migration smoke test, clean build and GitHub Actions;
- exact Pi 0.82.1 dependency pin and candidate lock document;
- internal `iris-contracts` for Agent-owned Ports and domain types, without
  copied memory DTOs;
- `agent.json` v3 config schema and loader with OpenCode Go development
  profiles;
- SQLite migration runner and empty data-root initialization;
- `iris.lock` exclusive fail-fast host lock;
- R1-P0 mock vertical slice: Epoch -> Pi Session -> AgentHarness -> UserMessage
  - `iris_input_meta` companion -> context hook -> one sequential read-only
    tool -> ToolResult `details.iris` -> native `settled` -> restart/reopen;
- minimal benchmark and crash-boundary harnesses.

Not implemented or still mock-only:

- full Magic Context parity, Historian, Memory Client integration;
- complete Runtime Session rollover and full crash-window suite;
- live OpenCode Go provider calls;
- production Provider lock.

## Round 2 status (2026-08-02, branch `round2/r1-p1-live-slice`)

Implemented in this round:

- R1-P1 live provider seam (`opencode-go-provider.ts`) using the locked
  pi-ai 0.82.1 built-in `opencodeGoProvider()` + `deepseek-v4-flash`, with
  InMemoryCredentialStore key injection;
- `runMinimalSlice`/`reopenActiveSession` `provider` mode (`mock` | `live`);
- `iris run --data-root --input-file [--provider]` CLI command (real
  Host/CLI vertical slice);
- epoch rollover (`requestRollover`/`rolloverAfterSettled`, `previous_epoch_id`
  linkage) and thin `RuntimeCoordinator` (single-writer latch, queued inputs,
  settled release, abort forwarding);
- crash-window suite rewritten as real child-process SIGKILL + recovery
  assertions (`crash:check`, 6 boundaries);
- CI now runs `crash:check` and `dist:smoke`;
- contract pin aligned to the published iris-memory v0.1.0 manifest (13 schemas).

Still mock-only / deferred: Historian, Magic Context parity, Memory Client
integration, production Provider lock, live thinking profile (R1-P2).
