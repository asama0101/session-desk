import { expect, test } from 'claude-code/testing'

import {
  addTool,
  barCells,
  BRANCH_COLOR,
  classifyCategory,
  compactIn,
  formatDuration,
  formatRemaining,
  formatTokens,
  limitRows,
  modelColor,
  prettyModel,
  ICONS,
  ICON_CELLS,
  fitTail,
  EFFORT_COLORS,
  parseForkReply,
  removeTool,
  startTurn,
  toolLabel,
  usageColor,
} from './band'
import { stripControl } from './lib'

test('usageColor: 60 is warning, 80 is error', async () => {
  expect(usageColor(59)).toBe('normal')
  expect(usageColor(60)).toBe('warning')
  expect(usageColor(79)).toBe('warning')
  expect(usageColor(80)).toBe('error')
  expect(usageColor(100)).toBe('error')
})

test('formatDuration and formatTokens', async () => {
  expect(formatDuration(42_000)).toBe('0m42s')
  expect(formatDuration(102_000)).toBe('1m42s')
  expect(formatDuration(3_660_000)).toBe('1h01m')
  expect(formatTokens(999)).toBe('999')
  expect(formatTokens(18_000)).toBe('18k')
  expect(formatTokens(860_000)).toBe('860k')
  expect(formatTokens(1_200_000)).toBe('1.2M')
})

test('formatRemaining: m, h m, d h; past or invalid is null', async () => {
  const now = Date.parse('2026-11-07T00:00:00Z')
  const at = (ms: number) => new Date(now + ms).toISOString()
  const m = 60_000
  expect(formatRemaining(at(45 * m), now)).toBe('45m')
  expect(formatRemaining(at(190 * m), now)).toBe('3h 10m')
  expect(formatRemaining(at((2 * 24 + 3) * 60 * m), now)).toBe('2d 3h')
  expect(formatRemaining(at(-m), now)).toBe(null)
  expect(formatRemaining('not a date', now)).toBe(null)
})

test('barCells: min 1 cell each, total equals width, rest is free', async () => {
  const parts = [
    { id: 'messages' as const, tokens: 800_000 },
    { id: 'mcp' as const, tokens: 28_000 },
    { id: 'systemTools' as const, tokens: 16_000 },
    { id: 'systemPrompt' as const, tokens: 8_000 },
    { id: 'memory' as const, tokens: 5_000 },
    { id: 'skills' as const, tokens: 4_000 },
  ]
  const cells = barCells(parts, 58, 16)
  const free = cells.find((c) => c.id === 'free')!.cells
  const used = cells.filter((c) => c.id !== 'free')
  expect(free).toBe(7)
  expect(used.reduce((a, c) => a + c.cells, 0)).toBe(9)
  expect(used.every((c) => c.cells >= 1)).toBe(true)
  expect(cells.reduce((a, c) => a + c.cells, 0)).toBe(16)

  const zero = barCells([{ id: 'messages', tokens: 0 }, { id: 'mcp', tokens: 10 }], 50, 10)
  expect(zero.find((c) => c.id === 'messages')?.cells ?? 0).toBe(0)
  expect(zero.reduce((a, c) => a + c.cells, 0)).toBe(10)

  const none = barCells(parts, 0, 16)
  expect(none.filter((c) => c.cells > 0)).toEqual([{ id: 'free', cells: 16 }])
})

test('barCells: never paints more cells than the usage, even with many small parts', async () => {
  const parts = [
    { id: 'messages' as const, tokens: 3_000 },
    { id: 'mcp' as const, tokens: 28_000 },
    { id: 'systemTools' as const, tokens: 16_000 },
    { id: 'systemPrompt' as const, tokens: 8_000 },
    { id: 'memory' as const, tokens: 5_000 },
    { id: 'skills' as const, tokens: 4_000 },
  ]
  // 5% of 40 = 2 cells: the two largest parts only.
  const low = barCells(parts, 5, 40)
  expect(low.filter((c) => c.id !== 'free')).toEqual([
    { id: 'mcp', cells: 1 },
    { id: 'systemTools', cells: 1 },
  ])
  expect(low.reduce((a, c) => a + c.cells, 0)).toBe(40)

  // Rounding up several small parts must not push the bar past the usage.
  const rounded = barCells([{ id: 'messages', tokens: 50_757 }, { id: 'mcp', tokens: 85_008 }, { id: 'memory', tokens: 4_773 }, { id: 'skills', tokens: 46 }, { id: 'systemTools', tokens: 82_551 }, { id: 'systemPrompt', tokens: 29_456 }], 53, 15)
  expect(rounded.filter((c) => c.id !== 'free').reduce((a, c) => a + c.cells, 0)).toBe(8)
})

test('classifyCategory follows kind and the exact names', async () => {
  expect(classifyCategory({ name: 'Free space', kind: 'free' })).toBe('free')
  expect(classifyCategory({ name: 'Autocompact buffer', kind: 'buffer' })).toBe('other')
  expect(classifyCategory({ name: 'Skills', kind: 'deferred' })).toBe('other')
  expect(classifyCategory({ name: 'Custom agents', kind: 'used' })).toBe('other')
  expect(classifyCategory({ name: 'Messages', kind: 'used' })).toBe('messages')
  expect(classifyCategory({ name: 'MCP tools', kind: 'used' })).toBe('mcp')
  expect(classifyCategory({ name: 'System tools', kind: 'used' })).toBe('systemTools')
  expect(classifyCategory({ name: 'System prompt', kind: 'used' })).toBe('systemPrompt')
  expect(classifyCategory({ name: 'Memory files', kind: 'used' })).toBe('memory')
  expect(classifyCategory({ name: 'Skills', kind: 'used' })).toBe('skills')
})

test('compactIn: tokens left before the threshold', async () => {
  expect(compactIn(860_000, 900_000, true)).toBe(40_000)
  expect(compactIn(860_000, 900_000, false)).toBe(null)
  expect(compactIn(860_000, undefined, true)).toBe(null)
  expect(compactIn(950_000, 900_000, true)).toBe(0)
})

test('limitRows keeps only five_hour and seven_day', async () => {
  const now = Date.parse('2026-11-07T00:00:00Z')
  expect(limitRows([], now)).toEqual([])
  const rows = limitRows(
    [
      { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(now + 45 * 60_000).toISOString() },
      { kind: 'spend_limit', percentUsed: 5 },
      { kind: 'seven_day', percentUsed: 10 },
    ],
    now,
  )
  expect(rows).toEqual([
    { label: '5時間枠', percent: 30, remaining: '45m' },
    { label: '7日枠', percent: 10, remaining: null },
  ])
})

// ---- fork の返答の解析・実行状態・サブエージェント ----

test('parseForkReply: reads a plain JSON reply', async () => {
  expect(parseForkReply('{"goal":"A","reason":"R","steps":["x","y"]}', null)).toEqual({ goal: 'A', reason: 'R', steps: ['x', 'y'], recommended: null })
})

test('parseForkReply: recommended points at one step, counted in the steps that are kept', async () => {
  expect(parseForkReply('{"goal":"A","steps":["x","y"],"recommended":1}', null).recommended).toBe(1)
  // 長すぎて捨てた案があっても、残した案の番号に直す。
  const long = 'あ'.repeat(41)
  expect(parseForkReply(JSON.stringify({ goal: 'A', steps: [long, 'x', 'y'], recommended: 2 }), null)).toMatchObject({ steps: ['x', 'y'], recommended: 1 })
  // 捨てた案を指すとき、範囲外、数でないとき、null のときは、推奨なし。
  for (const recommended of [0, 5, -1, 1.5, '1', null, undefined]) {
    expect(parseForkReply(JSON.stringify({ goal: 'A', steps: [long, 'x'], recommended }), null).recommended).toBe(null)
  }
})

test('parseForkReply: takes JSON from the first { to the last }', async () => {
  const r = parseForkReply('ok {"goal":"A","steps":[]} end', null)
  expect(r.goal).toBe('A')
  expect(r.steps).toEqual([])
})

test('parseForkReply: broken JSON or a non-string goal falls back to prevGoal', async () => {
  const want = { goal: '前', reason: '判断待ち', steps: [], recommended: null }
  expect(parseForkReply('{"goal":', '前')).toEqual(want)
  expect(parseForkReply('no json', '前')).toEqual(want)
  expect(parseForkReply('{"goal":5,"steps":["x"]}', '前')).toEqual(want)
})

test('parseForkReply: length limits are exact, over-long values are dropped not cut', async () => {
  const s40 = 'あ'.repeat(40)
  const s41 = 'あ'.repeat(41)
  const ok = parseForkReply(JSON.stringify({ goal: s40, reason: 'r'.repeat(30), steps: [s40, s41] }), null)
  expect(ok).toEqual({ goal: s40, reason: 'r'.repeat(30), steps: [s40], recommended: null })
  expect(parseForkReply(JSON.stringify({ goal: 'A', reason: 'r'.repeat(31), steps: [] }), null).reason).toBe('判断待ち')
  const long = parseForkReply(JSON.stringify({ goal: s41, steps: ['x'] }), '前')
  expect(long.goal).toBe('前')
  expect(long.steps).toEqual(['x'])
})

test('parseForkReply: keeps at most 4 steps', async () => {
  expect(parseForkReply('{"goal":"A","steps":["1","2","3","4","5"]}', null).steps).toEqual(['1', '2', '3', '4'])
})

test('parseForkReply: strips control codes and folds newlines in steps', async () => {
  const r = parseForkReply(JSON.stringify({ goal: 'A', steps: ['\u001b[31mx\u001b[0m', 'a\u202eb', 'a\nb'] }), null)
  expect(r.steps).toEqual(['x', 'ab', 'a b'])
})

test('modelColor: by family name, any case; the default is the branch colour', async () => {
  const colors = ['opus', 'sonnet', 'haiku', 'fable'].map(k => modelColor(`Claude ${k.toUpperCase()} 5`))
  expect(new Set(colors).size).toBe(4)
  expect(modelColor('Opus 5.5')).toBe(modelColor('claude-opus-5-5'))
  expect(modelColor('something else')).toBe(BRANCH_COLOR)
})

test('RunState: toolLabel shows the oldest tool and the extra count', async () => {
  let s = startTurn(1000)
  expect(s.startedAt).toBe(1000)
  expect(toolLabel(s)).toBe(null)
  s = addTool(addTool(s, 1, 'Bash'), 2, 'Edit')
  expect(toolLabel(s)).toBe('Bash +1')
  s = removeTool(s, 1)
  expect(toolLabel(s)).toBe('Edit')
  expect(toolLabel(removeTool(s, 2))).toBe(null)
})

test('stripControl: removes BOM, line/paragraph separators, soft hyphen and ALM', async () => {
  expect(stripControl('a\ufeffb\u2028c\u2029d\u00ade\u061cf')).toBe('abcdef')
})

test('fitTail keeps the tail of a long path, counting full-width characters as 2 cells, and starts it with …', async () => {
  expect(fitTail('D:/p', 20)).toBe('D:/p')
  expect(fitTail('D:/claude/local-repo/session-desk', 40)).toBe('D:/claude/local-repo/session-desk')
  const cut = fitTail('D:/claude/local-repo/session-desk', 20)
  expect(cut.startsWith('…')).toBe(true)
  expect(cut.endsWith('session-desk')).toBe(true)
  expect([...cut].length).toBeLessThanOrEqual(20)
  // 全角は 2 桁。10 桁なら、全角は 4 文字までと … 
  const jp = fitTail('D:/資料/設計書/第一版', 10)
  expect(jp.startsWith('…')).toBe(true)
  expect(jp.endsWith('第一版')).toBe(true)
  const cells = [...jp].reduce((sum, ch) => sum + ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0)
  expect(cells).toBeLessThanOrEqual(10)
})

test('EFFORT_COLORS: low grey, medium plain, high cyan, xhigh and max purple', async () => {
  expect(EFFORT_COLORS.medium).toBe(null)
  expect(EFFORT_COLORS.high).toBe(BRANCH_COLOR)
  expect(EFFORT_COLORS.low).not.toBe(EFFORT_COLORS.high)
  expect(EFFORT_COLORS.xhigh).toBe(EFFORT_COLORS.max)
})

test('ICONS: every icon is one emoji that terminals draw 2 cells wide (no text-or-emoji characters), all different', async () => {
  const icons = Object.values(ICONS)
  expect(new Set(icons).size).toBe(icons.length)
  for (const icon of icons) {
    expect([...icon]).toHaveLength(1)
    // 絵文字の面（U+1F000 以上）か、絵文字が標準の U+23F3 と U+26A1。U+FE0F を後ろに付けないと絵文字にならない文字は使わない。
    const point = icon.codePointAt(0) as number
    expect(point >= 0x1f000 || point === 0x23f3 || point === 0x26a1).toBe(true)
  }
  expect(ICON_CELLS).toBe(3)
})

test('prettyModel turns a model id into the name people read; unknown forms stay as they are', async () => {
  expect(prettyModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
  expect(prettyModel('claude-fable-5-1')).toBe('Fable 5.1')
  expect(prettyModel('claude-haiku-5-5')).toBe('Haiku 5.5')
  expect(prettyModel('claude-opus-4-1-20250805')).toBe('Opus 4.1')
  expect(prettyModel('claude-3-5-sonnet-20241022')).toBe('Sonnet 3.5')
  expect(prettyModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5 (1M)')
  expect(prettyModel('claude-sonnet-5')).toBe('Sonnet 5')
  expect(prettyModel('Opus 5.5')).toBe('Opus 5.5')
  expect(prettyModel('gpt-x')).toBe('gpt-x')
  expect(prettyModel('')).toBe('')
})
