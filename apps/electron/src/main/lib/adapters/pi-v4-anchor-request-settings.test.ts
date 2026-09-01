import { describe, expect, test } from 'bun:test'
import {
  ANCHOR_STATE_ENTRY,
  MINIMAL_PERSONA,
  captureContinuationSystemPrompt,
  hasConversation,
  isTargetModel,
  readAnchorState,
  rewriteBootstrapPayload,
  rewritePersistentPayload,
} from './pi-v4-anchor-core'

/** Proma Pi runtime names its file editor `edit`, not `str_replace_editor`. */
const editToolOpenAI = {
  type: 'function',
  name: 'edit',
  description: 'Edit a file',
  parameters: { type: 'object', properties: {} },
}

const editToolChat = {
  type: 'function',
  function: {
    name: 'edit',
    description: 'Edit a file',
    parameters: { type: 'object', properties: {} },
  },
}

describe('Proma v4-anchor core (source-level port, bash+edit)', () => {
  test('matches every DeepSeek-family model across supported APIs', () => {
    expect(isTargetModel({ provider: 'custom', id: 'deepseek-v4-pro', api: 'openai-completions' })).toBe(true)
    expect(isTargetModel({ provider: 'deepseek', id: 'deepseek-v4-flash', api: 'openai-completions' })).toBe(true)
    expect(isTargetModel({ provider: 'custom', id: 'deepseek-v4-flash-vision-exp', api: 'openai-completions' })).toBe(true)
    expect(isTargetModel({ provider: 'provider-a', id: 'deepseek-v4-pro', api: 'openai-responses' })).toBe(true)
    expect(isTargetModel({ provider: 'gateway', id: 'gateway/deepseek-v4-pro', api: 'anthropic-messages' })).toBe(true)
    expect(isTargetModel({ provider: 'provider-a', id: 'deepseek-v4-pro', api: 'google-generative-ai' })).toBe(false)
    expect(isTargetModel({ provider: 'provider-a', id: 'grok-4.5', api: 'openai-completions' })).toBe(false)
    expect(isTargetModel(undefined)).toBe(false)
  })

  test('rewrites an OpenAI Chat Completions bootstrap payload to minimal system + bash/edit', () => {
    const payload = {
      model: 'deepseek-v4-pro',
      stream: false,
      instructions: 'INVALID CHAT FIELD',
      store: true,
      messages: [
        { role: 'system', content: 'Full Pi system prompt' },
        { role: 'user', content: 'Implement the task' },
      ],
      tools: [
        { type: 'function', function: { name: 'read', description: 'Read files', parameters: { type: 'object' } } },
        { type: 'function', function: { name: 'bash', description: 'Normal Pi bash', parameters: { type: 'object', properties: { command: { type: 'string' } } } } },
        editToolChat,
        { type: 'function', function: { name: 'grep', description: 'Grep', parameters: { type: 'object' } } },
      ],
      tool_choice: { type: 'function', function: { name: 'read' } },
      max_completion_tokens: 384_000,
    }

    const rewritten: any = rewriteBootstrapPayload(payload, {
      api: 'openai-completions',
      modelId: 'deepseek-v4-pro',
    })

    expect(rewritten.messages).toEqual([
      { role: 'system', content: MINIMAL_PERSONA },
      { role: 'user', content: 'Implement the task' },
    ])
    expect(rewritten.tools.map((tool: any) => tool.function.name)).toEqual(['bash', 'edit'])
    expect(rewritten.tools[0].function.description).toMatch(/Run commands in a bash shell/)
    expect(rewritten.instructions).toBeUndefined()
    expect(rewritten.store).toBeUndefined()
    expect(rewritten.tool_choice).toBe('auto')
    expect(rewritten.model).toBe('deepseek-v4-pro')
    expect(rewritten.stream).toBe(true)
    // does not leak other tools into the bootstrap turn
    expect(JSON.stringify(rewritten)).not.toContain('"read"')
    expect(JSON.stringify(rewritten)).not.toContain('"grep"')
  })

  test('rewrites an OpenAI Responses bootstrap payload using the Proma edit tool', () => {
    const payload = {
      model: 'deepseek-v4-flash',
      stream: false,
      instructions: 'LEAKED SAMPLING INSTRUCTION',
      conversation: 'conversation_123',
      previous_response_id: 'response_123',
      prompt: { id: 'prompt_123' },
      store: true,
      input: [
        { role: 'developer', content: 'Full Pi system prompt' },
        { role: 'user', content: 'Implement the task' },
      ],
      tools: [
        { type: 'function', name: 'read', description: 'Read files', parameters: { type: 'object' } },
        { type: 'function', name: 'bash', description: 'Normal Pi bash', parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number' } } } },
        editToolOpenAI,
      ],
      tool_choice: { type: 'function', name: 'read' },
      max_output_tokens: 384_000,
    }

    const rewritten: any = rewriteBootstrapPayload(payload, {
      api: 'openai-responses',
      modelId: 'deepseek-v4-flash',
    })

    expect(rewritten.input).toEqual([
      { role: 'developer', content: MINIMAL_PERSONA },
      { role: 'user', content: 'Implement the task' },
    ])
    expect(rewritten.tools.map((tool: any) => tool.name)).toEqual(['bash', 'edit'])
    expect(rewritten.tools[0].parameters).toEqual({
      type: 'object',
      properties: { command: { type: 'string', description: 'The bash command to run.' } },
      required: ['command'],
      additionalProperties: false,
    })
    expect(rewritten.instructions).toBe(MINIMAL_PERSONA)
    expect(rewritten.tool_choice).toBe('auto')
    expect('conversation' in rewritten).toBe(false)
    expect('previous_response_id' in rewritten).toBe(false)
    expect('prompt' in rewritten).toBe(false)
    expect(rewritten.model).toBe('deepseek-v4-flash')
    expect(rewritten.stream).toBe(true)
    expect(rewritten.store).toBe(false)
    expect(payload.tools[0]!.name).toBe('read')
  })

  test('refuses bootstrap when the Proma edit tool is missing', () => {
    expect(() => rewriteBootstrapPayload({
      model: 'deepseek-v4-pro',
      input: [
        { role: 'system', content: 'normal' },
        { role: 'user', content: 'work' },
      ],
      tools: [{ type: 'function', name: 'bash', description: 'bash', parameters: {} }],
    }, { api: 'openai-responses' })).toThrow(/missing required bootstrap tool.*edit/i)
  })

  test('rewrites a persistent payload to minimal system + injected context user message', () => {
    const payload = {
      model: 'deepseek-v4-pro',
      stream: false,
      messages: [
        { role: 'system', content: 'Full Pi system prompt' },
        { role: 'user', content: 'Continue the task' },
        { role: 'assistant', content: 'I will check the source first', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      ],
      tools: [editToolChat, { type: 'function', function: { name: 'bash', description: 'bash', parameters: {} } }],
      max_completion_tokens: 2048,
    }

    const rewritten: any = rewritePersistentPayload(payload, {
      api: 'openai-completions',
      context: 'ORIGINAL FULL SYSTEM PROMPT\n\n<session-history>condensed history</session-history>',
    })

    expect(rewritten.messages[0]).toEqual({ role: 'system', content: MINIMAL_PERSONA })
    const contextItem: any = rewritten.messages.find((m: any) => JSON.stringify(m).includes('ORIGINAL FULL SYSTEM PROMPT'))
    expect(contextItem).toBeDefined()
    expect(contextItem.role).toBe('user')
    expect(JSON.stringify(contextItem)).toContain('<v4-anchor-context>')
    // assistant + tool history preserved unchanged
    expect(rewritten.messages.some((m: any) => m.role === 'assistant' && m.tool_calls)).toBe(true)
    expect(rewritten.messages.some((m: any) => m.role === 'tool')).toBe(true)
  })

  test('captures the baseline system prompt as persistent anchor context', () => {
    const baseline = 'BASE PI SYSTEM PROMPT'
    const context = captureContinuationSystemPrompt({
      messages: [
        { role: 'system', content: `${MINIMAL_PERSONA}\n\nMAGIC CONTEXT` },
        { role: 'user', content: 'continue' },
      ],
    }, baseline, 'openai-completions')
    expect(context).toBe(`${baseline}\n\nMAGIC CONTEXT`)
  })

  test('reports state from persisted custom entries without counting them as conversation', () => {
    const state = readAnchorState([
      { type: 'model_change' },
      { type: 'custom', customType: ANCHOR_STATE_ENTRY, data: { enabled: true, phase: 'promoted' } },
    ])
    expect(state).toEqual({ enabled: true, phase: 'promoted' })
    expect(hasConversation([
      { type: 'custom', customType: ANCHOR_STATE_ENTRY, data: { enabled: true, phase: 'bootstrap' } },
    ])).toBe(false)
    expect(hasConversation([{ type: 'message', message: { role: 'user', content: 'work' } }])).toBe(true)
  })
})
