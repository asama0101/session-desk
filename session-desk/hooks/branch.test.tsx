import { expect, test } from 'claude-code/testing'

import {
  adoptPr,
  buildRow,
  parseRemotes,
  tidyUrl,
  computeStages,
  defaultBranchOf,
  isDirty,
  kindOf,
  lastLineOf,
  nowOf,
  parseAhead,
  parseCreatedAt,
  parseNewestReflogDate,
  parsePrList,
  parseRefs,
} from './branch'
import type { Facts, Pr } from './branch'

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

// 段階の判定。素: 切ったばかり。F0: ahead 2 で push 済み、PR なし。
const BARE: Facts = {
  dirty: false,
  ahead: 0,
  pushed: false,
  createdAt: null,
  firstCommitAt: null,
  lastCommitAt: null,
  pushedAt: null,
  pr: null,
  prKnown: true,
  hasRemote: true,
  originDiff: null,
}
const F0: Facts = { ...BARE, ahead: 2, pushed: true }
const pr = (over: Partial<Pr>): Pr => ({
  number: 1,
  state: 'OPEN',
  isDraft: false,
  reviewDecision: '',
  createdAt: '2026-11-05T12:00:00+09:00',
  mergedAt: null,
  headRefName: 'feat/x',
  headRefOid: 'abc',
  isCrossRepository: false,
  latestReviews: [],
  ...over,
})
// d: done, t: todo, u: unknown, s: skipped
const LETTER = { done: 'd', todo: 't', unknown: 'u', skipped: 's' } as const
const letters = (f: Facts) => computeStages(f).map(s => LETTER[s.status]).join('')

const CASES: readonly (readonly [string, Facts, string, number | null, string])[] = [
  ['1 fresh branch', BARE, 'dttttttt', 2, '次: 編集'],
  ['2 uncommitted changes', { ...BARE, dirty: true }, 'ddtttttt', 3, '編集中'],
  ['3 committed, not pushed', { ...BARE, ahead: 2 }, 'dddttttt', 4, '次: push'],
  ['4 pushed, no PR', F0, 'ddddtttt', 5, '次: PR を作る'],
  ['5 open PR, no review setting', { ...F0, pr: pr({}) }, 'dddddstt', 7, 'マージ待ち'],
  ['6 open PR, approved', { ...F0, pr: pr({ reviewDecision: 'APPROVED' }) }, 'ddddddtt', 7, 'マージ待ち'],
  ['7 open PR, review required', { ...F0, pr: pr({ reviewDecision: 'REVIEW_REQUIRED' }) }, 'dddddttt', 6, '次: レビューを待つ'],
  ['8 open PR, changes requested', { ...F0, pr: pr({ reviewDecision: 'CHANGES_REQUESTED' }) }, 'dddddttt', 6, '次: 指摘を直す'],
  ['9 draft PR', { ...F0, pr: pr({ isDraft: true }) }, 'dddddttt', 6, '次: 草稿を解除する'],
  ['10 merged PR', { ...F0, pr: pr({ state: 'MERGED' }) }, 'dddddddt', 8, '次: ブランチを削除'],
  ['11 merged PR with uncommitted changes', { ...F0, dirty: true, pr: pr({ state: 'MERGED' }) }, 'ddtddddt', 3, '編集中'],
  ['12 closed PR', { ...F0, pr: pr({ state: 'CLOSED' }) }, 'ddddtttt', 5, '次: PR を作り直す'],
  ['13 pushed, edited again, open PR', { ...F0, dirty: true, pr: pr({}) }, 'ddtddstt', 3, '編集中'],
  ['14 gh unavailable', { ...F0, prKnown: false }, 'dddduuuu', null, '今: PR 以降は不明'],
  ['15 base unknown', { ...F0, ahead: null }, 'duuutttt', null, '今: 判定できない'],
  ['16 push unknown', { ...F0, pushed: null }, 'dddutttt', 5, '次: PR を作る'],
  ['17 merged, base unknown', { ...F0, ahead: null, pr: pr({ state: 'MERGED' }) }, 'dddddddt', 8, '次: ブランチを削除'],
  ['18 status failed', { ...F0, dirty: null }, 'duudtttt', null, '今: 判定できない'],
  ['19 base unknown and gh unavailable', { ...F0, ahead: null, prKnown: false }, 'duuuuuuu', null, '今: 判定できない'],
  ['20 merged, push unknown', { ...F0, ahead: 0, pushed: null, pr: pr({ state: 'MERGED' }) }, 'dddddddt', 8, '次: ブランチを削除'],
]

for (const [name, facts, expected, nowId, nowText] of CASES) {
  test(`stages case ${name}`, async () => {
    const stages = computeStages(facts)
    expect(stages.length).toBe(8)
    expect(stages.map(s => s.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(letters(facts)).toBe(expected)
    expect(nowOf(stages, facts)).toEqual({ id: nowId, text: nowText })
  })
}

test('stage labels follow git-flow', async () => {
  expect(computeStages(BARE).map(s => s.label)).toEqual([
    'ブランチを切る',
    '編集',
    'commit',
    'push',
    'PR',
    'レビュー',
    'マージ',
    '削除',
  ])
})

test('dates come from the facts and the PR; only done stages carry one; a missing push date stays null', async () => {
  const facts: Facts = {
    ...F0,
    createdAt: '2026-11-05T09:00:00+09:00',
    firstCommitAt: '2026-11-05T10:00:00+09:00',
    lastCommitAt: '2026-11-05T11:00:00+09:00',
    pushedAt: null,
    pr: pr({
      state: 'MERGED',
      createdAt: '2026-11-05T12:00:00+09:00',
      mergedAt: '2026-11-05T14:00:00+09:00',
      latestReviews: [
        { submittedAt: '2026-11-05T12:30:00+09:00' },
        { submittedAt: '2026-11-05T13:30:00+09:00' },
        { submittedAt: '2026-11-05T13:00:00+09:00' },
      ],
    }),
  }
  expect(computeStages(facts).map(s => s.at)).toEqual([
    '2026-11-05T09:00:00+09:00',
    '2026-11-05T10:00:00+09:00',
    '2026-11-05T11:00:00+09:00',
    null,
    '2026-11-05T12:00:00+09:00',
    '2026-11-05T13:30:00+09:00',
    '2026-11-05T14:00:00+09:00',
    null,
  ])
  const open = computeStages({ ...F0, lastCommitAt: 'x', pr: pr({}) })
  expect(open[6]?.at).toBe(null)
})

test('the commit stage notes the commit count only when done and ahead is 1 or more', async () => {
  expect(computeStages({ ...BARE, ahead: 2 })[2]?.note).toBe('2 件')
  expect(computeStages({ ...F0, ahead: 0, pr: pr({ state: 'MERGED' }) })[2]?.note).toBe(null)
  expect(computeStages(BARE)[2]?.note).toBe(null)
})

test('buildRow builds stages and now; a default branch has no stages and reads 既定', async () => {
  const row = buildRow('feat/x', 'feat', true, F0)
  expect(row.name).toBe('feat/x')
  expect(row.isCurrent).toBe(true)
  expect(row.stages.length).toBe(8)
  expect(row.now).toEqual({ id: 5, text: '次: PR を作る' })
  const main = buildRow('main', 'default', false, F0)
  expect(main.stages).toEqual([])
  expect(main.now).toEqual({ id: null, text: '既定' })
})

test('parsePrList returns null for non-JSON and an array for JSON', async () => {
  expect(parsePrList('not json')).toBe(null)
  expect(parsePrList('[]')).toEqual([])
  expect(parsePrList('{"a":1}')).toBe(null)
})

test('adoptPr does not adopt an old merged PR that is unrelated to the local tip (a re-cut branch)', async () => {
  const old = pr({ state: 'MERGED', mergedAt: '2026-10-01T00:00:00+09:00' })
  expect(adoptPr([old], () => 'other')).toEqual({ pr: null, known: true })
})

test('adoptPr prefers an open PR; among several open PRs the newest wins', async () => {
  const merged = pr({ number: 1, state: 'MERGED' })
  const openOld = pr({ number: 2, createdAt: '2026-11-01T00:00:00+09:00' })
  const openNew = pr({ number: 3, createdAt: '2026-11-03T00:00:00+09:00' })
  expect(adoptPr([merged, openOld], () => 'ancestor').pr?.number).toBe(2)
  expect(adoptPr([openOld, openNew, merged], () => 'ancestor').pr?.number).toBe(3)
})

test('adoptPr picks the newest of several merged PRs that match the local tip', async () => {
  const a = pr({ number: 1, state: 'MERGED', createdAt: '2026-11-01T00:00:00+09:00' })
  const b = pr({ number: 2, state: 'MERGED', createdAt: '2026-11-02T00:00:00+09:00' })
  expect(adoptPr([a, b], () => 'ancestor').pr?.number).toBe(2)
  expect(adoptPr([a, b], p => (p.number === 1 ? 'same' : 'other')).pr?.number).toBe(1)
})

test('adoptPr ignores PRs from forks', async () => {
  expect(adoptPr([pr({ isCrossRepository: true })], () => 'same')).toEqual({ pr: null, known: true })
})

test('adoptPr reports unknown when a merged PR cannot be related and nothing else can be adopted', async () => {
  expect(adoptPr([pr({ state: 'MERGED' })], () => 'unknown')).toEqual({ pr: null, known: false })
  // 採れるものがあれば、不明な PR があっても known。
  const open = pr({ number: 5 })
  expect(adoptPr([pr({ state: 'MERGED' }), open], p => (p.number === 5 ? 'same' : 'unknown')).known).toBe(true)
})

// リモートがないとき: push 以降は対象外（skipped）。
const NO_REMOTE_CASES: readonly (readonly [string, Facts, string, number | null, string])[] = [
  ['fresh branch', { ...BARE, hasRemote: false }, 'dttsssss', 2, '次: 編集'],
  ['uncommitted changes', { ...BARE, hasRemote: false, dirty: true }, 'ddtsssss', 3, '編集中'],
  ['committed', { ...BARE, hasRemote: false, ahead: 2 }, 'dddsssss', null, 'commit 済み（リモートなし）'],
  ['committed and edited again', { ...BARE, hasRemote: false, ahead: 2, dirty: true }, 'ddtsssss', 3, '編集中'],
  ['base unknown', { ...BARE, hasRemote: false, ahead: null }, 'duuussss', null, '今: 判定できない'],
]

for (const [name, facts, expected, nowId, nowText] of NO_REMOTE_CASES) {
  test(`stages without a remote: ${name}`, async () => {
    const stages = computeStages(facts)
    expect(letters(facts)).toBe(expected)
    expect(nowOf(stages, facts)).toEqual({ id: nowId, text: nowText })
  })
}

test('tidyUrl drops the scheme, the .git suffix and any user:token@, and turns scp-style into host/path', async () => {
  expect(tidyUrl('https://github.com/asama0101/session-desk.git')).toBe('github.com/asama0101/session-desk')
  expect(tidyUrl('https://user:ghp_SECRET@github.com/a/b.git')).toBe('github.com/a/b')
  expect(tidyUrl('https://ghp_SECRET@github.com/a/b')).toBe('github.com/a/b')
  expect(tidyUrl('git@github.com:a/b.git')).toBe('github.com/a/b')
  expect(tidyUrl('ssh://git@example.com:2222/a/b.git')).toBe('example.com:2222/a/b')
  expect(tidyUrl('C:/repos/x.git')).toBe('C:/repos/x')
  expect(tidyUrl('/srv/git/x')).toBe('/srv/git/x')
})

test('parseRemotes reads fetch lines of git remote -v, keeps order, tolerates CRLF and never shows credentials', async () => {
  const out =
    'origin\thttps://user:ghp_SECRET@github.com/a/b.git (fetch)\r\n' +
    'origin\thttps://user:ghp_SECRET@github.com/a/b.git (push)\r\n' +
    'upstream\tgit@github.com:c/d.git (fetch)\r\n' +
    'upstream\tgit@github.com:c/d.git (push)\r\n'
  expect(parseRemotes(out)).toEqual([
    { name: 'origin', url: 'github.com/a/b' },
    { name: 'upstream', url: 'github.com/c/d' },
  ])
  expect(JSON.stringify(parseRemotes(out))).not.toContain('SECRET')
  expect(parseRemotes('')).toEqual([])
})
