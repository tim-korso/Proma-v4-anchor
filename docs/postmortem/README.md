# Postmortem: <主题>

日期：<yyyy-mm-dd>
关联 Goal：<goal-objective.txt / data/goal-check.json>

## Executive summary

<30 秒读完：发生了什么、根因一句话、为什么没拦住、持久教训>

## Summary / Impact / Timeline

- 影响：<范围、时间成本、用户体验等>
- 时间线：<关键节点>

## Root cause

<根因逐条。示例：178 个单测全绿但生产崩，因为测试都手工挂载插件，没走真实 Loader 加载路径。>

## Guardrails

<具体护栏（测试、规则、ADR）。每条 Guardrail 必须能落成 check-goal.js 里的一条新 check。>

| Guardrail | 落成的新 check |
|---|---|
| <护栏 1> | <check id + 验证方式> |
| <护栏 2> | <check id + 验证方式> |

## Lessons

- <持久教训 1>
- <持久教训 2>
