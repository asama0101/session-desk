import { expect, test } from 'claude-code/testing'

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
// process.run の呼び出しが 3 回続けて増えなくなるまで待つ（更新は何度も await する）。
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
  'refs/heads/main\tM1\t2026-11-01T09:00:00+09:00\nrefs/remotes/origin/main\tM1\t2026-11-01T09:00:00+09:00\n'

function reply(argv: string[]) {
  const key = argv[0] === 'git' ? argv.slice(2).join(' ') : argv.join(' ')
  let stdout = ''
  let exitCode = 0
  if (key === 'rev-parse --git-dir') stdout = '.git\n'
  else if (key === 'symbolic-ref -q refs/remotes/origin/HEAD') stdout = 'refs/remotes/origin/main\n'
  else if (key === 'symbolic-ref -q HEAD') stdout = 'refs/heads/main\n'
  else if (key.startsWith('for-each-ref --format=%(refname)%09%(objectname)')) stdout = REFS
  else if (key.startsWith('for-each-ref --format=%(refname)%09%(ahead-behind:')) stdout = 'refs/heads/main\t0 0\n'
  else if (key.startsWith('rev-list --count')) stdout = '0\n'
  else if (key.startsWith('gh pr list')) stdout = '[]'
  else if (key !== 'status --porcelain=v1 -z') exitCode = 1

  return { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
}

// エンジンの代わり。process.run の呼び出しを calls に、clock.every の作成と取り消しを timers に残す。
function engine(on: any, placed = true) {
  const calls: string[] = []
  const timers = { made: 0 }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'session-desk', isPlaced: placed }] }))
  on('session.cwd', () => ({ value: 'D:/p' }))
  // テストのエンジンは、周期を待たずに fn を呼び続ける。周期を拒否して、そこで止める（呼ばれた回数だけを数える）。
  on('clock.every', () => {
    timers.made++

    return { deny: 'test: no timers' }
  })
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_: any, e: any) => {
    calls.push(e.argv.join(' '))

    return { value: reply(e.argv) }
  })
  on('tool.call', () => ({ result: {} }))

  return { calls, timers }
}

const start = ($: any) => $.session.start({ cwd: 'D:/p', surface: 'terminal', interactive: true })
const gh = (calls: string[]) => calls.filter(c => c.startsWith('gh ')).length
const git = (calls: string[]) => calls.filter(c => c.startsWith('git ')).length

test('pressing the ブランチ tab reads git and gh; the other tabs do not', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  await settle(e.calls)
  expect(e.calls.length).toBe(0)
  await ui.press({ key: 'tab-branch' })
  await settle(e.calls)
  expect(e.calls).toContain('git --no-optional-locks rev-parse --git-dir')
  expect(gh(e.calls)).toBe(1)
  await ui.unmount()
})

test('nothing is read while the panel is not placed, even on the ブランチ tab', async ($, on) => {
  const e = engine(on, false)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-branch' })
  await settle(e.calls)
  expect(e.calls.length).toBe(0)
  await ui.unmount()
})

test('a Bash tool call refreshes git; only a command with gh or git push refreshes gh too', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-branch' })
  await settle(e.calls)
  const gitBefore = git(e.calls)
  expect(gh(e.calls)).toBe(1)
  await $.tool.call({ tool: 'Bash', command: 'ls high' })
  await settle(e.calls)
  expect(git(e.calls)).toBeGreaterThan(gitBefore)
  expect(gh(e.calls)).toBe(1)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create' })
  await settle(e.calls)
  expect(gh(e.calls)).toBe(2)
  await ui.unmount()
})

test('a tool other than Bash, Edit or Write does not refresh', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-branch' })
  await settle(e.calls)
  const before = e.calls.length
  await $.tool.call({ tool: 'Read', file_path: 'x' })
  await settle(e.calls)
  expect(e.calls.length).toBe(before)
  await ui.unmount()
})

test('the session start creates the 10-second timer', async ($, on) => {
  const e = engine(on)
  await start($)
  expect(e.timers.made).toBe(1)
  // 取り消し（cancel）は、プラグイン側の Timer の呼び出しで、テストの hook からは見えない。
  await start($)
  expect(e.timers.made).toBe(2)
})

test('when a refresh throws, the user is told once instead of the tab silently staying at 読み込み中', async ($, on) => {
  const toasts: string[] = []
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'session-desk', isPlaced: true }] }))
  on('session.cwd', () => {
    throw new Error('boom')
  })
  on('clock.every', () => ({ deny: 'test: no timers' }))
  on('clock.sleep', () => ({ value: undefined }))
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-branch' })
  await flush()
  await flush()
  expect(toasts.length).toBe(1)
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await flush()
  await flush()
  expect(toasts.length).toBe(1)
  await ui.unmount()
})
