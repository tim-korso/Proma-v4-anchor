# 完全自动模式下 AskUserQuestion 由 Agent 自主决策（不再阻塞等人）

日期：2026-09-03
状态：implemented
相关 Goal：deepseek-v4-flash(Fresh) 优化 DeepSeek（docs/goal-success-signals.md）

## Problem

DeepSeek 在 Proma 里以 `bypassPermissions`（完全自动）默认为主运行。此前
`AskUserQuestion` 无条件走「等待 GUI 用户逐条回答」；没有 GUI 订阅者时
（IM 桥、自动化、协作子 Agent）整个 turn 会永久卡死在 AskUserQuestion 上，
模型「邀请用户」却没人接，与完全自动语义冲突，也是 DeepSeek 显得「不聪明/拒绝特殊任务」的
一个来源。

## Decision

`agent-orchestrator.ts` 的 canUseTool 分支：`currentMode === 'bypassPermissions'`
时 AskUserQuestion 直接放行——

- questions 带 `id` + `_default` 时，用默认答案回填 `answers`；
- 否则置空 `answers`，把决策权交回模型（模型通常下一轮自主继续，而不是再次触发同一询问）。

plan 模式 / 交互式审批路径不变；既有护栏（Write 大文件截断、plan 只读、BrowserUpload /
PowerShell 审批、planning-deletion）均未动。AskUserQuestion 工具描述与参数 schema 新增
`id` / `_default` 字段，指导模型在完全自动模式下给出默认答案自决。

## Alternatives

| 方案 | 为什么输 |
|---|---|
| 全局禁用 AskUserQuestion 工具 | 会破坏 plan 模式与交互式审批的核心问答能力，误伤面太大 |
| 在 Pi session 层注入「不要调用 AskUserQuestion」的提示词 | 提示词不是执行机制（项目既有教训 06-11）；模型仍会在不确定时调用，照样卡死 |
| 仅依赖会话监控中断兜底 | 中断只是止血，turn 仍会空转等待；让模型自决才是完全自动语义的正解 |

## Consequences

收益：完全自动模式下 DeepSeek 遇到不确定时自主决策继续，不被 AskUserQuestion 卡死；
提升自主执行能力；plan 等需确认模式保持人肉交互。

代价：完全自动模式下「Agent 主动问用户」的交互被忽略（设计如此——完全自动模式本就
不该等人）；若模型给出错误默认答案需用户事后修正。高风险外部操作仍需走既有审批工具，
不在本改动放宽。
