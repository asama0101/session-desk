import { expect, test } from 'claude-code/testing'

import { formatAt } from './branch-view'
import { textsOf } from './test-kit'

const PANE = {
  plugin: 'session-desk',
  component: 'Pane',
  requestId: 'session-desk',
  props: {
    title: 'Session Desk',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const
const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 120 } } as const

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))
async function settle(calls: string[]) {
  let same = 0
  let last = -1
  while (same < 3) {
    await flush()
    same = calls.length === last ? same + 1 : 0
    last = calls.length
  }
}

const REFS =
  'refs/heads/docs/b\tB1\t2026-11-03T10:00:00+09:00\n' +
  'refs/heads/feat/a\tA1\t2026-11-05T11:40:00+09:00\n' +
  'refs/heads/main\tM1\t2026-11-01T09:00:00+09:00\n' +
  'refs/remotes/origin/docs/b\tB1\t2026-11-03T10:00:00+09:00\n' +
  'refs/remotes/origin/main\tM1\t2026-11-01T09:00:00+09:00\n'
const AHEAD = 'refs/heads/docs/b\t3 0\nrefs/heads/feat/a\t2 0\nrefs/heads/main\t0 0\n'
const PRS = JSON.stringify([
  {
    number: 7,
    state: 'MERGED',
    isDraft: false,
    reviewDecision: '',
    createdAt: '2026-11-03T00:00:00Z',
    mergedAt: '2026-11-03T01:00:00Z',
    headRefName: 'docs/b',
    headRefOid: 'B1',
    isCrossRepository: false,
    latestReviews: [],
  },
])

const REMOTE_V = 'origin\thttps://github.com/a/b.git (fetch)\norigin\thttps://github.com/a/b.git (push)\n'

type Over = {
  refs?: string
  head?: object
  repo?: object
  gh?: object
  hang?: boolean
  remote?: object
  diff?: string
}

function engine(on: any, over: Over = {}) {
  const calls: string[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'session-desk', isPlaced: true }] }))
  on('session.cwd', () => ({ value: 'D:/p' }))
  on('clock.every', () => ({ deny: 'test: no timers' }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv
    calls.push(argv.join(' '))
    if (over.hang) {
      return new Promise(() => {})
    }
    const key = argv[0] === 'git' ? argv.slice(2).join(' ') : argv.join(' ')
    let result: { exitCode: number; stdout: string; stderr?: string } = { exitCode: 0, stdout: '' }
    if (key === 'rev-parse --git-dir') result = { exitCode: 0, stdout: '.git\n', ...over.repo }
    else if (key === 'symbolic-ref -q refs/remotes/origin/HEAD') result = { exitCode: 0, stdout: 'refs/remotes/origin/main\n' }
    else if (key === 'symbolic-ref -q HEAD') result = { exitCode: 0, stdout: 'refs/heads/feat/a\n', ...over.head }
    else if (key.startsWith('for-each-ref --format=%(refname)%09%(objectname)')) result = { exitCode: 0, stdout: over.refs ?? REFS }
    else if (key.startsWith('for-each-ref --format=%(refname)%09%(ahead-behind:')) result = { exitCode: 0, stdout: AHEAD }
    else if (key === 'remote -v') result = { exitCode: 0, stdout: REMOTE_V, ...over.remote }
    else if (key.startsWith('rev-list --left-right --count')) result = { exitCode: 0, stdout: over.diff ?? '0\t0\n' }
    else if (key.startsWith('rev-list --count')) result = { exitCode: 0, stdout: '0\n' }
    else if (key.startsWith('gh pr list')) result = { exitCode: 0, stdout: PRS, ...over.gh }
    else if (key !== 'status --porcelain=v1 -z') result = { exitCode: 1, stdout: '' }

    return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...result } }
  })
  on('tool.call', () => ({ result: {} }))

  return { calls }
}

const start = ($: any) => $.session.start({ cwd: 'D:/p', surface: 'terminal', interactive: true })
async function open($: any, calls: string[], pane: object = PANE) {
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'tab-branch' })
  await settle(calls)

  return ui
}
const texts = async (ui: any): Promise<string[]> => textsOf(await ui.drawn())
const jsonOf = async (ui: any, key: string) => JSON.stringify(await ui.find({ key }))

test('formatAt shows MM/DD HH:mm in the given offset, and a dash for a bad date', async () => {
  expect(formatAt('2026-11-05T02:40:00Z', 540)).toBe('11/05 11:40')
  expect(formatAt('2026-11-05T11:40:00+09:00', 540)).toBe('11/05 11:40')
  expect(formatAt('2026-11-05T11:40:00+09:00', 0)).toBe('11/05 02:40')
  expect(formatAt('not a date', 540)).toBe('—')
})

test('the heading counts the branches; each row shows the mark, kind, name and now', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  expect(await texts(ui)).toContain('ブランチ 3')
  expect(await jsonOf(ui, 'branch-feat/a')).toContain('"label":"＊feat feat/a  次: push"')
  expect(await jsonOf(ui, 'branch-docs/b')).toContain('"label":"　docs docs/b  次: ブランチを削除"')
  expect(await jsonOf(ui, 'branch-main')).toContain('"label":"　既定 main  既定"')
  await ui.unmount()
})

test('the current branch is selected first; its stages show symbols, dates, the count and the next step', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  const lines = await texts(ui)
  expect(lines).toContain('✓ ブランチを切る  —')
  expect(lines.some(l => l.startsWith('✓ commit  ') && l.endsWith('  2 件'))).toBe(true)
  expect(lines).toContain('● push  次: push')
  expect(lines).toContain('○ PR')
  await ui.unmount()
})

test('pressing another row shows that branch; the default branch has no stages', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  await ui.press({ key: 'branch-docs/b' })
  await flush()
  expect(await texts(ui)).toContain('● 削除  次: ブランチを削除')
  await ui.press({ key: 'branch-main' })
  await flush()
  expect(await texts(ui)).toContain('経過はありません（既定ブランチ）')
  await ui.unmount()
})

test('under 100 columns the list sits above the stages; from 100 they sit side by side', async ($, on) => {
  const e = engine(on)
  await start($)
  const narrow = await open($, e.calls)
  expect(await narrow.find({ key: 'branch-narrow' })).toBeDefined()
  expect(await narrow.find({ key: 'branch-wide' })).toBeUndefined()
  expect(await jsonOf(narrow, 'branch-narrow')).toContain('"flexDirection":"column"')
  await narrow.unmount()
  const wide = await open($, e.calls, WIDE)
  expect(await wide.find({ key: 'branch-wide' })).toBeDefined()
  expect(await jsonOf(wide, 'branch-wide')).toContain('"flexDirection":"row"')
  await wide.unmount()
})

test('the last line shows when git and gh were read', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  expect((await texts(ui)).some(l => /^git \d\d:\d\d:\d\d \/ gh \d\d:\d\d:\d\d$/.test(l))).toBe(true)
  await ui.unmount()
})

test('the last line shows gh 不明 when gh failed', async ($, on) => {
  const e = engine(on, { gh: { exitCode: 1 } })
  await start($)
  const ui = await open($, e.calls)
  expect((await texts(ui)).some(l => /^git \d\d:\d\d:\d\d \/ gh 不明$/.test(l))).toBe(true)
  await ui.unmount()
})

test('a detached HEAD is warned about on the screen', async ($, on) => {
  const e = engine(on, { head: { exitCode: 1, stdout: '' } })
  await start($)
  const ui = await open($, e.calls)
  expect(await texts(ui)).toContain('HEAD は分離状態')
  await ui.unmount()
})

test('a folder that is not a repository says so', async ($, on) => {
  const e = engine(on, { repo: { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } })
  await start($)
  const ui = await open($, e.calls)
  expect(await texts(ui)).toContain('Git のリポジトリではありません')
  await ui.unmount()
})

test('until the first read finishes the tab reads 読み込み中', async ($, on) => {
  const e = engine(on, { hang: true })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-branch' })
  await flush()
  expect(await texts(ui)).toContain('読み込み中')
  expect(e.calls.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('control characters in a branch name never reach the screen', async ($, on) => {
  const refs = 'refs/heads/feat/\u001b[31mx\tX1\t2026-11-05T11:40:00+09:00\nrefs/heads/main\tM1\t2026-11-01T09:00:00+09:00\n'
  const e = engine(on, { refs, head: { exitCode: 1, stdout: '' } })
  await start($)
  const ui = await open($, e.calls)
  expect(JSON.stringify(await ui.drawn())).not.toContain('\u001b')
  expect(await jsonOf(ui, 'branch-feat/x')).toContain('feat feat/x')
  await ui.unmount()
})

test('the remotes are listed under the heading with tidy URLs', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  expect(await texts(ui)).toContain('origin  github.com/a/b')
  await ui.unmount()
})

test('several remotes are all listed, and credentials in a URL never reach the screen', async ($, on) => {
  const remote = {
    stdout:
      'origin\thttps://user:ghp_SECRET@github.com/a/b.git (fetch)\norigin\thttps://user:ghp_SECRET@github.com/a/b.git (push)\n' +
      'upstream\tgit@github.com:c/d.git (fetch)\nupstream\tgit@github.com:c/d.git (push)\n',
  }
  const e = engine(on, { remote })
  await start($)
  const ui = await open($, e.calls)
  const lines = await texts(ui)
  expect(lines).toContain('origin  github.com/a/b')
  expect(lines).toContain('upstream  github.com/c/d')
  expect(JSON.stringify(await ui.drawn())).not.toContain('SECRET')
  await ui.unmount()
})

test('with no remote the screen says リモートなし, push onwards is 対象外 and gh is not applicable', async ($, on) => {
  const e = engine(on, { remote: { stdout: '' } })
  await start($)
  const ui = await open($, e.calls)
  const lines = await texts(ui)
  expect(lines).toContain('リモートなし')
  expect(lines).toContain('－ push')
  expect(lines.some(l => /^git \d\d:\d\d:\d\d \/ gh 対象外$/.test(l))).toBe(true)
  expect(await jsonOf(ui, 'branch-feat/a')).toContain('commit 済み（リモートなし）')
  await ui.unmount()
})

test('with only a remote other than origin the screen lists it and adds an origin なし line', async ($, on) => {
  const e = engine(on, { remote: { stdout: 'upstream\tgit@github.com:c/d.git (fetch)\nupstream\tgit@github.com:c/d.git (push)\n' } })
  await start($)
  const ui = await open($, e.calls)
  const lines = await texts(ui)
  expect(lines).toContain('upstream  github.com/c/d')
  expect(lines).toContain('origin なし')
  await ui.unmount()
})

test('when the remotes cannot be read the screen says リモート: 不明', async ($, on) => {
  const e = engine(on, { remote: { exitCode: 128, stdout: '' } })
  await start($)
  const ui = await open($, e.calls)
  expect(await texts(ui)).toContain('リモート: 不明')
  await ui.unmount()
})

test('a row shows the difference from origin as ↑ahead ↓behind, only when there is one', async ($, on) => {
  const refs = REFS + 'refs/remotes/origin/feat/a\tA0\t2026-11-05T10:00:00+09:00\n'
  const e = engine(on, { refs, diff: '1\t2\n' })
  await start($)
  const ui = await open($, e.calls)
  expect(await jsonOf(ui, 'branch-feat/a')).toContain('"label":"＊feat feat/a  ↑2 ↓1  次: push"')
  expect(await jsonOf(ui, 'branch-docs/b')).toContain('"label":"　docs docs/b  次: ブランチを削除"')
  await ui.unmount()
})

test('the default branch row shows its difference from origin too', async ($, on) => {
  const refs = REFS.replace('refs/remotes/origin/main\tM1', 'refs/remotes/origin/main\tM0')
  const e = engine(on, { refs, diff: '2\t0\n' })
  await start($)
  const ui = await open($, e.calls)
  expect(await jsonOf(ui, 'branch-main')).toContain('"label":"　既定 main  ↓2  既定"')
  await ui.unmount()
})
