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

## GUI 实测（2026-09-02 19:36 CST, regen5 asar, launchd + CDP）

**部署形态**：`~/Applications/Proma.app/Contents/Resources/app.asar` = 重新生成版
`/tmp/app.asar.v4anchor.regen5`（md5 `43ea4c722ba0067baab28245701c08f0`，与权威修复版
`/tmp/app.asar.v4anchor.fixed` 字节一致）。Gui 进程走 launchd `com.proma.guiv4`
（`--remote-debugging-port=9336 --user-data-dir=/tmp/proma-guiv4-data` 隔离配置）。

**白屏根因（issue #1956）**：旧 resize 脚本只移 `offset > block_end` 的文件，
而 `dist/preload.cjs` 恰好在 `block_end` → 未移位 → preload 数据损坏 → `window.api`
缺失 → 渲染空白。修复 = 移位条件改 `>=`。正确性判据 = preload md5 不变 + 整 App boot。

**repack 脚本语义**：asar header 的 offset 是相对 DATA_BASE(8+headerLen) 的，不是绝对文件偏移；
绝对 `start_abs = old_base + old_ar_off`。脚本内含 preload 位置断言 + 5 步验证清单
（`scripts/repack-asar-v4-anchor.py`）。

**GUI 内锚定生效铁证**（真实 GUI 会话，CDP 驱动发消息）：
- `customType:"v4-anchor-state"`, `minThinkingTokens:2000`, phase 链
  `bootstrap → anchored`（2 条 bootstrap / 2 条 anchored）
- stderr `[ANCHOR]` 事件链：`message_end phase:bootstrap` → `before_provider_request phase:anchored`
- 任务实际落地：`/tmp/anchor-proof-2000c/hello.js` 由 GUI 内 agent 创建，内容正确

**续聊不重复 arm 属预期**：anchor 仅在全新会话首轮 arm（bootstrap），续聊 phase=off，
不是回归。

**自动更新封禁**：`app-update.yml` → provider generic + `v4-anchor-disabled://` 无效 URL，
已下载更新包隔离到 `/tmp/proma-update-cache-quarantine/`；重启后检查失败、缓存不增长。
