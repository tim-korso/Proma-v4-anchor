# 终止条件手册 — Proma DeepSeek V4-Flash(Fresh) 优化

> 需求原话：用 deepseek-v4-flash(Fresh) 优化 Proma：自动压缩调至 128K、放开权限提升自主执行、参考 pi 最佳实践优化底层 pi，让 DeepSeek 在 Proma 里更聪明、不易拒绝特殊任务。
> 出口命令：`node scripts/check-goal.js`（读取 `data/goal-check.json`，`all === true` 结束）。

## 术语锚点

- **Fresh = deepseek-v4-flash**（Proma 默认 Agent 渠道 kdysite-deepseek 的默认模型）。
- **「调至 128K」语义（已在 2026-09-03 与用户确认）**：把 deepseek-v4-flash 的**自动压缩触发阈值**调到上下文约 **128K tokens**（不把模型窗口注册改小）。模型窗口仍是 1M；压缩在上下文约 128K 时触发，避免长会话把 1M 窗口塞满导致模型「迷失/拒绝」。
- **放开权限**：默认权限模式保持 `bypassPermissions`（完全自动）；本次仅把 AskUserQuestion 的「必须人肉确认」边界放开——DeepSeek 在完全自动模式下遇到不确定时用 AskUserQuestion 自主决策，不因没人回答而卡死。

## 领域与条件

| # | 层 | 条件 | 验证方式 |
|---|---|---|---|
| A1 | L0 | 128K 自动压缩已落地 | `pi-compaction.ts` 存在按模型压缩策略 `piAutoCompactionThresholdTokensFor`（128K 专属阈值）；被 adapter 实际使用 |
| A2 | L0 | 压缩阈值对 DeepSeek 生效（不止是注册） | adapter 注册路径调用 `piAutoCompactionThresholdTokensFor` / `piEffectiveAutoCompactionThresholdTokensFor`；`128_000` 存在 |
| P1 | L0 | 权限放开落地 | 完全自动模式下 AskUserQuestion 直接放行（orchestrator 返回 allow），服务层未被旁路 |
| P2 | L1 | v4-anchor 保留 | adapter 仍启用 `v4AnchorMinThinkingTokens: 2000` |
| B1 | L1 | 底层 pi 优化保留 | `context-window.ts` 的 deepseek-v4 1M 规则与 `ONE_MILLION_CONTEXT_WINDOW` 保留 |
| B2 | L1 | 变更不破坏既有护栏 | planning/Write/浏览器护栏常量仍在 orchestrator |
| Q1 | L0 | 交付质量 | electron 版本已递增（≠ 0.19.16）且 `release-notes/v<version>.md` 存在 |
| G1 | L1 | 决策有记录 | `docs/decisions/` 至少一条四段式记录；`docs/postmortem/` 至少一条复盘或显式「无失败」记录 |

## 禁止提前完成的信号

- 用占位/mock 冒充真实实现（check 必须打到真实注册路径）。
- 把「AI PM 拍脑袋的假设」当用户需求（128K 语义已确认，未确认项标 L1）。

## 变更范围

- `apps/electron/src/main/lib/agent-orchestrator.ts`（完全自动模式下 AskUserQuestion 分支）
- `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts`（AskUserQuestion 工具描述/执行器 + compaction 按模型注册）
- `packages/shared/src/utils/pi-compaction.ts`（按模型压缩策略 + 生效阈值换算）
- `packages/shared/src/utils/context-window.ts`（deepseek-v4-flash 1M 保留，未改）
- `apps/electron/src/renderer/components/agent/ContextUsageBadge.tsx`（预警线与运行时同源）
- `apps/electron/package.json`（版本递增）+ `release-notes/v<new>.md`
