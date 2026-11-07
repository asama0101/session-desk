// セッション帯の表示。受け取った値を描くだけで、`$` も git も呼ばない。
import { barCells, CATEGORY_COLORS, formatDuration, formatTokens, usageColor } from './band'
import type { AgentRow, CategoryId, LimitRow } from './band'
import { stripControl } from './lib'

type Ui = { Box: any; Text: any; Button: any }

export type BandArgs = {
  goal: string | null
  run: { state: 'running' | 'stopped' | null; tool: string | null; elapsedMs: number | null }
  lastTurn: { durationMs: number; tokens: number } | null
  stop: 'error' | 'refusal' | 'aborted' | null
  agents: { running: number; rows: AgentRow[]; open: boolean }
  model: string | null
  context: { percent: number; tokens: number; window: number; parts: { id: CategoryId; tokens: number }[] } | null
  breakdown: {
    open: boolean
    rows: { id: CategoryId; name: string; tokens: number; percent: number; detail: { name: string; tokens: number }[] | null; detailOpen: boolean }[]
    compactIn: number | null
    threshold: number | null
  } | null
  limits: LimitRow[]
  git: { branch: string | null; dirtyCount: number | null } | null
  steps: { items: string[]; reason: string; confirming: number | null } | null
  on: {
    toggleBreakdown(): void
    toggleAgents(): void
    exact(): void
    toggleDetail(id: CategoryId): void
    pick(i: number): void
    confirm(i: number): void
    cancel(): void
  }
  // 端末の幅（列）。狭いときはバーを短くする。
  columns?: number
}

const NARROW_COLUMNS = 40
const BAR_WIDTH = 16
const BAR_WIDTH_NARROW = 8

const STOP_TEXT = { error: 'エラーで停止', refusal: '拒否で停止', aborted: '中断' } as const
const AGENT_MARK = { running: { mark: '●', color: 'blue' }, waiting: { mark: '○', color: 'gray' }, done: { mark: '✓', color: 'success' } } as const

export function renderBand(ui: Ui, a: BandArgs) {
  const { Box, Text, Button } = ui
  const clean = stripControl
  const pct = (percent: number) => {
    const level = usageColor(percent)

    return level === 'normal' ? <Text>{`${percent}%`}</Text> : <Text color={level}>{`${percent}%`}</Text>
  }
  const barWidth = a.columns !== undefined && a.columns < NARROW_COLUMNS ? BAR_WIDTH_NARROW : BAR_WIDTH
  const bar = (parts: { id: CategoryId; tokens: number }[], percent: number) => (
    <Box>
      {barCells(parts, percent, barWidth).map((c, i) => (
        <Text key={`${c.id}-${i}`} color={CATEGORY_COLORS[c.id]}>
          {(c.id === 'free' ? '░' : '█').repeat(c.cells)}
        </Text>
      ))}
    </Box>
  )

  const runLine =
    a.run.state === 'running' ? (
      <Box gap={2} flexWrap="wrap">
        <Text color="suggestion">{a.run.tool === null ? '実行中' : clean(`実行中 ${a.run.tool}`)}</Text>
        {a.run.elapsedMs !== null && <Text>{formatDuration(a.run.elapsedMs)}</Text>}
      </Box>
    ) : a.run.state === 'stopped' ? (
      <Box gap={2} flexWrap="wrap">
        <Text dimColor>停止中</Text>
        {a.lastTurn !== null && <Text>{`直近 ${formatDuration(a.lastTurn.durationMs)}`}</Text>}
        {a.lastTurn !== null && <Text>{`${formatTokens(a.lastTurn.tokens)} tokens`}</Text>}
        {a.stop !== null && <Text color={a.stop === 'aborted' ? 'warning' : 'error'}>{STOP_TEXT[a.stop]}</Text>}
      </Box>
    ) : null

  const agents =
    a.agents.running > 0 ? (
      <Box flexDirection="column">
        <Box gap={2}>
          <Text bold>サブエージェント</Text>
          <Text>{String(a.agents.running)}</Text>
          <Button key="band-agents" plain label={a.agents.open ? '▴ 閉じる' : '▾ 開く'} onPress={() => a.on.toggleAgents()}>
            <Text dimColor>{a.agents.open ? '▴ 閉じる' : '▾ 開く'}</Text>
          </Button>
        </Box>
        {a.agents.open &&
          a.agents.rows.map(row => (
            <Box key={`agent-${row.id}`} gap={2} flexWrap="wrap">
              <Text color={AGENT_MARK[row.state].color}>{AGENT_MARK[row.state].mark}</Text>
              <Text>{clean(row.type)}</Text>
              <Text>{clean(row.description)}</Text>
              {row.elapsedMs !== null && <Text dimColor>{formatDuration(row.elapsedMs)}</Text>}
            </Box>
          ))}
      </Box>
    ) : null

  const ctx = a.context
  const contextLine = ctx !== null && (
    <Box gap={2} flexWrap="wrap">
      <Text dimColor>コンテキスト</Text>
      {bar(ctx.parts, ctx.percent)}
      {pct(ctx.percent)}
      <Text>{`${formatTokens(ctx.tokens)} / ${formatTokens(ctx.window)}`}</Text>
    </Box>
  )

  const bd = a.breakdown
  const breakdown = bd !== null && (
    <Box flexDirection="column">
      <Button key="band-breakdown" plain label={bd.open ? '▾ 内訳' : '▸ 内訳'} onPress={() => a.on.toggleBreakdown()}>
        <Text dimColor>{bd.open ? '▾ 内訳' : '▸ 内訳'}</Text>
      </Button>
      {bd.open && (
        <Box flexDirection="column">
          {bd.rows.map(row => (
            <Box key={`bd-${row.id}`} flexDirection="column">
              <Box gap={2} flexWrap="wrap">
                <Text color={CATEGORY_COLORS[row.id]}>■</Text>
                <Text>{clean(row.name)}</Text>
                <Text>{formatTokens(row.tokens)}</Text>
                <Text>{`${row.percent}%`}</Text>
                {row.detail !== null && (
                  <Button key={`band-detail-${row.id}`} plain label={row.detailOpen ? '▾ 1 件ずつ' : '▸ 1 件ずつ'} onPress={() => a.on.toggleDetail(row.id)}>
                    <Text dimColor>{row.detailOpen ? '▾ 1 件ずつ' : '▸ 1 件ずつ'}</Text>
                  </Button>
                )}
              </Box>
              {row.detail !== null &&
                row.detailOpen &&
                row.detail.map((d, i) => (
                  <Box key={`bd-${row.id}-${i}`} gap={2}>
                    <Text dimColor>{'  '}</Text>
                    <Text>{clean(d.name)}</Text>
                    <Text>{formatTokens(d.tokens)}</Text>
                  </Box>
                ))}
            </Box>
          ))}
          <Box gap={2} flexWrap="wrap">
            <Text dimColor>概算</Text>
            <Button key="band-exact" plain label="正確に数える" onPress={() => a.on.exact()}>
              <Text color="suggestion">正確に数える</Text>
            </Button>
          </Box>
          {bd.compactIn !== null && <Text dimColor>{`自動 compact まで ${formatTokens(bd.compactIn)}`}</Text>}
        </Box>
      )}
    </Box>
  )

  const limits =
    a.limits.length > 0 ? (
      <Box gap={3} flexWrap="wrap">
        {a.limits.map(l => (
          <Box key={`limit-${l.label}`} gap={1}>
            <Text dimColor>{l.label}</Text>
            {pct(l.percent)}
            {l.remaining !== null && <Text dimColor>{l.remaining}</Text>}
          </Box>
        ))}
      </Box>
    ) : null

  const git =
    a.git !== null ? (
      <Box gap={2} flexWrap="wrap">
        <Text color="suggestion">{a.git.branch === null ? '(detached)' : clean(a.git.branch)}</Text>
        {a.git.dirtyCount !== null && <Text>{`未 commit ${a.git.dirtyCount}`}</Text>}
      </Box>
    ) : null

  const st = a.steps
  const steps = st !== null && (
    <Box flexDirection="column">
      {st.confirming === null && (
        <Box gap={2} flexWrap="wrap">
          <Text bold>提案</Text>
          <Text>{clean(st.reason)}</Text>
        </Box>
      )}
      {st.items.map((item, i) => {
        const text = clean(item)

        return st.confirming === i ? (
          <Box key={`step-confirming-${i}`} gap={2} flexWrap="wrap">
            <Text color="error">本当に送りますか？</Text>
            <Text>{text}</Text>
            <Button key={`band-step-confirm-${i}`} plain label="送る" onPress={() => a.on.confirm(i)}>
              <Text color="success">送る</Text>
            </Button>
            <Button key="band-step-cancel" plain label="やめる" onPress={() => a.on.cancel()}>
              <Text>やめる</Text>
            </Button>
          </Box>
        ) : (
          <Button key={`band-step-${i}`} plain label={text} onPress={() => a.on.pick(i)}>
            <Text color="suggestion">{text}</Text>
          </Button>
        )
      })}
    </Box>
  )

  return (
    <Box flexDirection="column">
      {a.goal !== null && (
        <Box gap={2} flexWrap="wrap">
          <Text dimColor>ゴール</Text>
          <Text>{clean(a.goal)}</Text>
        </Box>
      )}
      {runLine}
      {agents}
      {a.model !== null && <Text>{clean(a.model)}</Text>}
      {contextLine}
      {breakdown}
      {limits}
      {git}
      {steps}
    </Box>
  )
}
