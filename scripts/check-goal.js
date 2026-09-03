#!/usr/bin/env node
// goal-check：Proma DeepSeek V4-Flash(Fresh) 优化 — 终止条件校验
// 读取 docs/goal-success-signals.md 作为验收手册，输出 data/goal-check.json。
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT = join(ROOT, 'data', 'goal-check.json')
const ELECTRON = join(ROOT, 'apps', 'electron')

function readSource(rel) {
  const abs = join(ELECTRON, rel)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}
function readRoot(rel) {
  const abs = join(ROOT, rel)
  return existsSync(abs) ? readFileSync(abs, 'utf8') : ''
}
function readJson(rel) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) return undefined
  try { return JSON.parse(readFileSync(abs, 'utf8')) } catch { return undefined }
}

const ORCH = readSource('src/main/lib/agent-orchestrator.ts')
const ADAPTER = readSource('src/main/lib/adapters/pi-agent-adapter.ts')
const COMPACTION = readRoot('packages/shared/src/utils/pi-compaction.ts')
const CTXWINDOW = readRoot('packages/shared/src/utils/context-window.ts')
const PKG = readJson('apps/electron/package.json')

const checks = [
  { id: 'A1', desc: '按模型压缩策略存在', level: 'L0',
    verify: () => ({ pass: COMPACTION.includes('piAutoCompactionThresholdTokensFor') && (COMPACTION.includes('128_000') || COMPACTION.includes('131072')), detail: 'pi-compaction.ts per-model 128K strategy' }) },
  { id: 'A2', desc: 'deepseek-v4-flash 触发阈值=128K 接入注册', level: 'L0',
    verify: () => {
      const inAdapter = ADAPTER.includes('piEffectiveAutoCompactionThresholdTokensFor(') || ADAPTER.includes('piAutoCompactionThresholdTokensFor')
      const inShared = readRoot('packages/shared/src/utils/index.ts').includes('piEffectiveAutoCompactionThresholdTokensFor')
      const inCompaction = COMPACTION.includes('128_000') || COMPACTION.includes('131072')
      return { pass: inAdapter && inShared && inCompaction, detail: `adapter=${inAdapter} sharedExport=${inShared} compaction128K=${inCompaction}` }
    } },
  { id: 'P1', desc: '完全自动模式 AskUserQuestion 不再强制等人', level: 'L0',
    verify: () => {
      const allowAsk = ORCH.includes('return { behavior: \'allow\' as const') && ORCH.includes('AskUserQuestion')
      const noBlock = !readSource('src/main/lib/agent-ask-user-service.ts').includes('bypassPermissions')
      return { pass: allowAsk && noBlock, detail: `orchestrator=${allowAsk} serviceUnblocked=${noBlock}` }
    } },
  { id: 'P2', desc: 'v4-anchor minThinkingTokens=2000 保留', level: 'L1',
    verify: () => ({ pass: ORCH.includes('v4AnchorMinThinkingTokens: 2000'), detail: 'orchestrator anchor 2000' }) },
  { id: 'B1', desc: 'deepseek 1M contextWindow 保留', level: 'L1',
    verify: () => ({ pass: CTXWINDOW.includes('deepseek-v4') && CTXWINDOW.includes('ONE_MILLION_CONTEXT_WINDOW'), detail: '1M rule kept' }) },
  { id: 'B2', desc: '护栏未松动（planning/Write/浏览器）', level: 'L0',
    verify: () => {
      const guard = ORCH.includes('planningDeletionPermission') && ORCH.includes('WRITE_CONTENT_TOKEN_THRESHOLD') && ORCH.includes('PLAN_MODE_READ_ONLY_BROWSER_TOOLS')
      return { pass: guard, detail: 'orchestrator guards intact' }
    } },
  { id: 'Q1', desc: 'version 已递增且 release-note 存在', level: 'L0',
    verify: () => {
      const version = PKG?.version ?? ''
      const note = existsSync(join(ROOT, 'release-notes', `v${version}.md`))
      return { pass: version !== '0.19.16' && note, detail: `version=${version} note=${note}` }
    } },
]

const DOMAINS = [
  { id: 'A', name: '128K 自动压缩', checks: checks.filter(c => ['A1','A2'].includes(c.id)) },
  { id: 'P', name: '权限放开/自主执行', checks: checks.filter(c => ['P1','P2'].includes(c.id)) },
  { id: 'B', name: '底层 pi 优化保留', checks: checks.filter(c => ['B1','B2'].includes(c.id)) },
  { id: 'Q', name: '交付质量', checks: checks.filter(c => ['Q1'].includes(c.id)) },
]

function runChecks(list) {
  return list.map(c => {
    const r = (() => { try { return c.verify() } catch (e) { return { pass: false, detail: String(e.message ?? e).split('\n')[0] } } })()
    return { id: c.id, desc: c.desc, level: c.level, pass: !!r.pass, detail: r.detail }
  })
}

const results = DOMAINS.map(d => ({ id: d.id, name: d.name, all: runChecks(d.checks).every(r => r.pass), checks: runChecks(d.checks) }))
const all = results.every(d => d.all)
mkdirSync(dirname(OUT), { recursive: true })
const out = { all, generatedAt: new Date().toISOString(), domains: results }
writeFileSync(OUT, JSON.stringify(out, null, 2))
console.log(JSON.stringify(out, null, 2))
console.log(all ? 'ALL PASS ✅' : 'FAIL ❌ — see data/goal-check.json')
process.exit(all ? 0 : 1)
