import { describe, expect, test } from 'bun:test'
import {
  DEEPSEEK_V4_FLASH_COMPACTION_THRESHOLD_TOKENS,
  PI_AUTO_COMPACTION_128K_THRESHOLD_TOKENS,
  PI_AUTO_COMPACTION_THRESHOLD_RATIO,
  calculatePiAutoCompactionReserveTokens,
  calculatePiAutoCompactionThresholdTokens,
  piAutoCompactionThresholdTokensFor,
  piEffectiveAutoCompactionThresholdTokensFor,
} from './pi-compaction'
import { ONE_MILLION_CONTEXT_WINDOW } from './context-window'

describe('Pi 自动压缩按模型触发阈值', () => {
  test('deepseek-v4-flash(Fresh) 触发阈值 = 128K', () => {
    expect(PI_AUTO_COMPACTION_128K_THRESHOLD_TOKENS).toBe(128_000)
    expect(DEEPSEEK_V4_FLASH_COMPACTION_THRESHOLD_TOKENS).toBe(128_000)
    expect(piAutoCompactionThresholdTokensFor('deepseek-v4-flash')).toBe(128_000)
  })

  test('deepseek-v4-flash 变体仍命中（vision-exp / 渠道后缀）', () => {
    expect(piAutoCompactionThresholdTokensFor('deepseek-v4-flash-vision-exp')).toBe(128_000)
  })

  test('其他模型按默认 0.8 比例（1M => 800K）', () => {
    expect(piAutoCompactionThresholdTokensFor('deepseek-v4-pro')).toBe(
      calculatePiAutoCompactionThresholdTokens(ONE_MILLION_CONTEXT_WINDOW),
    )
    expect(piAutoCompactionThresholdTokensFor(undefined)).toBe(
      calculatePiAutoCompactionThresholdTokens(ONE_MILLION_CONTEXT_WINDOW),
    )
  })

  test('reserveTokens 语义：阈值 = contextWindow - reserveTokens', () => {
    expect(calculatePiAutoCompactionThresholdTokens(ONE_MILLION_CONTEXT_WINDOW)).toBe(
      ONE_MILLION_CONTEXT_WINDOW - calculatePiAutoCompactionReserveTokens(ONE_MILLION_CONTEXT_WINDOW),
    )
    expect(calculatePiAutoCompactionReserveTokens(ONE_MILLION_CONTEXT_WINDOW)).toBe(
      Math.ceil(ONE_MILLION_CONTEXT_WINDOW * (1 - PI_AUTO_COMPACTION_THRESHOLD_RATIO)),
    )
  })
})

describe('Pi 自动压缩按模型触发阈值 — 生效值与窗口边界', () => {
  test('flash 在 1M 窗口下生效阈值 = 128K', () => {
    expect(piEffectiveAutoCompactionThresholdTokensFor('deepseek-v4-flash', ONE_MILLION_CONTEXT_WINDOW)).toBe(128_000)
  })

  test('专属阈值超过窗口时回退到 0.8 比例（不把压缩线定在窗口外）', () => {
    // 普通 200K 窗口模型：128K 专属阈值仍 < 200K，正常生效
    expect(piEffectiveAutoCompactionThresholdTokensFor('deepseek-v4-flash', 200_000)).toBe(128_000)
    // 窗口小于专属阈值（如 100K）：回退 0.8 比例，压缩线落在窗口内
    expect(piEffectiveAutoCompactionThresholdTokensFor('deepseek-v4-flash', 100_000)).toBe(80_000)
    // 普通模型：1M 窗口 0.8 比例 = 800K
    expect(piEffectiveAutoCompactionThresholdTokensFor('deepseek-v4-pro', ONE_MILLION_CONTEXT_WINDOW)).toBe(800_000)
  })

  test('无效窗口参数抛错', () => {
    expect(() => piEffectiveAutoCompactionThresholdTokensFor('deepseek-v4-flash', Number.NaN)).toThrow()
    expect(() => piEffectiveAutoCompactionThresholdTokensFor('deepseek-v4-flash', 0)).toThrow()
  })
})

describe('commandcode 渠道模型（deepseek/ 前缀）', () => {
  test('deepseek/deepseek-v4-flash（commandcode）命中 128K', () => {
    expect(piAutoCompactionThresholdTokensFor('deepseek/deepseek-v4-flash')).toBe(128_000)
    expect(piEffectiveAutoCompactionThresholdTokensFor('deepseek/deepseek-v4-flash', ONE_MILLION_CONTEXT_WINDOW)).toBe(128_000)
  })

  test('commandcode flash vision 变体仍命中', () => {
    expect(piAutoCompactionThresholdTokensFor('deepseek/deepseek-v4-flash-vision-exp')).toBe(128_000)
  })
})
