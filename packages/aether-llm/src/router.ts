/**
 * Model router — pick the right brain for the job.
 *
 * Default policy of the Aether demo fleet:
 *   fast  → Atria-Dawn  (free / quick / generous quota) — greetings, extraction, glue
 *   strong→ deepseek-v4.1 (strong / costly)            — architecture, long-context reasoning
 *
 * The router also implements *graceful degradation*: if the strong model keeps
 * failing, `pick()` falls back to the fast tier so the pipeline survives.
 */

import type { ChatMessage, TaskComplexity } from './types.js'

const DEFAULT_STRONG_KEYWORDS = [
  '架构',
  'architecture',
  '重构',
  'refactor',
  '审查',
  'review',
  '调试',
  'debug',
  '设计',
  'design',
  '理由',
  'reasoning',
  '回放',
  'trace',
  'explain',
]

export interface ModelRouterOptions {
  /** model id for the fast/cheap tier (default: atriadawn) */
  fast?: string
  /** model id for the strong/expensive tier (default: deepseek-v4.1) */
  strong?: string
  /** keywords that push a request to the strong tier */
  strongKeywords?: string[]
  /** total prompt chars above which we escalate to the strong tier */
  lengthThreshold?: number
  /** consecutive failures on the strong tier before falling back (default 2) */
  fallbackAfter?: number
}

export class ModelRouter {
  readonly fast: string
  readonly strong: string
  private readonly keywords: Set<string>
  private readonly lengthThreshold: number
  private readonly fallbackAfter: number
  private strongFailures = 0

  constructor(options: ModelRouterOptions = {}) {
    this.fast = options.fast ?? 'atriadawn'
    this.strong = options.strong ?? 'deepseek-v4.1'
    this.keywords = new Set(options.strongKeywords ?? DEFAULT_STRONG_KEYWORDS)
    this.lengthThreshold = options.lengthThreshold ?? 4000
    this.fallbackAfter = options.fallbackAfter ?? 2
  }

  /** Choose a model id for the upcoming request. */
  pick(messages: ChatMessage[], complexity: TaskComplexity = 'standard'): string {
    if (complexity === 'complex') return this.degraded() ? this.fast : this.strong
    if (complexity === 'trivial') return this.fast

    const text = messages.map((m) => m.content ?? '').join('\n')
    if (text.length > this.lengthThreshold) return this.degraded() ? this.fast : this.strong
    const lower = text.toLowerCase()
    for (const keyword of this.keywords) {
      if (lower.includes(keyword.toLowerCase())) {
        return this.degraded() ? this.fast : this.strong
      }
    }
    return this.fast
  }

  /** Tell the router a model attempt failed; may arm the fallback. */
  noteFailure(model: string): void {
    if (model === this.strong) this.strongFailures++
  }

  /** Tell the router a model attempt succeeded; resets degradation. */
  noteSuccess(model: string): void {
    if (model === this.strong) this.strongFailures = 0
  }

  degraded(): boolean {
    return this.strongFailures >= this.fallbackAfter
  }

  /** Snapshot for diagnostics / trace metadata. */
  stats(): { strongFailures: number; degraded: boolean } {
    return { strongFailures: this.strongFailures, degraded: this.degraded() }
  }
}
