import { expect, test } from 'claude-code/testing'

import type { BandArgs } from './band-view'
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
    confirm() {},
    cancel() {},
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
  expect(colorOf(draw({ context: CTX(79) }), '79%')).toBeUndefined()
  expect(colorOf(draw({ context: CTX(95) }), '95%')).toBe('error')
  expect(texts({ context: null }).join('')).not.toContain('コンテキスト')
  expect(JSON.stringify(c86)).toContain('█')
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
  expect(at('█')).toBeLessThan(at('Messages'))
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

test('the context bar is 24 cells wide, 12 when columns < 40', async () => {
  const cells = (tree: Node) =>
    find(tree, n => n.type === 'Text' && typeof n.children[0] === 'string' && /^[█░]+$/.test(n.children[0] as string)).reduce(
      (sum, n) => sum + (n.children[0] as string).length,
      0,
    )
  expect(cells(draw({ context: CTX(86) }))).toBe(24)
  expect(cells(draw({ context: CTX(86), columns: 120 }))).toBe(24)
  expect(cells(draw({ context: CTX(86), columns: 30 }))).toBe(12)
})

test('the band sits in a round frame headed Session + model; sections are split by a rule', async () => {
  const tree = draw({ model: 'Opus 5.5', goal: 'G', context: CTX(50), git: { branch: 'main', dirtyCount: 0 } })
  const frame = find(tree, n => n.props?.borderStyle === 'round')[0]
  expect(frame).toBeDefined()
  expect(textsOf(frame).slice(0, 2)).toEqual(['Session', 'Opus 5.5'])
  expect(textsOf(tree).filter(x => /^┄+$/.test(x))).toHaveLength(2)
  // 値のある段だけを区切る。コンテキストだけなら線はない。
  expect(textsOf(draw({ context: CTX(50) })).filter(x => /^┄+$/.test(x))).toHaveLength(0)
})

test('detail closed hides the per-item rows', async () => {
  const b = BREAKDOWN()
  b.rows[1].detailOpen = false
  expect(textsOf(draw({ breakdown: b }))).not.toContain('playwright')
})

test('steps: framed list with numbers, risky rows marked, red confirm frame, null shows nothing', async () => {
  const items = ['git status を見る', 'rm -rf x']
  const pick = draw({ steps: { items, reason: '理由R', confirming: null } })
  expect(labelsOf(pick)).toEqual(expect.arrayContaining(items))
  expect(byKey(pick, 'band-step-0')).toBeDefined()
  const t = textsOf(pick)
  expect(t.join('|')).toContain('提案')
  expect(t.join('|')).toContain('理由R')
  // 番号と、危険な語を含む案だけの「2 回押す」は、ボタンの中の Text。
  const inside = find(pick, n => n.type === 'Text').flatMap(n => n.children.filter(c => typeof c === 'string') as string[])
  expect(inside).toEqual(expect.arrayContaining(['1  ', '2  ']))
  expect(inside.filter(x => x === '  ⚠ 2 回押す')).toHaveLength(1)
  expect(colorOf(pick, 'rm -rf x')).toBe('warning')
  expect(colorOf(pick, 'git status を見る')).toBe('suggestion')
  expect(find(pick, n => n.props?.borderColor === 'error')).toHaveLength(0)
  const conf = draw({ steps: { items, reason: '理由R', confirming: 1 } })
  expect(textsOf(conf)).toContain('本当に送りますか？')
  expect(textsOf(conf)).toContain('rm -rf x')
  expect(labelsOf(conf)).toContain('送る')
  expect(labelsOf(conf)).toContain('やめる')
  expect(byKey(conf, 'band-step-confirm-1')).toBeDefined()
  expect(byKey(conf, 'band-step-cancel')).toBeDefined()
  expect(byKey(conf, 'band-step-1')).toBeUndefined()
  expect(find(conf, n => n.props?.borderColor === 'error')).toHaveLength(1)
  expect(textsOf(conf).join('')).not.toContain('提案')
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
  check(draw({ ...base, steps: { items: [bad('s0'), bad('s1')], reason: bad('reason'), confirming: null } }), [
    'goal', 'model', 'branch', 'atype', 'adesc', 'rowname', 'detailname', 'reason', 's0', 's1',
  ])
  check(draw({ ...base, steps: { items: [bad('s0'), bad('s1')], reason: bad('reason'), confirming: 0 } }), ['s0', 'goal'])
})
