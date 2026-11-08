export type Tab = 'history' | 'quick' | 'git'

declare module 'claude-code' {
  interface PluginState {
    'session-desk': {
      history: Shaped<string[]>
      quick: Shaped<string[]>
      tab: Tab
      selected: number | null
      // 形は hooks/git.ts の Snapshot。契約は自己完結（import 不可）でなければならないので unknown とし、使う側で型を付ける。
      snapshot: unknown
      bandGit: { branch: string | null; dirtyCount: number | null } | null
      band: {
        run: { startedAt: number | null; tools: { id: number; name: string }[] }
        state: 'running' | 'stopped' | null
        lastTurn: { durationMs: number; tokens: number } | null
        stop: 'error' | 'refusal' | 'aborted' | null
        goal: string | null
        reason: string
        steps: string[]
        recommended: number | null
        turnId: string | null
      }
      usageView: {
        model: string | null
        effort: string | null
        cwd: string | null
        context: { percent: number; tokens: number | null; window: number | null } | null
        rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
        breakdown: {
          categories: { name: string; kind: string; tokens: number }[]
          rawMaxTokens: number
          autoCompactThreshold?: number
          isAutoCompactEnabled: boolean
          mcpTools: { name: string; tokens: number }[]
          memoryFiles: { name: string; tokens: number }[]
          skills: { name: string; tokens: number }[]
        } | null
        exactHeld: boolean
      }
      bandUi: { exact: boolean; detail: string[] }
      more: { quick: boolean; history: boolean; git: boolean }
      releaseSkip: string[]
      branchSel: string | null
    }
  }
}
