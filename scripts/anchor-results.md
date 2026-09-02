# v4-anchor source-level patch — 12-run measured matrix (deepseek-v4-pro)

Fork: tim-korso/Proma-v4-anchor @ feat/source-level-v4-anchor (c536ad2)
Harness: scripts/headless-v4-anchor-check.ts + scripts/score-anchor-workspace.cjs
Model: deepseek-v4-pro via kdysite (ai.kdysite.cloud/v1), 2026-09-02 ~07:50-09:40 CST
Scoring gate: native check in isolated CJS context — task-a tests/invoice.test.js;
task-b tests/check.js (hard), plus structure heuristics.

| task | thr | run | pass | finalPhase | thinkingSum | tools | done | elapsed |
|---|---|---|---|---|---|---|---|---|
| a   | 800  | 0 | ✅ | anchored | 0     | 19 | ✓ | 114s |
| a   | 800  | 1 | ✅ | promoted | 7589  | 31 | ✓ | 209s |
| a   | 800  | 2 | ✅ | anchored | 0     | 18 | ✓ | 78s  |
| a   | 2000 | 0 | ✅ | promoted | 13238 | 0* | — | —  (*transcript lost, workspace+session intact) |
| a   | 2000 | 1 | ✅ | promoted | 4033  | 26 | ✓ | 148s |
| a   | 2000 | 2 | ✅ | promoted | 6254  | 23 | ✓ | 186s |
| b   | 800  | 0 | ✅ | promoted | 15716 | 25 | ✓ | 490s |
| b   | 800  | 1 | ❌ | anchored | 0     | 23 | ✓ | 254s |
| b   | 800  | 2 | ✅ | promoted | 16727 | 19 | ✓ | 459s |
| b   | 2000 | 0 | ✅ | promoted | 14862 | 21 | ✓ | 398s |
| b   | 2000 | 1 | ✅ | promoted | 33628 | 40 | ✓ | 880s |
| b   | 2000 | 2 | ✅ | anchored | 0     | 21 | ✓ | 256s |

Completions: task-a 800 = 3/3, task-a 2000 = 3/3, task-b 800 = 2/3, task-b 2000 = 3/3.

Full session/workspace/transcript artifacts are local under dist/anchor-runs/
(gitignored); regenerate with scripts/run-anchor-experiments.sh.
