import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  ANCHOR_STATE_ENTRY,
  captureContinuationSystemPrompt,
  hasConversation,
  isTargetModel,
  readAnchorState,
  rewriteBootstrapPayload,
  rewritePersistentPayload,
  type AnchorApi,
  type AnchorPhase,
} from './pi-v4-anchor-core'

const STATUS_KEY = 'proma-v4-anchor'

export interface PromaV4AnchorOptions {
  modelId?: string
}

/**
 * Source-level port of the DeepSeek V4 anchor (bootstrap → persistent minimal).
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
 *  - keeps the default promote flow unchanged (threshold/hold untouched):
 *    fresh session first request → minimal system + bash/edit;
 *    after the first tool-less reply (or tool_result) → persist `promoted`;
 *    every later request → minimal system + original system context injected as
 *    a user message (`<v4-anchor-context>`).
 *
 * State is persisted in the session as the custom entry `v4-anchor-state`, so it
 * survives Proma's per-turn extension re-instantiation.
 */
export function createPromaV4AnchorExtension(options: PromaV4AnchorOptions = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    let phase: AnchorPhase = 'off'

    function setPhase(next: AnchorPhase, ctx: ExtensionContext): void {
      phase = next
      pi.appendEntry(ANCHOR_STATE_ENTRY, { enabled: true, phase: next })
      ctx.ui.setStatus(STATUS_KEY, `proma-v4-anchor:${next}`)
    }

    pi.on('session_start', (event, ctx) => {
      const state = readAnchorState(ctx.sessionManager.getBranch())
      phase = state.enabled ? state.phase : 'off'
      ctx.ui.setStatus(STATUS_KEY, state.enabled ? `proma-v4-anchor:${state.phase}` : 'proma-v4-anchor:off')
    })

    pi.on('before_provider_request', (event, ctx) => {
      const model = ctx.model
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
      // system + bash/edit regardless of tool calls mid-turn. Phase stays
      // 'bootstrap' until message_end / tool_result promotes it.
      if (phase === 'bootstrap') {
        return rewriteBootstrapSafely(event.payload, api, model, ctx)
      }

      // Never armed and this is an existing conversation → leave it untouched.
      if (hasConversation(ctx.sessionManager.getBranch())) return undefined

      setPhase('bootstrap', ctx)
      return rewriteBootstrapSafely(event.payload, api, model, ctx)
    })

    pi.on('message_end', (event, ctx) => {
      if (phase !== 'bootstrap') return
      const message = event.message as { role?: string; stopReason?: string; content?: unknown }
      if (message.role !== 'assistant') return
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return
      // A tool-calling reply keeps this first bootstrap turn minimal until the
      // tool result lands; a plain reply promotes immediately.
      if (hasToolCall(message)) return
      setPhase('promoted', ctx)
    })

    pi.on('tool_result', (_event, ctx) => {
      if (phase !== 'bootstrap') return
      setPhase('promoted', ctx)
    })

    pi.on('agent_end', (_event, ctx) => {
      if (phase === 'bootstrap') setPhase('promoted', ctx)
    })
  }
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
