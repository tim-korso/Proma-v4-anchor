# commandcode 渠道 DeepSeek 也走 128K 自动压缩 + v4-anchor
日期：2026-09-05
状态：implemented
相关 Goal：deepseek-v4-flash(Fresh) 优化 DeepSeek（docs/goal-success-signals.md）

## Problem
上一轮把 DeepSeek V4-Flash 的自动压缩阈值调到 128K、并在完全自动模式放开
AskUserQuestion 自主决策、补上 v4-anchor，但这些只对「裸模型 ID」生效
（`deepseek-v4-flash` 等）。协作子代理或 commandcode 渠道使用
`deepseek/deepseek-v4-flash`、`deepseek/deepseek-v4-pro` 这类带前缀的 ID 时，
`/^deepseek-v4-flash/` 与 `/^deepseek-v4-(?:flash|pro)/` 前缀正则全部失配 →
128K 压缩与 v4-anchor 在 commandcode 渠道漏配。

## Decision
两处模型匹配从前缀锚定放宽为包含匹配：
- `packages/shared/src/utils/pi-compaction.ts`：
  `PI_AUTO_COMPACTION_128K_MODEL_PATTERN = /deepseek-v4-flash(?:-|\[|$)/i`
  （去掉 `^`；后缀仍收口，避免误命中非 flash 变体）
- `apps/electron/src/main/lib/adapters/pi-agent-adapter.ts` v4-anchor 启用判定：
  `/deepseek-v4-(?:flash|pro)(?:-|$)/i`（同样去掉 `^`）

v4-anchor core 的 `isTargetModel` 本来就是「model.provider/id/name 任一含
deepseek」的宽松判定，不需改；`rewrite*` 时按 `model.id` 原样透传，带前缀 ID
照常工作。UI 预警线（ContextUsageBadge）与运行时共用
`piEffectiveAutoCompactionThresholdTokensFor`，自动获得同源修复。

## 方案对比
| 方案 | 为什么输 |
|---|---|
| 保留前缀正则、额外加 commandcode 特判 | 渠道前缀还会有更多变体（catalog 按渠道注入），每加一个渠道就要改一次正则 |
| 直接用 `/deepseek-v4-flash/i` 裸包含 | 太宽：`not-deepseek-v4-flash-extra` 之类会误命中；保留 `(?:-|\||$)` 收口后缀 |
| 包含 + 后缀收口（采用） | 前缀任意（kdysite/commandcode/deepseek/…）都命中，且不收窄到 flash 之外 |

## Consequences
收益：commandcode 渠道的 flash/pro 自动压缩与 v4-anchor 不再漏配；主会话与
协作子会话行为一致。
代价：正则仍是字符串匹配，将来若出现「名字含 deepseek-v4-flash 但实际非
DeepSeek」的第三方模型会误命中 128K；当前渠道目录里不存在此类模型，若出现
需把匹配升级为 provider+id 联合判定。

## 交叉链接
- 上一轮：docs/decisions/2026-09-03-flash-128k-auto-compaction.md、
  docs/decisions/2026-09-03-bypass-askuser-self-service.md
- 验收：scripts/check-goal.js → data/goal-check.json（A1/A2/B2/Q1 保持绿）
