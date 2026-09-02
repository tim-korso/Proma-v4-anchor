#!/usr/bin/env node
/* Aggregate all anchor experiment runs: score workspaces + anchor/transcript metrics. */
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = join(process.cwd(), 'dist/anchor-runs/deepseek-v4-pro')
const scoreScript = join(process.cwd(), 'scripts/score-anchor-workspace.cjs')

function readJsonl(p) {
  const out = []
  for (const l of readFileSync(p, 'utf8').split('\n')) {
    if (!l.trim()) continue
    try { out.push(JSON.parse(l)) } catch { /* skip */ }
  }
  return out
}

// Map a dir basename to (threshold, taskLabel). Backup dirs carry real task-a runs
// that were rotated out before task-b reused the run slot files.
function metaOf(dirname, run) {
  const m = /^(\d+)-taska-backup$/.exec(dirname)
  if (m) return { threshold: Number(m[1]), task: 'a', src: dirname }
  if (/^\d+$/.test(dirname)) {
    // task by content: search the workspace for task-b marker (tests/check.js)
    return { threshold: Number(dirname), task: '?', src: dirname }
  }
  return null
}

const rows = []
for (const dirname of readdirSync(BASE)) {
  const dir = join(BASE, dirname)
  if (!existsSync(dir)) continue
  const meta = metaOf(dirname)
  if (!meta) continue
  for (const name of readdirSync(dir)) {
    const m = /^run-(\d+)-workspace$/.exec(name)
    if (!m) continue
    const run = Number(m[1])
    if (run > 2) continue
    const ws = join(dir, name)
    const sessionP = join(dir, `run-${run}-session.jsonl`)
    const transP = join(dir, `run-${run}.jsonl`)
    let score = { ok: false, checks: {} }
    try {
      score = JSON.parse(execFileSync('node', [scoreScript, ws], { encoding: 'utf8' }).trim())
    } catch (e) { score = { ok: false, checks: {}, error: String(e) } }

    let states = [], reas = [], msgs = 0
    if (existsSync(sessionP)) {
      const lines = readJsonl(sessionP)
      msgs = lines.length
      states = lines.filter((o) => o.type === 'custom' && o.customType === 'v4-anchor-state').map((o) => o.data)
      reas = lines.filter((o) => o.type === 'message' && o.message?.role === 'assistant' && o.message?.usage)
        .map((o) => o.message.usage.reasoning ?? 0)
    }
    let toolCalls = 0, done = false, elapsed = null, lines = 0
    if (existsSync(transP)) {
      const tl = readJsonl(transP)
      lines = tl.length
      toolCalls = tl.filter((o) => o.type === 'tool_progress').length
      const last = tl[tl.length - 1]
      done = last?.type === 'result'
      if (tl.length && last?.ts) elapsed = Math.round((last.ts - tl[0].ts) / 1000)
    }
    const finalState = states[states.length - 1] || null
    rows.push({
      threshold: meta.threshold, run, task: score.task === 'b' ? 'b' : 'a', src: meta.src,
      ok: scopeBoolean(score.ok), checks: score.checks,
      finalPhase: finalState?.phase ?? null,
      promoted: states.some((s) => s.phase === 'promoted'),
      thinkingSum: reas.reduce((a, b) => a + b, 0),
      thinkingSeq: reas,
      toolCalls, done, elapsedSec: elapsed, sessionMsgs: msgs, transLines: lines,
    })
  }
}
function scopeBoolean(v) { return v === true || v === 'true' }
rows.sort((a, b) => a.task.localeCompare(b.task) || a.threshold - b.threshold || a.run - b.run)
console.log(JSON.stringify({ rows }, null, 2))
