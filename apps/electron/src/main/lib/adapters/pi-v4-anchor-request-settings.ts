import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  ANCHOR_STATE_ENTRY,
  captureContinuationSystemPrompt,
  hasConversation,
  isTargetModel,
  readAnchorState,
  rewriteBootstrapPayload,
  rewriteMinimalPayload,
  rewritePersistentPayload,
  type AnchorApi,
  type AnchorPhase,
  type AnchorState,
} from './pi-v4-anchor-core'

const STATUS_KEY = 'proma-v4-anchor'

export interface PromaV4AnchorOptions {
  modelId?: string
  /**
   * Threshold (reasoning tokens) before the bootstrap tool set is promoted to
   * the persistent minimal payload. Mirrors pi-v4-anchor-all's
   * `--min-thinking-tokens`. When omitted, the default promote flow is used
   * (first tool-less reply or tool_result → promoted immediately).
   */
  minThinkingTokens?: number
}

/**
 * Source-level port of the DeepSeek V4 anchor (bootstrap → anchored →
 * promoted) for Proma's Pi runtime.
 *
 * Why this must be source-level in Proma (root cause of `pi-v4-anchor-all`
 * not applying here):
 *  - Proma passes all extensions as `extensionFactories` written into the app
 *    source and does NOT load the user-level Pi extension discovery dir, so the
 *    standalone extension is never discovered.
 *  - The standalone extension keys on Pi's `str_replace_editor`, but Proma's Pi
 *    runtime names the built-in file editor `edit` (createEditToolDefinition),
 *    so its availability check always failed and it never armed.
 *
 * This variant:
 *  - restricts the *outgoing provider payload* (no tool registry mutation needed),
 *  - pairs the bootstrap tool set as `bash` + `edit` to match Proma's native tools,
 *  - keeps the threshold/hold values untouched: bootstrap → in-flight →
 *    anchored (accumulating `usage.reasoning` tokens) → promoted once the
 *    accumulated reasoning tokens strictly exceed `minThinkingTokens`.
 *
 * State is persisted in the session as the custom entry `v4-anchor-state`, so it
 * survives Proma's per-turn extension re-instantiation.
 */
export function createPromaV4AnchorExtension(options: PromaV4AnchorOptions = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    let phase: AnchorPhase = 'off'
    let minThinkingTokens = options.minThinkingTokens
    let thinkingTokens = 0

    function setPhase(
      next: AnchorPhase,
      ctx: ExtensionContext,
      extra: Partial<Omit<AnchorState, 'enabled' | 'phase'>> = {},
    ): void {
      phase = next
      const data: AnchorState = { enabled: true, phase: next, ...extra }
      pi.appendEntry(ANCHOR_STATE_ENTRY, data)
      ctx.ui.setStatus(STATUS_KEY, statusText(next, minThinkingTokens, thinkingTokens))
    }

    function promote(ctx: ExtensionContext): void {
      if (phase === 'promoted') return
      setPhase('promoted', ctx)
    }

    pi.on('session_start', (event, ctx) => {
      console.error('[ANCHOR] session_start', JSON.stringify({ minThinkingTokens, modelId: options.modelId }))
      const state = readAnchorState(ctx.sessionManager.getBranch())
      phase = state.enabled ? state.phase : 'off'
      if (state.enabled) {
        minThinkingTokens = minThinkingTokens ?? state.minThinkingTokens
        thinkingTokens = state.thinkingTokens ?? 0
      }
      ctx.ui.setStatus(STATUS_KEY, statusText(phase, minThinkingTokens, thinkingTokens))
    })

    pi.on('before_provider_request', (event, ctx) => {
      const model = ctx.model
      console.error('[ANCHOR] before_provider_request', JSON.stringify({ model: model ? { provider: model.provider, id: model.id, name: model.name, api: model.api } : null, phase, match: model ? isTargetModel(model) : false }))
      if (!model || !isTargetModel(model)) return undefined
      const api = apiForModel(model)
      if (!api) return undefined

      // Already promoted: keep minimal system and re-inject the full original
      // system context as a user message for every later request.
      if (phase === 'promoted') {
        try {
          const context = captureContinuationSystemPrompt(event.payload, ctx.getSystemPrompt(), api)
          return rewritePersistentPayload(event.payload, { api, context })
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          ctx.ui.notify(`Proma v4-anchor payload validation failed: ${reason}`, 'error')
          return undefined
        }
      }

      // Armed (fresh, never promoted): keep the whole first turn on minimal
      // system + bash/edit regardless of tool calls mid-turn. Anchored keeps the
      // minimal system + bash/edit too, just without re-arming semantics.
      if (phase === 'bootstrap' || phase === 'in-flight' || phase === 'anchored') {
        const rewritten = phase === 'anchored'
          ? rewriteMinimalSafely(event.payload, api, model, ctx)
          : rewriteBootstrapSafely(event.payload, api, model, ctx)
        if (rewritten !== undefined && phase === 'bootstrap') {
          setPhase('in-flight', ctx, minThinkingTokens === undefined ? {} : { minThinkingTokens, thinkingTokens })
        }
        return rewritten
      }

      // Never armed and this is an existing conversation → leave it untouched.
      if (hasConversation(ctx.sessionManager.getBranch())) return undefined

      setPhase('bootstrap', ctx, minThinkingTokens === undefined ? {} : { minThinkingTokens, thinkingTokens: 0 })
      return rewriteBootstrapSafely(event.payload, api, model, ctx)
    })

    pi.on('message_end', (event, ctx) => {
      const message = event.message as { role?: string; stopReason?: string; content?: unknown; usage?: { reasoning?: number } }
      console.error('[ANCHOR] message_end', JSON.stringify({ phase, role: message.role, stopReason: message.stopReason, usage: message.usage }))
      // bootstrap counts as an armed first turn in threshold mode: reasoning on
      // the very first assistant reply must accumulate toward the threshold.
      if (phase !== 'bootstrap' && phase !== 'in-flight' && phase !== 'anchored') return
      if (message.role !== 'assistant') return
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        if (phase === 'in-flight' || phase === 'bootstrap') {
          setPhase('bootstrap', ctx, minThinkingTokens === undefined ? {} : { minThinkingTokens, thinkingTokens })
        }
        return
      }

      if (minThinkingTokens !== undefined) {
        const tokens = reasoningTokens(message)
        thinkingTokens += tokens
        setPhase(phase, ctx, { minThinkingTokens, thinkingTokens })
        if (thinkingTokens > minThinkingTokens) promote(ctx)
        return
      }

      // Default flow (no threshold): a tool-calling reply keeps this first
      // bootstrap turn minimal until the tool result lands; a plain reply
      // promotes immediately.
      if (hasToolCall(message)) {
        if (phase === 'bootstrap') setPhase('in-flight', ctx)
        return
      }
      promote(ctx)
    })

    pi.on('tool_result', (_event, ctx) => {
      if (phase !== 'in-flight' && phase !== 'bootstrap') return
      if (minThinkingTokens !== undefined) {
        setPhase('anchored', ctx, { minThinkingTokens, thinkingTokens })
        return
      }
      promote(ctx)
    })

    pi.on('agent_end', (_event, ctx) => {
      if (phase === 'in-flight') {
        setPhase(minThinkingTokens !== undefined ? 'anchored' : 'promoted', ctx,
          minThinkingTokens === undefined ? {} : { minThinkingTokens, thinkingTokens })
      } else if (phase === 'bootstrap') {
        setPhase(minThinkingTokens !== undefined ? 'anchored' : 'promoted', ctx,
          minThinkingTokens === undefined ? {} : { minThinkingTokens, thinkingTokens })
      }
    })
  }
}

function statusText(phase: AnchorPhase, minThinkingTokens: number | undefined, thinkingTokens: number): string {
  if (phase === 'promoted') return 'proma-v4-anchor:promoted:persistent'
  if (phase === 'anchored' && minThinkingTokens !== undefined) {
    return `proma-v4-anchor:anchored:thinking=${thinkingTokens}/${minThinkingTokens}`
  }
  return `proma-v4-anchor:${phase}`
}

function reasoningTokens(message: { usage?: { reasoning?: number } }): number {
  const tokens = message.usage?.reasoning
  return Number.isSafeInteger(tokens) && (tokens ?? -1) >= 0 ? tokens as number : 0
}

function rewriteBootstrapSafely(
  payload: unknown,
  api: AnchorApi,
  model: { id?: string },
  ctx: ExtensionContext,
): unknown {
  try {
    return rewriteBootstrapPayload(payload, {
      api,
      modelId: typeof model.id === 'string' ? model.id : undefined,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`Proma v4-anchor payload validation failed: ${reason}`, 'error')
    return undefined
  }
}

function rewriteMinimalSafely(
  payload: unknown,
  api: AnchorApi,
  model: { id?: string },
  ctx: ExtensionContext,
): unknown {
  try {
    return rewriteMinimalPayload(payload, {
      api,
      modelId: typeof model.id === 'string' ? model.id : undefined,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    ctx.ui.notify(`Proma v4-anchor payload validation failed: ${reason}`, 'error')
    return undefined
  }
}

function apiForModel(model: { api?: unknown } | undefined): AnchorApi | undefined {
  return model?.api === 'openai-responses'
    || model?.api === 'openai-completions'
    || model?.api === 'anthropic-messages'
    ? model.api
    : undefined
}

function hasToolCall(message: { role?: string; stopReason?: string; content?: unknown }): boolean {
  if (message.stopReason === 'toolUse' || message.stopReason === 'tool_use') return true
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => {
    if (!block || typeof block !== 'object') return false
    const type = (block as { type?: unknown }).type
    return type === 'toolCall' || type === 'tool_use' || type === 'function_call'
  })
}
