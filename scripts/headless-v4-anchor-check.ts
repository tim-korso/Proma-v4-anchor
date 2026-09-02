/* eslint-disable no-console */
import { cpSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
// @ts-expect-error - script included to check config
import { PiAgentAdapter } from '../apps/electron/src/main/lib/adapters/pi-agent-adapter'
// @ts-expect-error - script included to check config
import { mergeRuntimeEnv } from '../apps/electron/src/main/lib/agent-runtime-env'

interface RunConfig {
  model: string
  threshold: number
  run: number
  prompt: string
  cwd: string
  outDir: string
  seed?: string
  keep?: boolean
}

const SYSTEM_PROMPT = 'You are a precise software engineer working in a local repository. Write real, runnable code. Execute commands with bash to verify whenever possible. Do not fabricate test output; report exactly what commands return.'

function parseArgs(argv: string[]): RunConfig {
  const args: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i]?.startsWith('--')) continue
    const key = argv[i]!.slice(2)
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for --${key}`)
    args[key] = value
    i += 1
  }
  const model = args.model ?? 'deepseek-v4-pro'
  const threshold = Number(args.threshold)
  const run = Number(args.run)
  if (!Number.isSafeInteger(threshold) || threshold <= 0) throw new Error('--threshold must be a positive integer')
  if (!Number.isSafeInteger(run) || run < 0) throw new Error('--run must be a non-negative integer')
  return {
    model,
    threshold,
    run,
    prompt: args.prompt ?? 'no prompt provided',
    cwd: resolve(args.cwd ?? process.cwd()),
    outDir: resolve(args.outDir ?? 'dist/anchor-runs'),
    seed: args.seed ? resolve(args.seed) : undefined,
    keep: args.keep === '1' || args.keep === 'true',
  }
}

async function main(): Promise<void> {
  const cfg = parseArgs(process.argv.slice(2))
  const apiKey = process.env.KDY_API_KEY ?? process.env.DEEPSEEK_API_KEY
  if (!apiKey) throw new Error('KDY_API_KEY (or DEEPSEEK_API_KEY) is required')

  const runLabel = `${cfg.model}__${cfg.threshold}__${cfg.run}`
  const outDir = join(cfg.outDir, cfg.model, String(cfg.threshold))
  mkdirSync(outDir, { recursive: true })
  const transcriptPath = join(outDir, `run-${cfg.run}.jsonl`)
  rmSync(transcriptPath, { force: true })

  const workspaceRoot = mkdtempSync(join(tmpdir(), `v4anchor-ws-${runLabel}-`))
  if (cfg.seed) {
    if (!cfg.seed.startsWith('/tmp/')) throw new Error('--seed must be under /tmp')
    cpSync(cfg.seed, workspaceRoot, { recursive: true })
  }
  const agentDir = mkdtempSync(join(tmpdir(), `v4anchor-agent-${runLabel}-`))
  const sessionDir = mkdtempSync(join(tmpdir(), `v4anchor-session-${runLabel}-`))

  const taskPrompt = `${cfg.prompt}\n\n工作目录: ${workspaceRoot}`
  const transcript: unknown[] = []
  const writeTranscript = (): void => {
    writeFileSync(transcriptPath, transcript.map((line) => JSON.stringify(line)).join('\n') + '\n')
  }

  console.log(`[${runLabel}] cwd=${workspaceRoot}`)
  const startedAt = Date.now()
  const sdkSessionId = randomUUID()
  const adapter = new PiAgentAdapter()
  let done = 0
  let toolCalls = 0

  try {
    for await (const message of adapter.query({
      sessionId: sdkSessionId,
      prompt: taskPrompt,
      model: cfg.model,
      cwd: workspaceRoot,
      apiKey,
      baseUrl: 'https://ai.kdysite.cloud/v1',
      provider: 'custom',
      channelName: 'kdysite-deepseek',
      permissionMode: 'bypassPermissions',
      systemPrompt: SYSTEM_PROMPT,
      piAgentDir: agentDir,
      piSessionDir: sessionDir,
      canUseTool: async () => ({ behavior: 'allow' } as const),
      runtimeEnv: mergeRuntimeEnv(process.env, {}),
      v4AnchorMinThinkingTokens: cfg.threshold,
    })) {
      const entry: Record<string, unknown> = {
        seq: transcript.length,
        ts: Date.now(),
        type: (message as { type?: unknown }).type,
      }
      const m = message as Record<string, unknown>
      if (m.session_id !== undefined) entry.session_id = m.session_id
      if (m.uuid !== undefined) entry.uuid = m.uuid
      if (m.delta !== undefined) entry.delta = m.delta
      if (m.tool_name !== undefined) entry.tool_name = m.tool_name
      if (m.tool_use_id !== undefined) entry.tool_use_id = m.tool_use_id
      if (m.text !== undefined) entry.text = typeof m.text === 'string' ? m.text.slice(0, 4000) : m.text
      if (m.usage !== undefined) entry.usage = m.usage
      if (m.error !== undefined) entry.error = m.error
      if (m.subtype !== undefined) entry.subtype = m.subtype
      if (m.model !== undefined && m.type === 'system') entry.model = m.model
      if ((m as { type?: string }).type === 'tool_progress') {
        toolCalls += 1
        entry.tool_calls_so_far = toolCalls
      }
      transcript.push(entry)
      if (transcript.length % 20 === 0) writeTranscript()
      const resultMsg = m as { type?: string; result?: unknown }
      if (resultMsg.type === 'result') {
        done = 1
        if (resultMsg.result !== undefined) entry.result = resultMsg.result
        break
      }
    }
  } catch (error) {
    const entry: Record<string, unknown> = { seq: transcript.length, ts: Date.now(), type: 'harness_error', error: String(error) }
    transcript.push(entry)
  } finally {

    if (!done) transcript.push({ seq: transcript.length, ts: Date.now(), type: 'harness_end', done: false, toolCalls })
    writeTranscript()
    // Keep the session artifact for anchor-state verification (before cleanup).
    let anchorState: unknown
    let sessionMessages = 0
    let sessionFileCopied = false
    try {
      const files = readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl'))
      if (files.length > 0) {
        const sessionPath = join(sessionDir, files[0]!)
        const raw = readFileSync(sessionPath, 'utf8')
        const lines = raw.split('\n').filter(Boolean)
        sessionMessages = lines.length
        const states: unknown[] = []
        for (const line of lines) {
          try {
            const obj = JSON.parse(line)
            if (obj?.type === 'custom' && obj?.customType === 'v4-anchor-state') {
              states.push(obj.data)
            }
          } catch { /* skip non-json lines */ }
        }
        if (states.length > 0) anchorState = states[states.length - 1]
        const copyPath = join(outDir, `run-${cfg.run}-session.jsonl`)
        writeFileSync(copyPath, raw)
        sessionFileCopied = true
      }
    } catch (error) {
      transcript.push({ seq: transcript.length, ts: Date.now(), type: 'harness_session_error', error: String(error) })
    }
    writeTranscript()
    console.log(`[${runLabel}] anchorState=${JSON.stringify(anchorState)} sessionMessages=${sessionMessages} sessionCopied=${sessionFileCopied}`)

    try { adapter.dispose?.(sdkSessionId) } catch { /* noop */ }
    if (cfg.keep) {
      const keptPath = join(outDir, `run-${cfg.run}-workspace`)
      rmSync(keptPath, { recursive: true, force: true })
      cpSync(workspaceRoot, keptPath, { recursive: true })
      console.log(`[${runLabel}] kept workspace at ${keptPath}`)
    }
    rmSync(workspaceRoot, { recursive: true, force: true })
    rmSync(agentDir, { recursive: true, force: true })
    rmSync(sessionDir, { recursive: true, force: true })
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[${runLabel}] done=${done} toolCalls=${toolCalls} elapsed=${elapsedSec}s transcript=${transcriptPath}`)
}

void main()
