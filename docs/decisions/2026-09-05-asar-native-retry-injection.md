# 第二轮 retry 补丁必须注入安装版 asar 的 node_modules
日期：2026-09-05
状态：implemented
相关 Goal：deepseek-v4-flash(Fresh) 优化 DeepSeek（docs/goal-success-signals.md）

## Problem
c0719b18 在 fork 的 node_modules（dev）与 bundle 应用层补了可重试词表
（`server disconnected` / `ECONNRESET` / 上游 400 文案），但用户实测
「子代理再次失败：服务繁忙 / Server disconnected / 上游服务暂时不可用」依旧出现
且无自动恢复。逐字节校验安装版 app.asar 后发现：
`node_modules/@earendil-works/pi-ai/dist/utils/retry.js` 只有 7,739B
（上游第一轮 9415c521 内容），fork 第二轮（c0719b18，dev 版本 8,490B）从未进入 App。
main.cjs / agent-runtime.cjs 是 esbuild external 化 `@earendil-works/pi-ai`，
运行时加载的就是 asar 内 node_modules 这份——App 内真正的自动重试（pi-ai 的
`retryAssistantCall` + `isRetryableAssistantError`）从未命中新词表。
应用层 error-patterns 只是把错误映射成「可点重试」，没有自动闭环。

## Decision
- 新增通用注入脚本 `scripts/repack-asar-inject.py`（支持任意 N 个文件原位替换：
  header offset/size 重算 + SHA256 integrity 按 asar 原生约定编码 + 4 字节 NUL 对齐），
  把三个文件一并写进 app.asar：
  1. `node_modules/@earendil-works/pi-ai/dist/utils/retry.js` 7,739B → 8,490B
     （dev 已 patch 版本，逐字节一致，含中英文新词）；
  2. `dist/agent-runtime.cjs` → repo 构建产物；
  3. `dist/main.cjs` → repo 构建产物（URL persona 修复同批生效）。
- 验证标准：提取三文件与源逐字节相等；preload.cjs 原样（md5 7ee34e…）；
  全量 21,681 条目中非替换项内容/完整性不变；替换项 integrity 自洽。
- asar 完整性约定勘误：>1 个 4MiB 块的条目用「join(blocks) 再 SHA256」
  （main.cjs 等大 bundle），≤1 块或小文件用 sha256(文件)（绝大多数 node_modules）——
  混用两种编码，注入脚本必须按此实现，否则运行时会报 integrity 校验失败。

为什么不用 X：只替换 dist/main.cjs 不解决（retry.js 在 node_modules，external 加载）；
把 pi-ai 打进 bundle 不选（上游依赖升级/二次构建维护成本高）；上游 asar 结构
（data 段整体位移 + 单文件 repack 脚本）复用旧脚本会破坏 preload（已有 09-02 白屏事故）。

验收：App 内出现「服务繁忙/上游 400」时自动重试并可见 retrying 事件，不再停在
「子代理再次失败」。
