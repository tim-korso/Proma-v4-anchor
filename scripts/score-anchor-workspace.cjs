#!/usr/bin/env node
/* eslint-disable no-console */
// Score an anchor experiment workspace (task-a or task-b) by running its own
// native checks in an isolated CJS context (tasks use require()/CommonJS; test
// must not be under the experiment host's "type":"module").
const { spawnSync } = require("node:child_process")
const { mkdtempSync, readFileSync, existsSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join, resolve } = require("node:path")

const wsPath = resolve(process.argv[2] || '')
// Detect task by content: parser upgrade fixture has check.js + spec/format-v2.md
const hasCheck = existsSync(join(wsPath, 'tests', 'check.js'))
const hasSpecV2 = existsSync(join(wsPath, 'spec', 'format-v2.md'))
const isB = hasCheck && hasSpecV2
const out = { ws: wsPath, task: isB ? 'b' : 'a', ok: false, checks: {} }

if (!existsSync(wsPath)) {
  console.log(JSON.stringify({ ...out, error: 'workspace missing' }))
  process.exit(1)
}

// Isolate: copy outside any "type":"module" scope so .js stays CJS.
const tmp = mkdtempSync(join(tmpdir(), 'anchor-score-'))
const target = join(tmp, 'ws')
const cp = spawnSync('cp', ['-R', wsPath, target], { encoding: 'utf8' })
if (cp.status !== 0) {
  console.log(JSON.stringify({ ...out, error: 'copy failed', stderr: cp.stderr }))
  process.exit(1)
}

const runTry = (label, cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { cwd: target, encoding: 'utf8', timeout: 120000 })
    return { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').slice(0, 4000), stderr: (r.stderr || '').slice(0, 2000) }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

if (isB) {
  const t = runTry('check.js', 'node', ['tests/check.js'])
  out.checks.checkJs = t.ok
  let v2Heuristic = false
  let fieldsUpdated = false
  try {
    const p = readFileSync(join(target, 'src/parser/parser.js'), 'utf8')
    const f = readFileSync(join(target, 'src/parser/fields.js'), 'utf8')
    // Weak source heuristics are only informational: the hard completion gate
    // for task-b is tests/check.js actually passing (it asserts real v2
    // behavior incl. line-numbered errors + numeric KV). Some correct v2
    // implementations drive tokens from fields.js (FIELDS[0].key) and have no
    // literal 'TS=' etc., so a strict literal-token regex would false-negative.
    v2Heuristic = /TS=/.test(p) && /LVL=/.test(p) && /SVC=/.test(p) && /KV=/.test(p)
    fieldsUpdated = f.includes('INFO') && f.includes('WARN') && f.includes('ERROR') && f.includes('DEBUG')
  } catch { /* ignore */ }
  out.checks.v2Heuristic = v2Heuristic
  out.checks.fieldsUpdated = fieldsUpdated
  out.ok = t.ok && fieldsUpdated
} else {
  const t = runTry('invoice.test.js', 'node', ['tests/invoice.test.js'])
  out.checks.invoiceTest = t.ok
  let calcExports = false
  let invoiceUsesCalc = false
  try {
    const calc = readFileSync(join(target, 'src/calc.js'), 'utf8')
    calcExports = /calcSegmentTotal/.test(calc) && /normalizeDate/.test(calc) && /addDays/.test(calc)
    const invoice = readFileSync(join(target, 'src/invoice.js'), 'utf8')
    invoiceUsesCalc = /calc/.test(invoice) && !/\.\/segments/.test(invoice) && !/\.\/dates/.test(invoice)
  } catch { /* ignore */ }
  out.checks.calcExports = calcExports
  out.checks.invoiceUsesCalc = invoiceUsesCalc
  out.ok = t.ok && calcExports && invoiceUsesCalc
}

console.log(JSON.stringify(out))
