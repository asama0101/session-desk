import { expect, test } from 'claude-code/testing'

import { forkPrompt } from './band'
import { labelsOf, textsOf } from './test-kit'

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

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const reply = (obj: unknown) => ({ isAnswered: true, text: typeof obj === 'string' ? obj : JSON.stringify(obj), usage: USAGE })
const GOOD = { goal: 'ログインを直す', reason: '案の選択待ち', steps: ['案 A で進めて', '案 B で進めて'] }

type Fork = { value?: any; throws?: boolean; hold?: boolean }

// エンジンの代わり。fork の返答は forks の先頭から順に使う（なければ GOOD）。hold なら、release を呼ぶまで返さない。
function engine(on: any) {
  const s = {
    forks: [] as Fork[],
    requests: [] as any[],
    submitted: [] as string[],
    toasts: [] as string[],
    submitFails: false,
    release: (_v: any) => {},
    runs: [] as string[],
    sleeps: [] as number[],
    wake: () => {},
  }
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'session-desk', isPlaced: true }] }))
  on('session.cwd', () => ({ value: 'D:/p' }))
  on('clock.every', () => ({ deny: 'test: no timers' }))
  // fork の時間切れ（30 秒）の待ちは、wake を呼ぶまで返さない。ほかの待ちはすぐ返す。
  on('clock.sleep', (_: any, e: any) => {
    s.sleeps.push(e.ms)
    if (e.ms === 30_000) {
      return new Promise(resolve => {
        s.wake = () => resolve({ value: undefined })
      })
    }

    return { value: undefined }
  })
  on('process.run', (_: any, e: any) => {
    s.runs.push(e.argv.join(' '))

    return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', () => ({ result: {} }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('ui.toast', (_: any, e: any) => {
    s.toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', (_: any, e: any) => {
    if (s.submitFails) {
      throw new Error('refused')
    }
    s.submitted.push(e.text)

    return { text: e.text }
  })
  on('model.fork', (_: any, e: any) => {
    s.requests.push(e)
    const f = s.forks.shift() ?? { value: reply(GOOD) }
    if (f.throws) {
      throw new Error('fork failed')
    }
    if (f.hold) {
      return new Promise(resolve => {
        s.release = v => resolve({ value: v })
      })
    }

    return { value: f.value }
  })

  return s
}

const start = ($: any) => $.session.start({ cwd: 'D:/p', surface: 'terminal', interactive: true })
const mount = ($: any) => $.ui.mount({ ...PANE, surface: 'terminal' })
const draw = async (ui: any) => textsOf(await ui.drawn())
const labels = async (ui: any) => labelsOf(await ui.drawn())
const done = (over: object = {}) => ({ answer: 'a', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer', ...over })
const send = ($: any, text: string) => $.prompt.submit({ text, origin: { kind: 'composer' } })

// 1 ターン回して、fork の結果が帯に書かれるまで待つ。
async function turn($: any, turnId = 't1') {
  await $.turn.start({ text: 'hi', turnId })
  await $.turn.complete(done({ turnId }))
  await settle()
}

test('forkPrompt asks for JSON only, with the previous goal and the limits', async () => {
  const p = forkPrompt('A')
  expect(p).toContain('前回のゴール: A')
  expect(p).toContain('JSON だけ')
  expect(p).toContain('{"goal": "<1行、40字以内>", "reason": "<止まった理由、30字以内>", "steps": [...]}')
  expect(p).toContain('最大 4 個')
  expect(p).toContain('1 つ 40 字以内')
  expect(p).toContain('空配列')
  expect(p).toContain('返答にない新しい作業を足さない')
  expect(p).toContain('そのまま返す')
  expect(forkPrompt(null)).toContain('前回のゴール: なし')
})

test('turn.complete (answer) calls fork once with effort low, and does not wait for it', async ($, on) => {
  const s = engine(on)
  s.forks.push({ hold: true })
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const out = await $.turn.complete(done())
  expect(out).toEqual({ text: 'a' })
  await settle()
  expect(s.requests.length).toBe(1)
  expect(s.requests[0].effort).toBe('low')
  expect(s.requests[0].prompt).toBe(forkPrompt(null))
})

test('no fork for a sub-agent turn, or for error / refusal / aborted', async ($, on) => {
  const s = engine(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ agentId: 'a1' }))
  for (const reason of ['error', 'refusal', 'aborted']) {
    await $.turn.complete(done({ reason }))
  }
  await settle()
  expect(s.requests.length).toBe(0)
})

test('a good reply draws the goal, the reason under 提案, and the steps', async ($, on) => {
  engine(on)
  await start($)
  const ui = await mount($)
  await turn($)
  const t = await draw(ui)
  expect(t).toContain('ゴール')
  expect(t).toContain('ログインを直す')
  expect(t).toContain('提案')
  expect(t).toContain('案の選択待ち')
  expect(await labels(ui)).toEqual(expect.arrayContaining(['案 A で進めて', '案 B で進めて']))
  await ui.unmount()
})

test('broken JSON, isAnswered false, or a throw: no steps, the previous goal stays, no toast', async ($, on) => {
  const s = engine(on)
  await start($)
  const ui = await mount($)
  await turn($, 't1')
  s.forks.push({ value: reply('{"goal": "新しい') }, { value: { isAnswered: false, reason: 'api-error' } }, { throws: true })
  for (const id of ['t2', 't3', 't4']) {
    await turn($, id)
    const t = await draw(ui)
    expect(t).toContain('ログインを直す')
    expect(t).not.toContain('提案')
    expect(await labels(ui)).not.toContain('案 A で進めて')
  }
  expect(s.requests.length).toBe(4)
  expect(s.toasts).toEqual([])
  await ui.unmount()
})

test('a number goal gives no steps; a 41-character goal keeps the previous goal but shows the steps', async ($, on) => {
  const s = engine(on)
  await start($)
  const ui = await mount($)
  await turn($, 't1')
  s.forks.push({ value: reply({ goal: 5, reason: 'r', steps: ['数値のとき'] }) })
  await turn($, 't2')
  expect(await labels(ui)).not.toContain('数値のとき')
  expect(await draw(ui)).toContain('ログインを直す')
  s.forks.push({ value: reply({ goal: 'あ'.repeat(41), reason: 'r', steps: ['長いとき'] }) })
  await turn($, 't3')
  expect(await draw(ui)).toContain('ログインを直す')
  expect(await draw(ui)).not.toContain('あ'.repeat(41))
  expect(await labels(ui)).toContain('長いとき')
  await ui.unmount()
})

test('steps are not drawn while running, and turn.start clears them', async ($, on) => {
  engine(on)
  await start($)
  const ui = await mount($)
  await turn($, 't1')
  expect(await labels(ui)).toContain('案 A で進めて')
  await send($, 'つぎ')
  await $.turn.start({ text: 'つぎ', turnId: 't2' })
  expect(await labels(ui)).not.toContain('案 A で進めて')
  expect(await draw(ui)).not.toContain('提案')
  await ui.unmount()
})

test('prompt.submit clears the steps', async ($, on) => {
  engine(on)
  await start($)
  const ui = await mount($)
  await turn($, 't1')
  expect(await labels(ui)).toContain('案 A で進めて')
  await send($, '別の依頼')
  expect(await labels(ui)).not.toContain('案 A で進めて')
  await ui.unmount()
})

test('pressing a step sends its exact text once and clears the steps', async ($, on) => {
  const s = engine(on)
  await start($)
  const ui = await mount($)
  await turn($)
  await ui.press({ key: 'band-step-1' })
  await settle()
  expect(s.submitted).toEqual(['案 B で進めて'])
  expect(await labels(ui)).not.toContain('案 A で進めて')
  await ui.unmount()
})

// 同じ Pane は 1 つの面に 1 つしか置けないので、2 つの面に置いて、両方の押下を待たずに同時に走らせる。
// 2 つの書き込みが競り、負けた側の update がやり直されても、送るのは 1 回だけ。
test('two presses at the same time send once', async ($, on) => {
  const s = engine(on)
  await start($)
  const a = await mount($)
  const b = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await turn($)
  const pressed = await Promise.allSettled([a.press({ key: 'band-step-1' }), b.press({ key: 'band-step-1' })])
  await settle()
  expect(pressed.map(p => p.status)).toEqual(['fulfilled', 'fulfilled'])
  expect(s.submitted).toEqual(['案 B で進めて'])
  await a.unmount()
  await b.unmount()
})

test('a rejected submit shows a toast and brings the steps back', async ($, on) => {
  const s = engine(on)
  await start($)
  const ui = await mount($)
  await turn($)
  s.submitFails = true
  await ui.press({ key: 'band-step-0' })
  await settle()
  expect(s.toasts).toEqual(['依頼を送れませんでした'])
  expect(await labels(ui)).toEqual(expect.arrayContaining(['案 A で進めて', '案 B で進めて']))
  await ui.unmount()
})

test('a risky step asks first: 送る sends once, やめる sends nothing', async ($, on) => {
  const s = engine(on)
  s.forks.push({ value: reply({ goal: 'g', reason: 'r', steps: ['ブランチを削除する'] }) })
  s.forks.push({ value: reply({ goal: 'g', reason: 'r', steps: ['ブランチを削除する'] }) })
  await start($)
  const ui = await mount($)
  await turn($, 't1')
  await ui.press({ key: 'band-step-0' })
  await settle()
  expect(s.submitted).toEqual([])
  expect(await draw(ui)).toContain('本当に送りますか？')
  await ui.press({ key: 'band-step-cancel' })
  await settle()
  expect(await draw(ui)).not.toContain('本当に送りますか？')
  expect(s.submitted).toEqual([])
  await ui.press({ key: 'band-step-0' })
  await settle()
  await ui.press({ key: 'band-step-confirm-0' })
  await settle()
  expect(s.submitted).toEqual(['ブランチを削除する'])
  expect(await labels(ui)).not.toContain('ブランチを削除する')
  await ui.unmount()
})

test('a fork result for an old turn is thrown away', async ($, on) => {
  const s = engine(on)
  s.forks.push({ hold: true })
  await start($)
  const ui = await mount($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ turnId: 't1' }))
  await settle()
  await send($, 'つぎ')
  await $.turn.start({ text: 'つぎ', turnId: 't2' })
  s.release(reply(GOOD))
  await settle()
  expect(await draw(ui)).not.toContain('ログインを直す')
  await $.turn.complete(done({ turnId: 't2' }))
  await settle()
  expect(await labels(ui)).toContain('案 A で進めて')
  await ui.unmount()
})

test('while our fork runs, turn.start / turn.complete / tool.call leave the band alone; a real turn after a prompt counts', async ($, on) => {
  const s = engine(on)
  s.forks.push({ hold: true })
  await start($)
  const ui = await mount($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ turnId: 't1' }))
  await settle()
  await $.turn.start({ text: 'fork', turnId: 'f1' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete(done({ turnId: 'f1', reason: 'error' }))
  await settle()
  let t = await draw(ui)
  expect(t).toContain('停止中')
  expect(t).not.toContain('実行中')
  expect(t).not.toContain('エラーで停止')
  expect(s.requests.length).toBe(1)
  await send($, 'つぎ')
  await $.turn.start({ text: 'つぎ', turnId: 't2' })
  t = await draw(ui)
  expect(t).toContain('実行中')
  await ui.unmount()
})

test('a prompt from any origin during our fork lets the next turn through, and the late result is thrown away', async ($, on) => {
  const s = engine(on)
  s.forks.push({ hold: true })
  await start($)
  const ui = await mount($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ turnId: 't1' }))
  await settle()
  await $.prompt.submit({ text: 'タスクの通知', origin: { kind: 'task-notification' } })
  await $.turn.start({ text: 'タスクの通知', turnId: 't2' })
  expect(await draw(ui)).toContain('実行中')
  s.release(reply(GOOD))
  await settle()
  expect(await labels(ui)).not.toContain('案 A で進めて')
  await ui.unmount()
})

test('a fork result that lands between a prompt and its turn.start does not bring the steps back', async ($, on) => {
  const s = engine(on)
  s.forks.push({ hold: true })
  await start($)
  const ui = await mount($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ turnId: 't1' }))
  await settle()
  await send($, 'つぎ')
  s.release(reply(GOOD))
  await settle()
  expect(await labels(ui)).not.toContain('案 A で進めて')
  await ui.unmount()
})

test('when the fork ends, the guard is lifted', async ($, on) => {
  engine(on)
  await start($)
  const ui = await mount($)
  await turn($, 't1')
  await $.turn.start({ text: 'hi', turnId: 't2' })
  expect(await draw(ui)).toContain('実行中')
  await ui.unmount()
})

test('a step sent by a click lands in the history', async ($, on) => {
  engine(on)
  await start($)
  const ui = await mount($)
  await turn($)
  await ui.press({ key: 'band-step-0' })
  await settle()
  await ui.press({ key: 'tab-history' })
  await settle()
  expect(await draw(ui)).toContain('1. 案 A で進めて')
  await ui.unmount()
})

test('while our fork runs, a Bash call still asks the Git refresh', async ($, on) => {
  const s = engine(on)
  s.forks.push({ hold: true })
  await start($)
  const ui = await mount($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ turnId: 't1' }))
  await settle()
  s.runs.length = 0
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await settle()
  expect(s.runs.some(r => r.includes('status --porcelain'))).toBe(true)
  // 帯の記録は飛ばす。
  expect(await draw(ui)).not.toContain('実行中 Bash')
  await ui.unmount()
})

test('a fork that never answers lifts the guard after 30 s, with no toast and no steps', async ($, on) => {
  const s = engine(on)
  s.forks.push({ hold: true })
  await start($)
  const ui = await mount($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ turnId: 't1' }))
  await settle()
  expect(s.sleeps).toContain(30_000)
  await $.turn.start({ text: 'fork', turnId: 'f1' })
  expect(await draw(ui)).not.toContain('実行中')
  s.wake()
  await settle()
  await $.turn.start({ text: 'hi', turnId: 't2' })
  expect(await draw(ui)).toContain('実行中')
  // 時間切れのあとに返った結果は使わない。
  s.release(reply(GOOD))
  await settle()
  expect(await labels(ui)).not.toContain('案 A で進めて')
  expect(s.toasts).toEqual([])
  await ui.unmount()
})

test('a late fork turn.complete after the 30 s timeout is not taken for a real turn, and starts no second fork', async ($, on) => {
  const s = engine(on)
  s.forks.push({ hold: true })
  await start($)
  const ui = await mount($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete(done({ turnId: 't1' }))
  await settle()
  // 時間切れで印が外れる。そのあと、本物の次のターンが始まる。
  s.wake()
  await settle()
  await $.turn.start({ text: 'again', turnId: 't2' })
  await settle()
  expect(await draw(ui)).toContain('実行中')
  // 遅れて届いた fork 自身の turn.complete（本物の開始を見ていないターンの完了）。
  await $.turn.complete(done({ turnId: 'f1' }))
  await settle()
  expect(await draw(ui)).toContain('実行中')
  expect(await draw(ui)).not.toContain('停止中')
  expect(s.requests.length).toBe(1)
  // 本物の t2 の完了は、ふつうに扱う。
  await $.turn.complete(done({ turnId: 't2' }))
  await settle()
  expect(await draw(ui)).toContain('停止中')
  expect(s.requests.length).toBe(2)
  await ui.unmount()
})
