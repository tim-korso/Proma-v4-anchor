import { describe, expect, test } from 'bun:test'
import { isRetryableAssistantError, retryAssistantCall, type AssistantMessage } from '@earendil-works/pi-ai/compat'

function failedAssistant(errorMessage: string): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    stopReason: 'error',
    errorMessage,
  } as unknown as AssistantMessage
}

describe('Pi native retry classifier', () => {
  test('classifies an OpenAI Responses terminal-event stream interruption as retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('OpenAI Responses stream ended before a terminal response event'),
    )).toBe(true)
  })

  test('classifies an OpenAI-compatible terminal-event stream interruption as retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('Error Code undefined: Upstream Responses stream ended before a terminal event'),
    )).toBe(true)
  })

  test('classifies a corrupted upstream JSON response as retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('Unexpected non-whitespace character after JSON at position 199 (line 2 column 1)'),
    )).toBe(true)
  })

  test.each([
    'peer closed connection',
    'incomplete chunked read',
    'peer closed connection without sending complete message body (incomplete chunked read)',
    'Connection error. Failed to fetch',
    'TypeError: Failed to fetch',
    'Server disconnected',
    '[hr_...] Server disconnected',
    'read ECONNRESET',
    'connect ECONNRESET',
  ])('classifies transient transport interruption "%s" as retryable', (errorMessage) => {
    expect(isRetryableAssistantError(failedAssistant(errorMessage))).toBe(true)
  })

  test.each([
    '400: {"message":"上游服务暂时不可用。 原因：上游服务、网络链路或代理返回异常响应。 解决方案：请稍后重试","type":"invalid_request_error"}',
    '400: {"message":"upstream service temporarily unavailable","type":"invalid_request_error"}',
  ])('classifies gateway upstream-temporarily-unavailable "%s" as retryable', (errorMessage) => {
    expect(isRetryableAssistantError(failedAssistant(errorMessage))).toBe(true)
  })

  test('keeps plain 400 invalid-request errors non-retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('400: {"message":"invalid parameter: max_tokens","type":"invalid_request_error"}'),
    )).toBe(false)
  })

  test('retries Failed to fetch through Pi’s actual native retry loop', async () => {
    let calls = 0
    const result = await retryAssistantCall(async () => {
      calls += 1
      return calls === 1
        ? failedAssistant('TypeError: Failed to fetch')
        : { role: 'assistant', content: [], stopReason: 'stop' } as unknown as AssistantMessage
    }, { enabled: true, maxRetries: 1, baseDelayMs: 0 }, undefined)

    expect(calls).toBe(2)
    expect(result.stopReason).toBe('stop')
  })

  test('does not broadly retry unrelated stream-ended errors', () => {
    expect(isRetryableAssistantError(
      failedAssistant('stream ended before the model emitted a local marker'),
    )).toBe(false)
  })

  test('keeps non-transient quota failures non-retryable', () => {
    expect(isRetryableAssistantError(
      failedAssistant('429 insufficient_quota: billing limit reached'),
    )).toBe(false)
  })
})
