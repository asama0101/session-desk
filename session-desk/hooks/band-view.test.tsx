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
    toggleBreakdown() {},
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
  expect(colorOf(open, '●')).toBe('blue')
  expect(colorOf(open, '○')).toBe('gray')
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

const BREAKDOWN = (open: boolean, compact: number | null = 40_000) => ({
  open,
  compactIn: compact,
  threshold: 900_000,
  rows: [
    { id: 'messages' as const, name: 'Messages', tokens: 600_000, percent: 60, detail: null, detailOpen: false },
    {
      id: 'mcp' as const,
      name: 'MCP tools',
      tokens: 260_000,
      percent: 26,
      detail: [{ name: 'playwright', tokens: 120_000 }],
      detailOpen: true,
    },
  ],
})

test('breakdown closed hides rows; open shows rows, 概算, exact button, details', async () => {
  const closed = draw({ breakdown: BREAKDOWN(false) })
  expect(labelsOf(closed)).toContain('▸ 内訳')
  expect(textsOf(closed)).not.toContain('Messages')
  const open = draw({ breakdown: BREAKDOWN(true) })
  const t = textsOf(open)
  expect(labelsOf(open)).toContain('▾ 内訳')
  for (const w of ['Messages', '600k', '60%', 'MCP tools', 'playwright', '120k']) expect(t).toContain(w)
  expect(t.join('|')).toContain('概算')
  expect(labelsOf(open)).toContain('正確に数える')
  expect(byKey(open, 'band-exact')).toBeDefined()
  expect(byKey(open, 'band-detail-mcp')).toBeDefined()
  expect(byKey(open, 'band-detail-messages')).toBeUndefined()
  expect(t.join('|')).toContain('自動 compact まで')
  expect(textsOf(draw({ breakdown: BREAKDOWN(true, null) })).join('')).not.toContain('自動 compact まで')
})

test('detail closed hides the per-item rows', async () => {
  const b = BREAKDOWN(true)
  b.rows[1].detailOpen = false
  expect(textsOf(draw({ breakdown: b }))).not.toContain('playwright')
})

test('steps: choices, heading with reason, confirm view, null shows nothing', async () => {
  const items = ['git status を見る', 'rm -rf x']
  const pick = draw({ steps: { items, reason: '理由R', confirming: null } })
  expect(labelsOf(pick)).toEqual(expect.arrayContaining(items))
  expect(byKey(pick, 'band-step-0')).toBeDefined()
  expect(textsOf(pick).join('|')).toContain('提案')
  expect(textsOf(pick).join('|')).toContain('理由R')
  const conf = draw({ steps: { items, reason: '理由R', confirming: 1 } })
  expect(textsOf(conf)).toContain('本当に送りますか？')
  expect(textsOf(conf)).toContain('rm -rf x')
  expect(labelsOf(conf)).toContain('送る')
  expect(labelsOf(conf)).toContain('やめる')
  expect(byKey(conf, 'band-step-confirm-1')).toBeDefined()
  expect(byKey(conf, 'band-step-cancel')).toBeDefined()
  expect(byKey(conf, 'band-step-1')).toBeUndefined()
  expect(textsOf(conf).join('')).not.toContain('提案')
  expect(texts({ steps: null }).join('')).not.toContain('提案')
  expect(labels({ steps: null })).toEqual([])
})

test('ESC sequences in goal, steps and names are stripped from every drawn string', async () => {
  const dirty = (s: string) => `${ESC}[31m${s}${ESC}[0m`
  const tree = draw({
    goal: dirty('GOAL'),
    model: dirty('M'),
    git: { branch: dirty('br'), dirtyCount: 1 },
    agents: { running: 1, rows: [{ ...ROWS[0], type: dirty('T'), description: dirty('D') }], open: true },
    steps: { items: [dirty('S0'), dirty('S1')], reason: dirty('R'), confirming: null },
  })
  expect(JSON.stringify(tree)).not.toContain('\u001b')
  expect(labelsOf(tree)).toEqual(expect.arrayContaining(['S0', 'S1']))
  const conf = draw({ steps: { items: [dirty('S0')], reason: 'r', confirming: 0 } })
  expect(JSON.stringify(conf)).not.toContain('\u001b')
})
