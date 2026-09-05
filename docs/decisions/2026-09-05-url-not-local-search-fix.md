# 用户给 GitHub 链接时先读远端，不做全盘本地搜索
日期：2026-09-05
状态：implemented
相关 Goal：deepseek-v4-flash(Fresh) 优化 DeepSeek（docs/goal-success-signals.md）

## Problem
用户问「https://github.com/diodeme/Gold-Band 本地的 Gold-Band 好用吗？怎么用？
怎么配置好？」时，Proma 的 DeepSeek 子代理拿到链接后**没有打开链接**，反而在本机
全盘 find 同名目录，答非所问。用户反馈「github 的链接给了居然本地全盘找，直接看
打开链接看文件就好了」——模型的工具偏好 + persona 缺 URL 引导，导致跨语义域执行。

## Decision
在 v4-anchor 的 persona 与 bash 工具描述里显式加入「外部引用优先读远端」策略
（主会话与子代理共用同一份 minimal persona，一处改全部生效）：
- 用户给了 github.com 链接 → 先 `curl raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md`
  或查 `api.github.com/repos/<owner>/<repo>` 元数据，从远端真实内容作答；
- 本地查找降级为兜底，且只允许 cwd / 项目根 / `~/.gold-band` / `/Applications`；
- bash 描述纠正「You don't have access to the internet via this tool」为
  「You DO have network access — curl https URL」，并强制 `--max-time 15-30`；
- 同一做法连续失败两次（两击规则）→ 停止换路，不硬试第三遍。

为什么不用 X：只调请求参数/温度不解决（问题在 persona 的工具意图）；只在主会话
写规则不解决（子代理不吃主会话 prompt，必须落在共享 minimal persona）。

验收：问 Gold-Band 仓库链接 → 会话内先出现 curl README / api.github.com 动作，
不再出现全盘 find。
