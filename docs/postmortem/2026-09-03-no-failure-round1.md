# 首轮交付复盘 — 无失败（显式记录）

日期：2026-09-03
关联 Goal：deepseek-v4-flash(Fresh) 优化 DeepSeek（docs/goal-success-signals.md）

## Executive summary

本 goal（128K 自动压缩 + AskUserQuestion 自主放行 + 底层 pi 优化保留）首轮即完成，
无反复失败、无阻塞。以下记录「为什么这次顺利」与「仍需注意的边界」，作为后续迭代基线。

## Summary / Impact / Timeline

影响：DeepSeek V4-Flash(Fresh) 在完全自动模式下不再被 AskUserQuestion 卡死；
128K 触发自动压缩；v4-anchor（minThinkingTokens=2000）与 1M 窗口注册保留。
时间线：
- 需求澄清：确认「128K」= 压缩触发阈值，不是把窗口注册改小。
- 实现：pi-compaction 按模型策略 + adapter 注册 + orchestrator 放行 + UI 预警线同步。
- 验证：单测 7 条 + electron tsc + 相关组件测试全绿。

## Root cause（本复盘没有失败，记录的是「潜在复发点」）

1. `piAutoCompactionThresholdTokensFor` 无参数时按 1M 窗口推算 800K——若被误用于
   非 1M 模型且未传窗口，预警线会偏离。已用 `piEffectiveAutoCompactionThresholdTokensFor`
   把「专属阈值 ≤ 窗口」作为有效路径，且 adapter/UI 均传真实窗口。
2. AskUserQuestion 放行依赖「模型给出 `_default`」——无 `_default` 时置空 answers，
   依赖模型自主继续；若模型重复调用同一询问，仍可能多轮确认。
3. 版本递增是手动步骤，漏了会让 check-goal Q1 保持红。

## Guardrails（已落成 check-goal.js 的 check）

| # | 护栏 | check |
|---|---|---|
| 1 | 128K 按模型策略存在并被 adapter 使用 | A1 / A2 |
| 2 | 完全自动模式 AskUserQuestion 放行、服务层未绕过 | P1 |
| 3 | v4-anchor 2000 与 1M 窗口保留 | P2 / B1 |
| 4 | 既有护栏（planning/Write/浏览器）未松动 | B2 |
| 5 | 版本递增 + release-note 存在 | Q1 |
| 6 | 决策记录 + 复盘存在 | G1 |

## Lessons

- 语义先确认再动手：「压缩阈值 128K」与「窗口改 128K」是两回事，确认后没有再返工。
- 运行时与 UI 必须同源：压缩线只在 adapter 改、UI 不管，会给出错误预期。
- 完全自动模式的真解是「让 Agent 自决」，不是提示词约束，也不是靠中断兜底。
