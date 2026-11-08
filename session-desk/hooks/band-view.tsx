// セッション帯の表示。受け取った値を描くだけで、`$` も git も呼ばない。
import { barCells, BRANCH_COLOR, CATEGORY_COLORS, EFFORT_COLORS, fitTail, ICON_CELLS, ICONS, formatDuration, formatTokens, modelColor, prettyModel, usageColor } from './band'
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
  // 今のモデルの effort（low・medium・high・xhigh・max など）。読めなければ null。
  effort: string | null
  // セッションのディレクトリ。読めなければ null。
  cwd: string | null
  context: { percent: number; tokens: number | null; window: number | null; parts: { id: CategoryId; tokens: number }[] } | null
  breakdown: {
    // 「正確に数える」の結果を出しているとき真（「概算」の代わりに「正確」と出す）。
    exact: boolean
    // 色分けの凡例（■ の行）を隠しているとき真。
    legendHidden: boolean
    rows: { id: CategoryId; name: string; tokens: number; detail: { name: string; tokens: number }[] | null; detailOpen: boolean }[]
    compactIn: number | null
    threshold: number | null
  } | null
  limits: LimitRow[]
  git: { branch: string | null; dirtyCount: number | null } | null
  steps: { items: string[]; reason: string; recommended: number | null } | null
  on: {
    toggleAgents(): void
    exact(): void
    toggleLegend(): void
    toggleDetail(id: CategoryId): void
    pick(i: number): void
  }
  // 帯の下に置くもの（タブの行とタブの内容）。外枠の中の、帯と提案のあいだに入る。
  between?: any
  // 端末の幅（列）。狭いときはバーを短くする。
  columns?: number
}

const NARROW_COLUMNS = 40
// columns が分からないときのバーの幅。分かるときは、枠の中の幅（枠線と余白の 4 列を除く）いっぱいに伸ばす。
const BAR_WIDTH = 24
const BAR_WIDTH_MIN = 8
const LIMIT_BAR_WIDTH = 12
const LIMIT_BAR_WIDTH_NARROW = 6
// 枠の中の区切り線の既定の長さ（columns が分からないとき）。
const RULE_WIDTH = 36
// 外枠と区切り線の色。
const LINE_COLOR = '#6b7080'

const STOP_TEXT = { error: 'エラーで停止', refusal: '拒否で停止', aborted: '中断' } as const
const AGENT_MARK = {
  running: { mark: '●', color: 'blue', word: '実行中' },
  waiting: { mark: '◌', color: 'gray', word: '待機' },
  done: { mark: '○', color: 'gray', word: '完了' },
} as const

export function renderBand(ui: Ui, a: BandArgs) {
  const { Box, Text, Button } = ui
  const clean = stripControl
  const pct = (percent: number, bold = false) => {
    const level = usageColor(percent)

    return (
      <Text bold={bold} color={level === 'normal' ? 'success' : level}>
        {`${percent}%`}
      </Text>
    )
  }
  const narrow = a.columns !== undefined && a.columns < NARROW_COLUMNS
  const barWidth = a.columns === undefined ? BAR_WIDTH : Math.max(BAR_WIDTH_MIN, a.columns - 2)
  // コンテキストのバーは、全角の塗りつぶし（█）で描く。行いっぱいの高さで、上下の真ん中に揃う（▄ のように下へ寄らない）。利用枠のバーは、行の半分ほどの横長の四角（▬）。細すぎず、行の半分ほどの太さ（空きは暗い色）。
  // 利用枠のバー: 使用率の分だけ塗る。60% 未満は緑、60% 以上で黄、80% 以上で赤（usageColor と同じ）。
  const limitBar = (percent: number, width: number) => {
    const filled = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
    const level = usageColor(percent)

    return (
      <Box>
        <Text color={level === 'normal' ? 'success' : level}>{'▬'.repeat(filled)}</Text>
        <Text dimColor>{'▬'.repeat(width - filled)}</Text>
      </Box>
    )
  }
  const bar = (parts: { id: CategoryId; tokens: number }[], percent: number, width: number) => (
    <Box>
      {barCells(parts, percent, width).map((c, i) => (
        <Text key={`${c.id}-${i}`} color={CATEGORY_COLORS[c.id]}>
          {'█'.repeat(c.cells)}
        </Text>
      ))}
    </Box>
  )

  const runLine =
    a.run.state === 'running' ? (
      <Box gap={2} flexWrap="wrap">
        <Text color="suggestion">{a.run.tool === null ? `${ICONS.running} 実行中` : clean(`${ICONS.running} 実行中 ${a.run.tool}`)}</Text>
        {a.run.elapsedMs !== null && <Text>{formatDuration(a.run.elapsedMs)}</Text>}
      </Box>
    ) : a.run.state === 'stopped' ? (
      <Box gap={2} flexWrap="wrap">
        <Text dimColor>{`${ICONS.stopped} 停止中`}</Text>
        {a.lastTurn !== null && <Text>{`直近 ${formatDuration(a.lastTurn.durationMs)}`}</Text>}
        {a.lastTurn !== null && a.lastTurn.tokens > 0 && <Text>{`${formatTokens(a.lastTurn.tokens)} tokens`}</Text>}
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
              <Text>{AGENT_MARK[row.state].word}</Text>
              <Text>{clean(row.description)}</Text>
              {row.state !== 'done' && row.elapsedMs !== null && <Text dimColor>{formatDuration(row.elapsedMs)}</Text>}
            </Box>
          ))}
      </Box>
    ) : null

  const ctx = a.context
  const bd = a.breakdown
  const contextBlock =
    ctx === null && bd === null ? null : (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Box gap={2}>
            <Text dimColor>{`${ICONS.context} コンテキスト`}</Text>
            {bd !== null && (
              <Button key="band-legend" plain label={bd.legendHidden ? '凡例を出す' : '凡例を隠す'} onPress={() => a.on.toggleLegend()}>
                <Text dimColor>{bd.legendHidden ? '▸ 凡例' : '▾ 凡例'}</Text>
              </Button>
            )}
          </Box>
          {ctx !== null && (
            <Box gap={2}>
              {pct(ctx.percent, true)}
              {ctx.tokens !== null && ctx.window !== null && ctx.tokens > 0 && ctx.window > 0 && (
                <Text color={usageColor(ctx.percent) === 'normal' ? 'success' : usageColor(ctx.percent)}>{`${formatTokens(ctx.tokens)} / ${formatTokens(ctx.window)}`}</Text>
              )}
            </Box>
          )}
        </Box>
        {ctx !== null && bar(ctx.parts, ctx.percent, barWidth)}
        {bd !== null && (
          <Box flexDirection="column" marginTop={1}>
            {!bd.legendHidden && <Box flexDirection="column">
              {bd.rows.map(row => (
                <Box key={`bd-${row.id}`} gap={1}>
                  <Text color={CATEGORY_COLORS[row.id]}>■</Text>
                  <Text>{clean(row.name)}</Text>
                  <Text>{formatTokens(row.tokens)}</Text>
                  {row.detail !== null && (
                    <Button key={`band-detail-${row.id}`} plain label={row.detailOpen ? '▾ 1 件ずつ' : '▸ 1 件ずつ'} onPress={() => a.on.toggleDetail(row.id)}>
                      <Text dimColor>{row.detailOpen ? '▾ 1 件ずつ' : '▸ 1 件ずつ'}</Text>
                    </Button>
                  )}
                </Box>
              ))}
            </Box>}
            {!bd.legendHidden && bd.rows.map(
              row =>
                row.detail !== null &&
                row.detailOpen &&
                row.detail.map((d, i) => (
                  <Box key={`bd-${row.id}-${i}`} gap={2}>
                    <Text color={CATEGORY_COLORS[row.id]}>{'  ■'}</Text>
                    <Text>{clean(d.name)}</Text>
                    <Text>{formatTokens(d.tokens)}</Text>
                  </Box>
                )),
            )}
            <Box gap={2} flexWrap="wrap" marginTop={bd.legendHidden ? 0 : 1}>
              {bd.compactIn !== null && (
                <Text dimColor>
                  {bd.threshold === null
                    ? `自動 compact まで あと ${formatTokens(bd.compactIn)}`
                    : `自動 compact まで あと ${formatTokens(bd.compactIn)}（閾値 ${formatTokens(bd.threshold)}）`}
                </Text>
              )}
              <Text dimColor>{bd.exact ? '正確' : '概算'}</Text>
              <Button key="band-exact" plain label="正確に数える" onPress={() => a.on.exact()}>
                <Text color="suggestion">正確に数える</Text>
              </Button>
            </Box>
          </Box>
        )}
      </Box>
    )

  const limits =
    a.limits.length > 0 ? (
      <Box gap={3} flexWrap="wrap">
        {a.limits.map(l => (
          <Box key={`limit-${l.label}`} gap={1}>
            <Text dimColor>{`${l.label === '5時間枠' ? ICONS.fiveHour : ICONS.sevenDay} ${l.label}`}</Text>
            {limitBar(l.percent, narrow ? LIMIT_BAR_WIDTH_NARROW : LIMIT_BAR_WIDTH)}
            {pct(l.percent)}
            {l.remaining !== null && <Text dimColor>{l.remaining}</Text>}
          </Box>
        ))}
      </Box>
    ) : null

  const git =
    a.git !== null ? (
      <Box gap={2} flexWrap="wrap">
        <Text color={BRANCH_COLOR}>{`${ICONS.branch} ${a.git.branch === null ? '(detached)' : clean(a.git.branch)}`}</Text>
        {a.git.dirtyCount !== null && <Text>{`未 commit ${a.git.dirtyCount}`}</Text>}
      </Box>
    ) : null

  const st = a.steps
  const steps =
    st === null ? null : (
      <Box flexDirection="column">
        <Box gap={2} flexWrap="wrap">
          <Text bold>{`${ICONS.suggest} 提案`}</Text>
          <Text>{clean(st.reason)}</Text>
        </Box>
        {st.items.map((item, i) => {
          const text = clean(item)
          const best = st.recommended === i

          return (
            <Button key={`band-step-${i}`} plain label={text} onPress={() => a.on.pick(i)}>
              <Text dimColor>{`${i + 1}  `}</Text>
              <Text bold={best} color="suggestion">
                {text}
              </Text>
              {best && (
                <Text bold color="success">
                  {' (推奨)'}
                </Text>
              )}
            </Button>
          )
        })}
      </Box>
    )

  // 外枠は無い。パネルは、状態・コンテキスト・利用枠とブランチ・タブ（と内容）・提案を、細い線で区切って並べる。提案の前だけ二重線。
  const width = Math.max(8, (a.columns ?? RULE_WIDTH + 2) - 2)
  const thin = <Text color={LINE_COLOR}>{'─'.repeat(width)}</Text>
  const double = <Text color={LINE_COLOR}>{'═'.repeat(width)}</Text>
  const top = a.goal !== null || runLine !== null || agents !== null
  const foot = limits !== null || git !== null
  const sections: [string, boolean, any][] = [
    [
      'top',
      top,
      <Box flexDirection="column">
        {a.goal !== null && (
          <Box gap={2} flexWrap="wrap">
            <Text dimColor>{`${ICONS.goal} ゴール`}</Text>
            <Text>{clean(a.goal)}</Text>
          </Box>
        )}
        {runLine}
        {agents}
      </Box>,
    ],
    ['context', contextBlock !== null, contextBlock],
    [
      'foot',
      foot,
      <Box flexDirection="column">
        {limits}
        {git}
      </Box>,
    ],
    ['between', a.between !== undefined, a.between],
  ]
  const shown = sections.filter(([, on]) => on)
  const hasHead = a.model !== null || shown.some(([key]) => key !== 'between')
  const drawn = hasHead || a.between !== undefined || steps !== null

  return (
    <Box flexDirection="column">
      {drawn && (
        <Box flexDirection="column" paddingX={1}>
          {hasHead && (
            <Box gap={2}>
              <Text bold>Session</Text>
              {a.model !== null && (
                <Box gap={1}>
                  <Text>{ICONS.model}</Text>
                  <Text bold color={modelColor(a.model)}>
                    {clean(prettyModel(a.model))}
                  </Text>
                  {a.effort !== null && <Text dimColor>/</Text>}
                  {a.effort !== null && (
                    <Text bold={a.effort.toLowerCase() === 'max'} color={EFFORT_COLORS[a.effort.toLowerCase()] ?? undefined}>
                      {clean(a.effort)}
                    </Text>
                  )}
                </Box>
              )}
            </Box>
          )}
          {hasHead && a.cwd !== null && <Text dimColor>{`${ICONS.dir} ${clean(fitTail(a.cwd, Math.max(8, (a.columns ?? RULE_WIDTH + 2) - 2 - ICON_CELLS)))}`}</Text>}
          {shown.map(([key, , node], n) => (
            <Box key={`sec-${key}`} flexDirection="column">
              {n > 0 && key !== 'foot' && <Box marginY={1}>{thin}</Box>}
              {n > 0 && key === 'foot' && <Box marginTop={1} />}
              {node}
            </Box>
          ))}
          {steps !== null && (
            <Box flexDirection="column">
              {(shown.length > 0 || hasHead) && <Box marginY={1}>{double}</Box>}
              {steps}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
