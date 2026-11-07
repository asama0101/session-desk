import { expect, test } from 'claude-code/testing'

import {
  defaultBranchOf,
  isDirty,
  kindOf,
  lastLineOf,
  parseAhead,
  parseCreatedAt,
  parseNewestReflogDate,
  parseRefs,
} from './branch'

test('kindOf maps the branch-name prefix to a kind; the default branch wins; everything else is other', async () => {
  expect(kindOf('feat/x', 'main')).toBe('feat')
  expect(kindOf('fix/x', 'main')).toBe('fix')
  expect(kindOf('docs/x', 'main')).toBe('docs')
  expect(kindOf('chore/x', 'main')).toBe('chore')
  expect(kindOf('refactor/x', 'main')).toBe('other')
  expect(kindOf('develop', 'main')).toBe('other')
  expect(kindOf('feat', 'main')).toBe('other')
  expect(kindOf('日本語/名前', 'main')).toBe('other')
  expect(kindOf('main', 'main')).toBe('default')
})

test('parseRefs reads tab-separated rows, tolerates CRLF, and drops blank lines and origin/HEAD', async () => {
  const out =
    'refs/heads/日本語/ブランチ\tabc123\t2026-11-05T10:20:00+09:00\r\n' +
    'refs/remotes/origin/HEAD\tfff\t2026-11-01T00:00:00+09:00\r\n' +
    'refs/remotes/origin/main\tfff\t2026-11-01T00:00:00+09:00\r\n\r\n'
  const rows = parseRefs(out)
  expect(rows.length).toBe(2)
  expect(rows[0]).toEqual({ ref: 'refs/heads/日本語/ブランチ', oid: 'abc123', date: '2026-11-05T10:20:00+09:00' })
  expect(rows[1]?.ref).toBe('refs/remotes/origin/main')
})

test('parseAhead maps each ref to its ahead count', async () => {
  const map = parseAhead('refs/heads/a\t2 0\r\nrefs/heads/b\t0 3\r\n')
  expect(map.get('refs/heads/a')).toBe(2)
  expect(map.get('refs/heads/b')).toBe(0)
  expect(map.size).toBe(2)
})

test('isDirty is true for any porcelain output, untracked included', async () => {
  expect(isDirty('')).toBe(false)
  expect(isDirty('?? docs/superpowers/\0')).toBe(true)
})

test('defaultBranchOf trims the symbolic ref and falls back to main, then master', async () => {
  expect(defaultBranchOf('refs/remotes/origin/main\r\n', [])).toBe('main')
  expect(defaultBranchOf(null, ['master', 'x'])).toBe('master')
  expect(defaultBranchOf(null, ['main', 'master'])).toBe('main')
  expect(defaultBranchOf(null, ['x'])).toBe(null)
})

test('parseCreatedAt takes the date of the oldest "branch: Created" reflog line', async () => {
  const out =
    'x@{2026-11-05T10:02:00+09:00}\tcommit: a\n' + 'x@{2026-11-05T09:00:00+09:00}\tbranch: Created from main\n'
  expect(parseCreatedAt(out)).toBe('2026-11-05T09:00:00+09:00')
  expect(parseCreatedAt('')).toBe(null)
  expect(parseCreatedAt('x@{2026-11-05T10:02:00+09:00}\tcommit: a\n')).toBe(null)
})

test('parseNewestReflogDate reads the date inside @{...}; lastLineOf returns the last non-empty line', async () => {
  expect(parseNewestReflogDate('origin/x@{2026-11-05T11:41:00+09:00}\n')).toBe('2026-11-05T11:41:00+09:00')
  expect(parseNewestReflogDate('')).toBe(null)
  expect(lastLineOf('a\nb\r\n\n')).toBe('b')
  expect(lastLineOf('')).toBe(null)
})
