export type Tab = 'history' | 'quick'

declare module 'claude-code' {
  interface PluginState {
    'session-desk': {
      history: Shaped<string[]>
      quick: Shaped<string[]>
      tab: Tab
      selected: number | null
    }
  }
}
