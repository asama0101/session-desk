import { expect, test } from 'claude-code/testing'

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
const settle = async () => {
  for (let i = 0; i < 20; i++) await flush()
}

// エンジンの代わり。tool.call は gate が立っている間、完了を待たせる。
function engine(on: any, status = '?? a\0?? b\0?? c\0') {
  const gate = { hold: null as null | Promise<void>, seen: [] as string[] }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'session-desk', isPlaced: true }] }))
  on('session.cwd', () => ({ value: 'D:/p' }))
  on('clock.every', () => ({ deny: 'test: no timers' }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', (_: any, e: any) => {
    const key = e.argv.slice(2).join(' ')
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    gate.seen.push(e.argv.join(' '))
    if (key === 'symbolic-ref -q HEAD') return ok('refs/heads/feat-x\n')
    if (key === 'status --porcelain=v1 -z') return ok(status)

    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', async () => {
    await gate.hold

    return { result: {} }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))

  return gate
}

const start = ($: any) => $.session.start({ cwd: 'D:/p', surface: 'terminal', interactive: true })
const draw = async (ui: any) => textsOf(await ui.drawn())
const done = (over: object) => ({ answer: 'a', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', ...over })

test('turn.start shows 実行中; sub-agent turn.start / turn.complete / tool.call leave the state alone', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await draw(ui)).not.toContain('実行中')
  await $.turn.start({ text: 'hi', turnId: 's1', agentId: 'a1' })
  expect(await draw(ui)).not.toContain('実行中')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await draw(ui)).toContain('実行中')
  await $.turn.complete(done({ agentId: 'a1', reason: 'error' }))
  expect(await draw(ui)).toContain('実行中')
  expect(await draw(ui)).not.toContain('停止中')
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  expect(await draw(ui)).not.toContain('実行中 Bash')
  await ui.unmount()
})

test('a running tool shows its name until the call settles; any tool counts; Bash still asks for a refresh', async ($, on) => {
  const gate = engine(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await settle()
  gate.seen.length = 0
  let release = () => {}
  gate.hold = new Promise<void>(resolve => (release = resolve))
  const bash = $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()
  expect(await draw(ui)).toContain('実行中 Bash')
  const other = $.tool.call({ tool: 'Grep', pattern: 'x' })
  await settle()
  expect(await draw(ui)).toContain('実行中 Bash +1')
  release()
  await Promise.all([bash, other])
  await settle()
  const after = await draw(ui)
  expect(after).toContain('実行中')
  expect(after.some(t => t.includes('Bash') || t.includes('Grep'))).toBe(false)
  expect(gate.seen.some(c => c.includes('status --porcelain'))).toBe(true)
  await ui.unmount()
})

test('turn.complete shows 停止中 with the last turn; error and aborted show their word', async ($, on) => {
  engine(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ durationMs: 102000, usage: { input_tokens: 1000, output_tokens: 234, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' } }))
  const t = await draw(ui)
  expect(t).toContain('停止中')
  expect(t).toContain('直近 1m42s')
  expect(t).toContain('1k tokens')
  expect(t).not.toContain('エラーで停止')
  await $.turn.complete(done({ reason: 'error' }))
  expect(await draw(ui)).toContain('エラーで停止')
  await $.turn.complete(done({ reason: 'aborted', isAborted: true }))
  const a = await draw(ui)
  expect(a).toContain('中断')
  expect(a).not.toContain('エラーで停止')
  await ui.unmount()
})

test('the branch and the uncommitted count show; with no repository that row is gone but the rest stays', async ($, on) => {
  engine(on)
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const t = await draw(ui)
  expect(t).toContain('feat-x')
  expect(t).toContain('未 commit 3')
  await ui.unmount()
})

test('without a repository the branch row is absent but the run row is drawn', async ($, on) => {
  engine(on, null)
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const t = await draw(ui)
  expect(t).toContain('実行中')
  expect(t.some(x => x.startsWith('未 commit'))).toBe(false)
  expect(t).not.toContain('feat-x')
  await ui.unmount()
})

test('the band is drawn above every tab', async ($, on) => {
  engine(on)
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for (const id of ['tab-history', 'tab-git', 'tab-quick']) {
    await ui.press({ key: id })
    await settle()
    const t = await draw(ui)
    expect(t).toContain('実行中')
    expect(t).toContain('feat-x')
  }
  await ui.unmount()
})
