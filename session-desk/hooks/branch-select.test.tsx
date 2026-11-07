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

const REFS_ALL =
  'refs/heads/docs/b\tB1\t2026-11-03T10:00:00+09:00\n' +
  'refs/heads/feat/a\tA1\t2026-11-05T11:40:00+09:00\n' +
  'refs/heads/main\tM1\t2026-11-01T09:00:00+09:00\n' +
  'refs/remotes/origin/docs/b\tB1\t2026-11-03T10:00:00+09:00\n' +
  'refs/remotes/origin/main\tM1\t2026-11-01T09:00:00+09:00\n'
const REFS_NO_DOCS =
  'refs/heads/feat/a\tA1\t2026-11-05T11:40:00+09:00\n' +
  'refs/heads/main\tM1\t2026-11-01T09:00:00+09:00\n' +
  'refs/remotes/origin/main\tM1\t2026-11-01T09:00:00+09:00\n'
const CREATED = '2026-11-05T09:00:00+09:00'

// refs を後から差し替えられるエンジン。reflog と log の答えも持つ。
function engine(on: any) {
  const calls: string[] = []
  const cfg = { refs: REFS_ALL, head: 'refs/heads/feat/a\n', listPrs: '[]', headPrs: '[]' }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'session-desk', isPlaced: true }] }))
  on('session.cwd', () => ({ value: 'D:/p' }))
  on('clock.every', () => ({ deny: 'test: no timers' }))
  on('clock.sleep', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv
    calls.push(argv.join(' '))
    const key = argv[0] === 'git' ? argv.slice(2).join(' ') : argv.join(' ')
    let stdout = ''
    let exitCode = 0
    if (key === 'rev-parse --git-dir') stdout = '.git\n'
    else if (key === 'symbolic-ref -q refs/remotes/origin/HEAD') stdout = 'refs/remotes/origin/main\n'
    else if (key === 'symbolic-ref -q HEAD') stdout = cfg.head
    else if (key.startsWith('for-each-ref --format=%(refname)%09%(objectname)')) stdout = cfg.refs
    else if (key.startsWith('for-each-ref --format=%(refname)%09%(ahead-behind:')) {
      stdout = 'refs/heads/docs/b\t3 0\nrefs/heads/feat/a\t2 0\nrefs/heads/main\t0 0\n'
    } else if (key.startsWith('rev-list --count')) stdout = '0\n'
    else if (key === 'reflog show --date=iso-strict --format=%gd%x09%gs refs/heads/feat/a') {
      stdout = `feat/a@{${CREATED}}\tbranch: Created from main\n`
    } else if (key.startsWith('rev-parse --verify refs/heads/')) {
      stdout = ({ 'docs/b': 'B1', 'feat/a': 'A1', main: 'M1' } as Record<string, string>)[key.slice('rev-parse --verify refs/heads/'.length)] + '\n'
    } else if (key.startsWith('gh pr list')) stdout = argv.includes('--head') ? cfg.headPrs : cfg.listPrs
    else if (key !== 'status --porcelain=v1 -z' && !key.startsWith('reflog') && !key.startsWith('log ')) exitCode = 1

    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { calls, cfg }
}

const start = ($: any) => $.session.start({ cwd: 'D:/p', surface: 'terminal', interactive: true })
async function open($: any, calls: string[]) {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-git' })
  await settle(calls)

  return ui
}
const texts = async (ui: any): Promise<string[]> => textsOf(await ui.drawn())
const offset = -new Date().getTimezoneOffset()

test('after a refresh the current branch shows its created date', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  const lines = await texts(ui)
  expect(lines).toContain('✓ ブランチを切る')
  expect(lines).toContain(formatAt(CREATED, offset))
  await ui.unmount()
})

test('choosing a row reads the dates of that branch only', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  const reflog = (name: string) => `git --no-optional-locks reflog show --date=iso-strict --format=%gd%x09%gs refs/heads/${name}`
  expect(e.calls).not.toContain(reflog('docs/b'))
  await ui.press({ key: 'branch-docs/b' })
  await settle(e.calls)
  expect(e.calls).toContain(reflog('docs/b'))
  expect(await texts(ui)).toContain('● PR  次: PR を作る')
  await ui.unmount()
})

test('when the chosen branch disappears, the screen goes back to the current branch', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  await ui.press({ key: 'branch-docs/b' })
  await settle(e.calls)
  expect(await texts(ui)).toContain('● PR  次: PR を作る')
  e.cfg.refs = REFS_NO_DOCS
  await $.tool.call({ tool: 'Bash', command: 'git branch -d docs/b' })
  await settle(e.calls)
  expect(await ui.find({ key: 'branch-docs/b' })).toBeUndefined()
  expect(await texts(ui)).toContain('● レビュー（PR 前）  次: レビュー')
  await ui.unmount()
})

const MERGED_DOCS_B = {
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
}

