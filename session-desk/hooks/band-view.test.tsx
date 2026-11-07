import { expect, test } from 'claude-code/testing'

import type { BandArgs } from './band-view'
import { BRANCH_COLOR, modelColor } from './band'
import { renderBand } from './band-view'
import { ESC, labelsOf, textsOf } from './test-kit'

// 注入する Box・Text・Button は名前の文字列。描かれた { type, props, children } の木を調べる。
const ui = { Box: 'Box', Text: 'Text', Button: 'Button' }
type Node = { type: string; props: Record<string, unknown>; children: unknown[] }

const BASE: BandArgs = {
  goal: null,
  run: { state: null, tool: null, elapsedMs: null },
  lastTurn: null,
  stop: null,
  agents: { running: 0, rows: [], open: false },
  model: null,
  context: null,
  breakdown: null,
  limits: [],
  git: null,
  steps: null,
  on: {
    toggleAgents() {},
    exact() {},
    toggleDetail() {},
    pick() {},
  },
}
const draw = (over: Partial<BandArgs> = {}) => renderBand(ui, { ...BASE, ...over }) as Node
const texts = (over: Partial<BandArgs> = {}) => textsOf(draw(over))
const labels = (over: Partial<BandArgs> = {}) => labelsOf(draw(over))

function find(node: any, pred: (n: Node) => boolean): Node[] {
  if (Array.isArray(node)) return node.flatMap(c => find(c, pred))
  if (typeof node !== 'object' || node === null) return []
  const out: Node[] = pred(node) ? [node] : []
  for (const c of node.children ?? []) out.push(...find(c, pred))
  return out
}
const colorOf = (tree: Node, text: string) => find(tree, n => n.type === 'Text' && n.children.flat().includes(text))[0]?.props?.color
const byKey = (tree: Node, key: string) => find(tree, n => n.props?.key === key)[0]

const CTX = (percent: number) => ({
  percent,
  tokens: 860_000,
  window: 1_000_000,
  parts: [
    { id: 'messages' as const, tokens: 600_000 },
    { id: 'mcp' as const, tokens: 260_000 },
  ],
})

test('goal shows when set and nothing when null', async () => {
  expect(texts({ goal: 'G' })).toContain('G')
  expect(texts({ goal: null }).join('')).not.toContain('ゴール')
})

test('running shows the tool and elapsed as separate texts', async () => {
  const t = texts({ run: { state: 'running', tool: 'Bash', elapsedMs: 42_000 } })
  expect(t).toContain('実行中 Bash')
  expect(t).toContain('0m42s')
})

test('stopped shows the last turn; stop reasons', async () => {
  const run = { state: 'stopped' as const, tool: null, elapsedMs: null }
  const t = texts({ run, lastTurn: { durationMs: 102_000, tokens: 18_000 } })
  expect(t).toContain('停止中')
  expect(t).toContain('直近 1m42s')
  expect(t).toContain('18k tokens')
  expect(texts({ run, stop: 'error' })).toContain('エラーで停止')
  expect(texts({ run, stop: 'refusal' })).toContain('拒否で停止')
  expect(texts({ run, stop: 'aborted' })).toContain('中断')
})

const ROWS = [
  { id: 'a', type: 'Explore', description: '調査', state: 'running' as const, elapsedMs: 5000 },
  { id: 'b', type: 'Plan', description: '設計', state: 'waiting' as const, elapsedMs: null },
]

test('agents: none shows nothing; open lists rows with colored marks; closed hides them', async () => {
  expect(texts().join('')).not.toContain('サブエージェント')
  const open = draw({ agents: { running: 2, rows: ROWS, open: true } })
  const t = textsOf(open)
  expect(t.join('|')).toContain('サブエージェント')
  expect(t).toContain('2')
  for (const w of ['Explore', '調査', 'Plan', '設計']) expect(t).toContain(w)
  expect(t).toContain('実行中')
  expect(t).toContain('待機')
  expect(colorOf(open, '●')).toBe('blue')
  expect(colorOf(open, '◌')).toBe('gray')
  // 完了は灰色の ○。経過時間は出さない（値が渡っても描かない）。
  const done = draw({ agents: { running: 1, rows: [ROWS[0], { ...ROWS[0], id: 'c', state: 'done', elapsedMs: 9000 }], open: true } })
  expect(textsOf(done)).toContain('完了')
  expect(colorOf(done, '○')).toBe('gray')
  expect(textsOf(done)).toContain('0m05s')
  expect(textsOf(done)).not.toContain('0m09s')
  expect(textsOf(open)).not.toContain('○')
  expect(labelsOf(open)).toContain('▴ 閉じる')
  const closed = draw({ agents: { running: 2, rows: ROWS, open: false } })
  expect(textsOf(closed)).not.toContain('Explore')
  expect(labelsOf(closed)).toContain('▾ 開く')
})

test('model, context percent colors and tokens; null context omits the line', async () => {
  expect(texts({ model: 'Opus 5.5' })).toContain('Opus 5.5')
  const c86 = draw({ context: CTX(86) })
  expect(textsOf(c86)).toContain('86%')
  expect(colorOf(c86, '86%')).toBe('warning')
  expect(textsOf(c86)).toContain('860k / 1M')
  expect(colorOf(draw({ context: CTX(79) }), '79%')).toBe('success')
  expect(colorOf(draw({ context: CTX(95) }), '95%')).toBe('error')
  expect(texts({ context: null }).join('')).not.toContain('コンテキスト')
  expect(JSON.stringify(c86)).toContain('▬')
})

test('limits, git, and omitted lines', async () => {
  const t = texts({ limits: [{ label: '5時間枠', percent: 32, remaining: '3h 10m' }, { label: '7日枠', percent: 10, remaining: null }] })
  for (const w of ['5時間枠', '32%', '3h 10m', '7日枠', '10%']) expect(t).toContain(w)
  expect(texts().join('')).not.toContain('枠')
  expect(texts({ git: null }).join('')).not.toContain('commit')
  expect(texts({ git: { branch: 'main', dirtyCount: 3 } })).toContain('未 commit 3')
  expect(texts({ git: { branch: 'main', dirtyCount: null } }).join('')).not.toContain('未 commit')
  expect(texts({ git: { branch: null, dirtyCount: null } })).toContain('(detached)')
})

const BREAKDOWN = (compact: number | null = 40_000) => ({
  exact: false,
  compactIn: compact,
  threshold: 900_000,
  rows: [
    { id: 'messages' as const, name: 'Messages', tokens: 600_000, detail: null, detailOpen: false },
    {
      id: 'mcp' as const,
      name: 'MCP tools',
      tokens: 260_000,
      detail: [{ name: 'playwright', tokens: 120_000 }],
      detailOpen: true,
    },
  ],
})

test('breakdown legend is always drawn: rows, 概算, exact button, details', async () => {
  const tree = draw({ breakdown: BREAKDOWN() })
  const t = textsOf(tree)
  expect(labelsOf(tree)).not.toContain('▸ 内訳')
  for (const w of ['Messages', '600k', 'MCP tools', 'playwright', '120k']) expect(t).toContain(w)
  expect(t.join('|')).toContain('概算')
  expect(labelsOf(tree)).toContain('正確に数える')
  expect(byKey(tree, 'band-exact')).toBeDefined()
  expect(byKey(tree, 'band-detail-mcp')).toBeDefined()
  expect(byKey(tree, 'band-detail-messages')).toBeUndefined()
  expect(t).toContain('自動 compact まで あと 40k（閾値 900k）')
  expect(textsOf(draw({ breakdown: { ...BREAKDOWN(), threshold: null } }))).toContain('自動 compact まで あと 40k')
  expect(textsOf(draw({ breakdown: BREAKDOWN(null) })).join('')).not.toContain('自動 compact まで')
  // 順序: バー、凡例、compact の行、概算
  const flat = JSON.stringify(draw({ context: CTX(86), breakdown: BREAKDOWN() }))
  const at = (w: string) => flat.indexOf(w)
  expect(at('▬')).toBeLessThan(at('Messages'))
  expect(at('MCP tools')).toBeLessThan(at('自動 compact まで'))
  expect(at('自動 compact まで')).toBeLessThan(at('概算'))
  expect(at('概算')).toBeLessThan(at('band-exact'))
})

test('an exact breakdown says 正確 instead of 概算, and the button stays', async () => {
  const exact = draw({ breakdown: { ...BREAKDOWN(), exact: true } })
  expect(textsOf(exact)).toContain('正確')
  expect(textsOf(exact)).not.toContain('概算')
  expect(labelsOf(exact)).toContain('正確に数える')
})

test('the context bar fills the width: columns - 2 cells (min 8), 24 when columns is unknown', async () => {
  const cells = (tree: Node) =>
    find(tree, n => n.type === 'Text' && typeof n.children[0] === 'string' && /^▬+$/.test(n.children[0] as string)).reduce(
      (sum, n) => sum + (n.children[0] as string).length,
      0,
    )
  expect(cells(draw({ context: CTX(86) }))).toBe(24)
  expect(cells(draw({ context: CTX(86), columns: 60 }))).toBe(58)
  expect(cells(draw({ context: CTX(86), columns: 6 }))).toBe(8)
})

test('the context numbers sit at the right end of the label row', async () => {
  const row = find(draw({ context: CTX(86) }), n => n.props?.justifyContent === 'space-between')[0]
  expect(row).toBeDefined()
  expect(textsOf(row)).toEqual(['コンテキスト', '86%', '860k / 1M'])
})

test('limits draw a bar each: filled by percent, green / yellow / red', async () => {
  const limits = [
    { label: '5時間枠', percent: 50, remaining: null },
    { label: '7日枠', percent: 85, remaining: null },
    { label: '日', percent: 96, remaining: null },
  ]
  const tree = draw({ limits })
  // バーは横長の四角（▬）。塗った分は色つき、空きは dimColor。
  const bars = find(tree, n => n.type === 'Text' && typeof n.children[0] === 'string' && /^▬+$/.test(n.children[0] as string))
  const fills = bars.filter(n => n.props.color !== undefined)
  expect(fills.map(n => (n.children[0] as string).length)).toEqual([6, 10, 12])
  expect(fills.map(n => n.props.color)).toEqual(['success', 'warning', 'error'])
  expect(bars.filter(n => n.props.dimColor === true && n.children[0] === '▬'.repeat(6))).toHaveLength(1)
  const narrow = draw({ limits: [limits[0]], columns: 30 })
  expect(find(narrow, n => n.type === 'Text' && n.children[0] === '▬'.repeat(3) && n.props.color !== undefined)).toHaveLength(1)
})

test('the branch name is bright cyan; the model is bold and coloured by family', async () => {
  expect(colorOf(draw({ git: { branch: 'main', dirtyCount: 0 } }), 'main')).toBe(BRANCH_COLOR)
  const model = (name: string) => find(draw({ model: name }), n => n.type === 'Text' && n.children[0] === name)[0]
  expect(model('Opus 5.5').props.color).toBe(modelColor('opus'))
  expect(model('Opus 5.5').props.bold).toBe(true)
  expect(model('Sonnet 5.5').props.color).toBe(modelColor('sonnet'))
  expect(model('x').props.color).toBe(BRANCH_COLOR)
})

test('the panel has no outer frame: it is headed Session + model; sections are split by thin rules, the suggestion by a double rule', async () => {
  const steps = { items: ['a', 'b'], reason: 'R', recommended: null }
  const tree = draw({ model: 'Opus 5.5', goal: 'G', context: CTX(50), git: { branch: 'main', dirtyCount: 0 }, steps, between: { type: 'Text', props: {}, children: ['TABS'] } as any })
  expect(find(tree, n => n.props?.borderStyle !== undefined)).toHaveLength(0)
  expect(textsOf(tree).slice(0, 2)).toEqual(['Session', 'Opus 5.5'])
  // 見出しと最初の段のあいだに線は無い（1 行あけるだけ）。段と段のあいだに細い線、提案の前に二重線。
  expect(textsOf(tree).filter(x => /^─+$/.test(x))).toHaveLength(3)
  expect(textsOf(tree).filter(x => /^═+$/.test(x))).toHaveLength(1)
  const flat = JSON.stringify(tree)
  expect(flat.indexOf('═')).toBeGreaterThan(flat.indexOf('TABS'))
  expect(flat.indexOf('提案')).toBeGreaterThan(flat.indexOf('═'))
  // 値のない段は出さない。コンテキストだけなら、線は無い。
  expect(textsOf(draw({ context: CTX(50) })).filter(x => /^─+$/.test(x))).toHaveLength(0)
  // 何もなければ、何も出ない。
  expect(textsOf(draw())).toEqual([])
})

test('every rule has one blank row above and below it', async () => {
  const steps = { items: ['a'], reason: 'R', recommended: null }
  const tree = draw({ model: 'Opus 5.5', goal: 'G', context: CTX(50), steps })
  const rules = find(tree, n => n.type === 'Box' && n.children.length === 1 && typeof (n.children[0] as Node).children?.[0] === 'string' && /^[─═]+$/.test((n.children[0] as Node).children[0] as string))
  expect(rules).toHaveLength(2)
  for (const r of rules) expect(r.props.marginY).toBe(1)
})

test('the legend is one blank row below the bar, and the compact line one blank row below the legend', async () => {
  const tree = draw({ context: CTX(50), breakdown: BREAKDOWN() })
  // 見出しの下の 1 行（段そのものの marginTop）は数えない。
  const gaps = find(tree, n => n.props?.marginTop === 1 && n.props?.key !== 'sec-context')
  expect(gaps).toHaveLength(2)
  expect(textsOf(gaps[0])).toContain('Messages')
  expect(textsOf(gaps[1])).toContain('概算')
})

test('detail closed hides the per-item rows', async () => {
  const b = BREAKDOWN()
  b.rows[1].detailOpen = false
  expect(textsOf(draw({ breakdown: b }))).not.toContain('playwright')
})

test('steps: framed list with numbers, (推奨) on the recommended row only, null shows nothing', async () => {
  const items = ['git status を見る', 'rm -rf x']
  const pick = draw({ steps: { items, reason: '理由R', recommended: 1 } })
  expect(labelsOf(pick)).toEqual(expect.arrayContaining(items))
  expect(byKey(pick, 'band-step-0')).toBeDefined()
  expect(textsOf(pick).join('|')).toContain('提案')
  expect(textsOf(pick).join('|')).toContain('理由R')
  // 番号と推奨の印は、ボタンの中の Text。
  const inside = find(pick, n => n.type === 'Text').flatMap(n => n.children.filter(c => typeof c === 'string') as string[])
  expect(inside).toEqual(expect.arrayContaining(['1  ', '2  ']))
  expect(inside.filter(x => x === ' (推奨)')).toHaveLength(1)
  const row = (i: number) => byKey(pick, `band-step-${i}`)
  expect(JSON.stringify(row(1))).toContain('(推奨)')
  expect(JSON.stringify(row(0))).not.toContain('(推奨)')
  // 2 回押す確認は無い。どの案も、押すと送る。
  expect(JSON.stringify(pick)).not.toContain('2 回押す')
  expect(JSON.stringify(pick)).not.toContain('本当に送りますか')
  expect(find(pick, n => n.props?.borderColor === 'error')).toHaveLength(0)
  expect(JSON.stringify(draw({ steps: { items, reason: '理由R', recommended: null } }))).not.toContain('(推奨)')
  expect(texts({ steps: null }).join('')).not.toContain('提案')
  expect(labels({ steps: null })).toEqual([])
})

test('ESC sequences and bidi marks are stripped from every drawn string', async () => {
  const bad = (s: string) => `[31m${s}[0m‮`
  const check = (tree: Node, expected: string[]) => {
    const all = [...textsOf(tree), ...labelsOf(tree)]
    const joined = all.join('')
    expect(joined).not.toContain('')
    expect(joined).not.toContain('‮')
    expect(JSON.stringify(tree)).not.toContain('\u001b')
    expect(JSON.stringify(tree)).not.toContain('\u202e')
    for (const w of expected) expect(all).toContain(w)
  }
  const base = {
    goal: bad('goal'),
    model: bad('model'),
    git: { branch: bad('branch'), dirtyCount: 1 },
    agents: { running: 1, rows: [{ ...ROWS[0], type: bad('atype'), description: bad('adesc') }], open: true },
    breakdown: {
      ...BREAKDOWN(),
      rows: [{ id: 'mcp' as const, name: bad('rowname'), tokens: 1000, detail: [{ name: bad('detailname'), tokens: 500 }], detailOpen: true }],
    },
  }
  check(draw({ ...base, steps: { items: [bad('s0'), bad('s1')], reason: bad('reason'), recommended: 0 } }), [
    'goal', 'model', 'branch', 'atype', 'adesc', 'rowname', 'detailname', 'reason', 's0', 's1',
  ])
})
