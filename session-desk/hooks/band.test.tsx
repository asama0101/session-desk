import { expect, test } from 'claude-code/testing'

import {
  barCells,
  classifyCategory,
  compactIn,
  formatDuration,
  formatRemaining,
  formatTokens,
  limitRows,
  usageColor,
} from './band'

test('usageColor: 80 is warning, 95 is error', async () => {
  expect(usageColor(79)).toBe('normal')
  expect(usageColor(80)).toBe('warning')
  expect(usageColor(94)).toBe('warning')
  expect(usageColor(95)).toBe('error')
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
