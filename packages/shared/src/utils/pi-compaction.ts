/**
 * DeepSeek V4-Flash(Fresh) 的自动压缩触发阈值（contextToken 数）。
 *
 * Proma 默认渠道（kdysite-deepseek / deepseek-v4-flash / 1M 窗口）上，把自动压缩
 * 触发阈值从「约 80% 窗口（1M=>800K）」下调到约 128K：长会话不再把 1M 窗口塞满，
 * 避免模型在超长上下文下迷失、或对特殊任务（用户要求的非常规操作）产生拒绝。
 * 触发阈值优先于按比例的 DEFAULT 0.8。
 */
import { ONE_MILLION_CONTEXT_WINDOW } from './context-window'

export const PI_AUTO_COMPACTION_128K_MODEL_PATTERN = /deepseek-v4-flash(?:-|\[|$)/i
export const PI_AUTO_COMPACTION_128K_THRESHOLD_TOKENS = 128_000
export const DEEPSEEK_V4_FLASH_COMPACTION_THRESHOLD_TOKENS = PI_AUTO_COMPACTION_128K_THRESHOLD_TOKENS

/**
 * 返回模型专属的 Pi 自动压缩触发阈值（contextToken）。
 * 无专属配置时按 DEFAULT 0.8 比例（默认 1M 窗口 => 800K）。
 */
export function piAutoCompactionThresholdTokensFor(modelId: string | undefined): number {
  if (modelId && PI_AUTO_COMPACTION_128K_MODEL_PATTERN.test(modelId)) {
    return PI_AUTO_COMPACTION_128K_THRESHOLD_TOKENS
  }
  return calculatePiAutoCompactionThresholdTokens(ONE_MILLION_CONTEXT_WINDOW)
}

/**
 * 给定模型与真实窗口，返回实际生效的自动压缩触发阈值。
 *
 * 模型专属阈值（如 DeepSeek V4-Flash 128K）优先；若专属阈值超过窗口
 * （例如非 1M 窗口的普通模型），回退到窗口的 0.8 比例，避免压缩线被定在窗口之外。
 * 运行时压缩注册与 UI 预警线共用本函数，保证两端一致。
 */
export function piEffectiveAutoCompactionThresholdTokensFor(
  modelId: string | undefined,
  contextWindow: number,
): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new TypeError('Pi context window must be a positive finite number')
  }
  const preferred = piAutoCompactionThresholdTokensFor(modelId)
  return preferred < contextWindow ? preferred : calculatePiAutoCompactionThresholdTokens(contextWindow)
}

/** Pi 自动压缩开始时的上下文占用比例。 */
export const PI_AUTO_COMPACTION_THRESHOLD_RATIO = 0.8

/**
 * 将目标上下文占用比例换算为 Pi SDK 的 reserveTokens 配置。
 *
 * Pi 在 `contextTokens > contextWindow - reserveTokens` 时自动压缩，
 * 因此预留 20% 的窗口即可在约 80% 占用时开始压缩。
 */
export function calculatePiAutoCompactionReserveTokens(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    throw new TypeError('Pi context window must be a positive finite number')
  }

  return Math.ceil(contextWindow * (1 - PI_AUTO_COMPACTION_THRESHOLD_RATIO))
}

/** 返回 Pi SDK 会开始自动压缩的上下文 token 阈值。 */
export function calculatePiAutoCompactionThresholdTokens(contextWindow: number): number {
  return contextWindow - calculatePiAutoCompactionReserveTokens(contextWindow)
}
