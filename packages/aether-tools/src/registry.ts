/**
 * Tool registry: a typed catalogue the agent layer plans against.
 *
 * The registry is deliberately distrustful — a tool that was never
 * registered can never be executed by name, which is the single choke
 * point an LLM's tool-call output passes through before reaching the
 * sandbox.
 */

import { isTool, validateArgs } from './types.js'
import type { Tool } from './types.js'
import { ToolValidationError } from './sandbox.js'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool<any, any>>()

  register<A, O>(tool: Tool<A, O>): this {
    if (!isTool(tool)) throw new TypeError(`not a Tool: ${String(tool)}`)
    if (this.tools.has(tool.name)) {
      throw new Error(`tool "${tool.name}" is already registered`)
    }
    this.tools.set(tool.name, tool)
    return this
  }

  registerAll(tools: Array<Tool<any, any>>): this {
    for (const t of tools) this.register(t)
    return this
  }

  get(name: string): Tool<any, any> | undefined {
    return this.tools.get(name)
  }

  /** `get` + arg validation, ready to hand to `runTool`. */
  resolve(name: string, args: Record<string, unknown>): Tool<any, any> {
    const tool = this.tools.get(name)
    if (!tool) throw new ToolValidationError(name, [`unknown tool "${name}"`])
    const problems = validateArgs(args, tool.inputSchema)
    if (problems.length > 0) throw new ToolValidationError(name, problems)
    return tool
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** names, sorted — the catalogue shown to the model */
  list(): string[] {
    return [...this.tools.keys()].sort()
  }

  /** JSON catalogue for prompts: name + description + input schema */
  describe(): Array<{ name: string; description: string; inputSchema: unknown }> {
    return this.list().map((name) => {
      const t = this.tools.get(name)!
      return { name, description: t.description, inputSchema: t.inputSchema }
    })
  }

  get size(): number {
    return this.tools.size
  }
}
