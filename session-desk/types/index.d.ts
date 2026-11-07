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
      branchSel: string | null
      branchAct: { dismissed: string[]; confirm: string | null }
    }
  }
}
