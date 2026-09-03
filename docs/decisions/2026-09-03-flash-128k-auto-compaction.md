# DeepSeek V4-Flash(Fresh) 自动压缩触发阈值调至 128K

日期：2026-09-03
状态：implemented
相关 Goal：deepseek-v4-flash(Fresh) 优化 DeepSeek（docs/goal-success-signals.md）

## Problem

Proma 默认渠道 kdysite-deepseek 使用 deepseek-v4-flash(Fresh)、1M 窗口。自动压缩
原本按「窗口 80%」触发（1M => 约 800K 才压缩）。长会话把上下文塞到接近 1M 后，
模型在超长上下文下迷失、对用户要求的特殊/非常规任务倾向拒绝。用户要求把自动压缩
触发阈值调到约 128K，让长会话更早压缩、更聪明、不易拒绝特殊任务。

## Decision

保留模型窗口注册为 1M（不改 context-window registry），只把 **deepseek-v4-flash
系列的自动压缩触发阈值**下调为 **128K tokens**：

- `packages/shared/src/utils/pi-compaction.ts` 新增按模型策略：
  `PI_AUTO_COMPACTION_128K_MODEL_PATTERN = /^deepseek-v4-flash(?:-|\[|$)/i`，
  `piAutoCompactionThresholdTokensFor(modelId)` 命中即返回 128K，其他模型按 0.8 比例。
- 运行时注册换算为 reserveTokens：`piEffectiveAutoCompactionThresholdTokensFor(modelId, contextWindow)`
  命中 flash 且窗口 > 128K 时 reserveTokens = contextWindow - 128K（1M => 872K），
  窗口 ≤ 128K 或非 flash 回退 0.8 比例，避免压缩线被定在窗口外。
- `ContextUsageBadge` 的预警线改走同一函数，UI 与运行时一致（DeepSeek V4-Flash
  在约 102K 占用时圆环变琥珀预警，128K 触发压缩）。

## Alternatives

| 方案 | 为什么输 |
|---|---|
| 把模型窗口注册改小（如 deepseek-v4-flash => 200K/128K） | 窗口是模型能力与计费展示的真实值，改小会让「上下文 / 1M」显示失真、且影响渠道能力判定；用户明确语义是「压缩阈值调至 128K」而非窗口改小 |
| 只改 pi-agent-adapter 一处、不回填 UI 预警线 | 运行时在 128K 压缩而 UI 仍在 800K 才预警，两步不一致会给用户错误预期 |
| 用 `${modelId}-128k` 拼窗口名触发 | 脆：模型 ID 后缀/渠道差异（`-vision-exp`、`[1m]`）都会失配；直接按前缀正则更稳 |

## Consequences

收益：Fresh 在 128K 占用即压缩，避免超长上下文迷失/拒绝特殊任务；1M 能力与展示不变；
UI 预警与运行时压缩线同源。

代价：Fresh 的压缩频率比之前高（128K 阈值下长会话会更早进入自动压缩）；
`piAutoCompactionThresholdTokensFor` 无参数时按 800K 推算，只在「被错误调用」时
产生偏差（有效路径均已传入真实窗口）；`ContextUsageBadge` 多订阅一个 streaming
state，属于轻量增量。
