import { expect, test } from 'claude-code/testing'

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

// エンジンの代わり。tool.call は gate が立っている間、完了を待たせる。
// opts.ticks: clock.every の周期を、その回数だけ通してから拒否する（拒否で周期が止まる）。opts.placed: パネルが置かれているか。
function engine(on: any, status = '?? a\0?? b\0?? c\0', opts: { ticks?: number; placed?: boolean; toastThrows?: boolean } = {}) {
  const gate = { hold: null as null | Promise<void>, seen: [] as string[], toasts: [] as string[] }
  let ticks = opts.ticks ?? 0
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: 'session-desk', isPlaced: opts.placed ?? true }] }))
  on('session.cwd', () => ({ value: 'D:/p' }))
  on('ui.toast', (_: any, e: any) => {
    gate.toasts.push(e.text)
    if (opts.toastThrows) {
      throw new Error('toast refused')
    }

    return { value: undefined }
  })
  on('clock.every', () => (ticks-- > 0 ? { value: undefined } : { deny: 'test: no timers' }))
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
const labels = async (ui: any) => labelsOf(await ui.drawn())
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

// ---- Task 8: モデル・コンテキスト・上限・サブエージェント ----

const ZERO_USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
const cat = (name: string, kind: string, tokens: number) => ({ name, kind, tokens, color: 'x', isDeferred: kind === 'deferred' })

// usage / model / agent.list の差し替え。calls に usage の引数を残す。
function fakeData(on: any, opts: { usage?: any; list?: any[]; throwUsage?: boolean; throwList?: boolean } = {}) {
  // usageGate: 立っている間、usage の返答を待たせる（呼ばれた記録は先に残す）。
  const state = { calls: [] as any[], list: opts.list ?? [], gate: null as null | Promise<void>, usageGate: null as null | Promise<void> }
  on('session.usage', async (_: any, e: any) => {
    state.calls.push(e)
    await state.usageGate
    if (opts.throwUsage) throw new Error('usage failed')

    if (typeof opts.usage === 'function') return { value: opts.usage(e) }

    return { value: opts.usage ?? { startedAt: 0, context: { window: 200000, tokens: 116000, percent: 58 }, rateLimits: [] } }
  })
  on('session.model', () => ({ value: 'claude-test-model' }))
  on('agent.list', async () => {
    await state.gate
    if (opts.throwList) throw new Error('no session is bound')

    return { value: state.list }
  })
  on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))

  return state
}

// 描かれた木から、Text の color を、文字ごとに集める。
function colorsOf(tree: any, out: { text: string; color?: string }[] = []) {
  if (tree?.type === 'Text' && typeof tree.children?.[0] === 'string') out.push({ text: tree.children[0], color: tree.props?.color })
  for (const c of tree?.children ?? []) if (typeof c === 'object' && c !== null) colorsOf(c, out)

  return out
}

const agent = (status: string) => ({ id: 'a1', type: 'Explore', description: 'look around', status })

test('turn.complete brings the context percent and the model to the pane, no timer needed', async ($, on) => {
  engine(on)
  const data = fakeData(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await draw(ui)).not.toContain('claude-test-model')
  await $.turn.complete(done({ usage: ZERO_USAGE }))
  await settle()
  const t = await draw(ui)
  expect(t).toContain('claude-test-model')
  expect(t).toContain('58%')
  expect(t).toContain('116k / 200k')
  expect(data.calls.length).toBeGreaterThan(0)
  expect(data.calls.every(c => c.breakdown === 'summary')).toBe(true)
  await ui.unmount()
})

test('turn.start and tool.call fetch too', async ($, on) => {
  engine(on)
  const data = fakeData(on)
  await start($)
  await settle()
  const before = data.calls.length
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await settle()
  const afterStart = data.calls.length
  expect(afterStart).toBeGreaterThan(before)
  await $.tool.call({ tool: 'Grep', pattern: 'x' })
  await settle()
  expect(data.calls.length).toBeGreaterThan(afterStart)
})

test('empty rateLimits hides the limits but keeps the context', async ($, on) => {
  engine(on)
  fakeData(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  const t = await draw(ui)
  expect(t).toContain('58%')
  expect(t).not.toContain('5時間枠')
  expect(t).not.toContain('7日枠')
  await ui.unmount()
})

test('a throwing usage leaves the run row, the git row and the model', async ($, on) => {
  engine(on)
  fakeData(on, { throwUsage: true })
  await start($)
  await settle()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await settle()
  const t = await draw(ui)
  expect(t).toContain('実行中')
  expect(t).toContain('feat-x')
  expect(t).toContain('claude-test-model')
  expect(t.some(x => x.includes(' / '))).toBe(false)
  await ui.unmount()
})

test('five_hour and seven_day show two limits', async ($, on) => {
  engine(on)
  const future = new Date(Date.now() + 3 * 3600_000 + 60_000).toISOString()
  fakeData(on, {
    usage: {
      startedAt: 0,
      context: { window: 200000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 36, resetsAt: future },
        { kind: 'seven_day', percentUsed: 97 },
      ],
    },
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  const t = await draw(ui)
  expect(t).toContain('5時間枠')
  expect(t).toContain('7日枠')
  expect(t).toContain('36%')
  expect(t).toContain('97%')
  expect(t).toContain('3h 0m')
  const c = colorsOf(await ui.drawn())
  expect(c.find(x => x.text === '97%')?.color).toBe('error')
  expect(c.find(x => x.text === '36%')?.color).toBeUndefined()
  await ui.unmount()
})

test('the context bar is split by the breakdown categories colours', async ($, on) => {
  engine(on)
  fakeData(on, {
    usage: {
      startedAt: 0,
      context: {
        window: 200000,
        tokens: 100000,
        percent: 50,
        breakdown: {
          categories: [cat('Messages', 'used', 60000), cat('System prompt', 'used', 30000), cat('Free space', 'free', 100000), cat('Autocompact buffer', 'buffer', 10000)],
          rawMaxTokens: 200000,
          autoCompactThreshold: 160000,
          isAutoCompactEnabled: true,
          mcpTools: [{ name: 't', serverName: 's', tokens: 5, isLoaded: true }],
          memoryFiles: [{ path: 'CLAUDE.md', type: 'User', tokens: 7 }],
          skills: { totalSkills: 1, includedSkills: 1, tokens: 3, skillFrontmatter: [{ name: 'sk', source: 'x', tokens: 3 }] },
        },
      },
      rateLimits: [],
    },
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  const colors = colorsOf(await ui.drawn())
    .filter(x => /^█+$/.test(x.text))
    .map(x => x.color)
  expect(colors).toContain('#61afef')
  expect(colors).toContain('#7ec699')
  expect(colors).not.toContain('#55555a')
  await ui.unmount()
})

test('a spawned running agent opens the list; closing keeps it closed on the next fetch; 0 agents shows nothing', async ($, on) => {
  engine(on)
  const data = fakeData(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  expect(await draw(ui)).not.toContain('サブエージェント')
  data.list = [agent('running')]
  await $.agent.spawn({ prompt: 'p' })
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await settle()
  let t = await draw(ui)
  expect(t).toContain('サブエージェント')
  expect(t).toContain('Explore')
  expect(t).toContain('look around')
  await ui.press({ key: 'band-agents' })
  await settle()
  t = await draw(ui)
  expect(t).toContain('サブエージェント')
  expect(t).not.toContain('look around')
  await $.turn.complete(done({ turnId: 't2' }))
  await settle()
  expect(await draw(ui)).not.toContain('look around')
  data.list = []
  await $.turn.complete(done({ turnId: 't2' }))
  await settle()
  t = await draw(ui)
  expect(t).not.toContain('サブエージェント')
  expect(t).not.toContain('Explore')
  await ui.unmount()
})

test('agent.list throwing hides the agents and nothing else breaks', async ($, on) => {
  engine(on)
  fakeData(on, { throwList: true })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  const t = await draw(ui)
  expect(t).not.toContain('サブエージェント')
  expect(t).toContain('58%')
  await ui.unmount()
})

test('tokens absent: the percent shows but no tokens text; window absent: no 0 / 0', async ($, on) => {
  engine(on)
  const data = fakeData(on, { usage: { startedAt: 0, context: { window: 200000, percent: 58 }, rateLimits: [] } })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  let t = await draw(ui)
  expect(t).toContain('58%')
  expect(t.some(x => x.includes(' / '))).toBe(false)
  expect(data.calls.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('window absent: the percent shows and there is no 0 / 0', async ($, on) => {
  engine(on)
  fakeData(on, { usage: { startedAt: 0, context: { tokens: 1000, percent: 58 }, rateLimits: [] } })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  const t = await draw(ui)
  expect(t).toContain('58%')
  expect(t.some(x => x.includes('/ '))).toBe(false)
  await ui.unmount()
})

test('tokens and window both present show as before', async ($, on) => {
  engine(on)
  fakeData(on, { usage: { startedAt: 0, context: { tokens: 860000, window: 1000000, percent: 86 }, rateLimits: [] } })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  expect(await draw(ui)).toContain('860k / 1M')
  await ui.unmount()
})

test('a manual close wins against a fetch that was already in flight', async ($, on) => {
  engine(on)
  const data = fakeData(on, { list: [agent('running')] })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  expect(await draw(ui)).toContain('look around')
  let release = () => {}
  data.gate = new Promise<void>(resolve => (release = resolve))
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await settle()
  await ui.press({ key: 'band-agents' })
  await settle()
  expect(await draw(ui)).not.toContain('look around')
  data.gate = null
  release()
  await settle()
  const t = await draw(ui)
  expect(t).toContain('サブエージェント')
  expect(t).not.toContain('look around')
  await ui.unmount()
})

// ---- Task 9: コンテキストの内訳と「正確に数える」 ----

function withBreakdown(over: object = {}, categories?: any[]) {
  return {
    startedAt: 0,
    context: {
      window: 1000000,
      tokens: 860000,
      percent: 86,
      breakdown: {
        categories: categories ?? [
          cat('Messages', 'used', 500000),
          cat('System prompt', 'used', 100000),
          cat('MCP tools', 'used', 200000),
          cat('Custom thing', 'used', 60000),
          cat('Free space', 'free', 40000),
          cat('Autocompact buffer', 'buffer', 100000),
        ],
        rawMaxTokens: 1000000,
        autoCompactThreshold: 900000,
        isAutoCompactEnabled: true,
        mcpTools: [
          { name: 'small', serverName: 'srv', tokens: 1000, isLoaded: true },
          { name: 'big', serverName: 'srv', tokens: 9000, isLoaded: true },
        ],
        memoryFiles: [{ path: 'CLAUDE.md', type: 'User', tokens: 700 }],
        skills: { totalSkills: 1, includedSkills: 1, tokens: 300, skillFrontmatter: [{ name: 'sk', source: 'x', tokens: 300 }] },
        ...over,
      },
    },
    rateLimits: [],
  }
}

test('pressing 内訳 opens the rows with 概算 and pressing again closes them', async ($, on) => {
  engine(on)
  fakeData(on, { usage: withBreakdown() })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  let t = await draw(ui)
  expect(await labels(ui)).toContain('▸ 内訳')
  expect(t).not.toContain('概算')
  expect(t).not.toContain('メッセージ')
  await ui.press({ key: 'band-breakdown' })
  await settle()
  t = await draw(ui)
  expect(await labels(ui)).toContain('▾ 内訳')
  expect(t).toContain('メッセージ')
  expect(t).toContain('500k')
  expect(t).toContain('50%')
  expect(t).toContain('概算')
  await ui.press({ key: 'band-breakdown' })
  await settle()
  t = await draw(ui)
  expect(await labels(ui)).toContain('▸ 内訳')
  expect(t).not.toContain('概算')
  expect(t).not.toContain('メッセージ')
  await ui.unmount()
})

test('no breakdown from usage: no 内訳 button', async ($, on) => {
  engine(on)
  fakeData(on)
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  const t = await draw(ui)
  expect(t).toContain('58%')
  expect((await labels(ui)).some(x => x.includes('内訳'))).toBe(false)
  await ui.unmount()
})

test('rows are sorted by tokens, buffer and unknown names fold into その他, 空き is last', async ($, on) => {
  engine(on)
  fakeData(on, { usage: withBreakdown() })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  await ui.press({ key: 'band-breakdown' })
  await settle()
  const t = await draw(ui)
  const names = ['メッセージ', 'MCP ツール', 'その他', 'システムプロンプト', '空き']
  const at = names.map(n => t.indexOf(n))
  expect(at.every(i => i >= 0)).toBe(true)
  expect([...at].sort((a, b) => a - b)).toEqual(at)
  // その他 = 未知の名前 60k + buffer 100k
  expect(t[t.indexOf('その他') + 1]).toBe('160k')
  expect(t[t.indexOf('その他') + 2]).toBe('16%')
  expect(t[t.indexOf('空き') + 1]).toBe('40k')
  expect(t[t.indexOf('空き') + 2]).toBe('4%')
  await ui.unmount()
})

test('the compact line counts the used categories: 860k used, 900k threshold gives あと 40k', async ($, on) => {
  engine(on)
  fakeData(on, { usage: withBreakdown() })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  await ui.press({ key: 'band-breakdown' })
  await settle()
  expect(await draw(ui)).toContain('自動 compact まで あと 40k（閾値 900k）')
  await ui.unmount()
})

test('auto compact disabled: no compact line', async ($, on) => {
  engine(on)
  fakeData(on, { usage: withBreakdown({ isAutoCompactEnabled: false }) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  await ui.press({ key: 'band-breakdown' })
  await settle()
  const t = await draw(ui)
  expect(t).toContain('概算')
  expect(t.some(x => x.includes('自動 compact'))).toBe(false)
  await ui.unmount()
})

test('no threshold: no compact line', async ($, on) => {
  engine(on)
  fakeData(on, { usage: withBreakdown({ autoCompactThreshold: undefined }) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  await ui.press({ key: 'band-breakdown' })
  await settle()
  const t = await draw(ui)
  expect(t).toContain('概算')
  expect(t.some(x => x.includes('自動 compact'))).toBe(false)
  await ui.unmount()
})

test('正確に数える makes exactly one full call; the next fetch is summary again', async ($, on) => {
  engine(on)
  const data = fakeData(on, { usage: withBreakdown() })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  await ui.press({ key: 'band-breakdown' })
  await settle()
  data.calls.length = 0
  await ui.press({ key: 'band-exact' })
  await settle()
  expect(data.calls.map(c => c.breakdown)).toEqual(['full'])
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await settle()
  expect(data.calls.length).toBeGreaterThan(1)
  expect(data.calls.slice(1).every(c => c.breakdown === 'summary')).toBe(true)
  await ui.unmount()
})

test('a failing full call shows a toast, keeps 概算, and later fetches are summary', async ($, on) => {
  const gate = engine(on)
  const calls: any[] = []
  fakeData(on, {
    usage: (e: any) => {
      calls.push(e)
      if (e.breakdown === 'full') throw new Error('full failed')

      return withBreakdown()
    },
  })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  await ui.press({ key: 'band-breakdown' })
  await settle()
  calls.length = 0
  await ui.press({ key: 'band-exact' })
  await settle()
  // full は 1 回だけ。失敗したら概算で読み直して、帯は消えない。
  expect(calls.map(c => c.breakdown)).toEqual(['full', 'summary'])
  expect(await labels(ui)).toContain('正確に数える')
  expect(gate.toasts).toEqual(['正確な数え直しに失敗しました'])
  expect(await draw(ui)).toContain('概算')
  expect(await draw(ui)).toContain('500k')
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await settle()
  expect(calls.length).toBeGreaterThan(1)
  expect(calls.slice(1).every(c => c.breakdown === 'summary')).toBe(true)
  await ui.unmount()
})

test('the ▸ of MCP, memory and skills rows shows each item, biggest first, and closes again', async ($, on) => {
  engine(on)
  fakeData(on, { usage: withBreakdown({}, [cat('MCP tools', 'used', 10000), cat('Memory files', 'used', 700), cat('Skills', 'used', 300), cat('Messages', 'used', 5000)]) })
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  await ui.press({ key: 'band-breakdown' })
  await settle()
  let t = await draw(ui)
  expect(t).not.toContain('srv / big')
  expect((await labels(ui)).filter(x => x === '▸ 1 件ずつ').length).toBe(3)
  await ui.press({ key: 'band-detail-mcp' })
  await settle()
  t = await draw(ui)
  expect(t.indexOf('srv / big')).toBeGreaterThanOrEqual(0)
  expect(t.indexOf('srv / big')).toBeLessThan(t.indexOf('srv / small'))
  expect(t[t.indexOf('srv / big') + 1]).toBe('9k')
  await ui.press({ key: 'band-detail-memory' })
  await ui.press({ key: 'band-detail-skills' })
  await settle()
  t = await draw(ui)
  expect(t).toContain('CLAUDE.md')
  expect(t).toContain('sk')
  await ui.press({ key: 'band-detail-mcp' })
  await settle()
  t = await draw(ui)
  expect(t).not.toContain('srv / big')
  expect(t).toContain('CLAUDE.md')
  await ui.unmount()
})

// ---- 最終レビューの修正: 取得のまとめ方と「正確に数える」 ----

test('a sub-agent tool.call does not fetch the usage', async ($, on) => {
  engine(on)
  const data = fakeData(on)
  await start($)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await settle()
  data.calls.length = 0
  await $.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'a1' })
  await settle()
  expect(data.calls.length).toBe(0)
})

test('many events while a fetch runs make at most one more fetch', async ($, on) => {
  engine(on)
  const data = fakeData(on)
  await start($)
  await settle()
  data.calls.length = 0
  let release = () => {}
  data.usageGate = new Promise<void>(resolve => (release = resolve))
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Grep', pattern: String(i) })
  await $.agent.spawn({ prompt: 'p' })
  await settle()
  expect(data.calls.length).toBe(1)
  data.usageGate = null
  release()
  await settle()
  expect(data.calls.length).toBe(2)
})

test('an older slow fetch cannot overwrite a newer one', async ($, on) => {
  engine(on)
  let n = 0
  let release = () => {}
  const first = new Promise<void>(resolve => (release = resolve))
  on('session.usage', async () => {
    const mine = ++n
    if (mine === 1) await first

    return { value: { startedAt: 0, context: { window: 200000, percent: mine === 1 ? 11 : 22 }, rateLimits: [] } }
  })
  on('session.model', () => ({ value: 'm' }))
  on('agent.list', () => ({ value: [] }))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Grep', pattern: 'x' })
  await settle()
  release()
  await settle()
  const t = await draw(ui)
  expect(t).toContain('22%')
  expect(t).not.toContain('11%')
  await ui.unmount()
})

test('the 10 s timer does not fetch the usage while the pane is not placed', async ($, on) => {
  engine(on, undefined, { ticks: 1, placed: false })
  const data = fakeData(on)
  await start($)
  await settle()
  expect(data.calls.length).toBe(0)
})

test('the 10 s timer fetches the usage while the pane is placed', async ($, on) => {
  engine(on, undefined, { ticks: 1, placed: true })
  const data = fakeData(on)
  await start($)
  await settle()
  expect(data.calls.length).toBe(1)
})

// 内訳を開くまで進める。
async function openBreakdown($: any) {
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await $.turn.complete(done())
  await settle()
  await ui.press({ key: 'band-breakdown' })
  await settle()

  return ui
}

test('a second 正確に数える press while the first is counting is ignored', async ($, on) => {
  engine(on)
  const data = fakeData(on, { usage: withBreakdown() })
  const ui = await openBreakdown($)
  data.calls.length = 0
  let release = () => {}
  data.usageGate = new Promise<void>(resolve => (release = resolve))
  await ui.press({ key: 'band-exact' })
  await settle()
  await ui.press({ key: 'band-exact' })
  await settle()
  expect(data.calls.map(c => c.breakdown)).toEqual(['full'])
  data.usageGate = null
  release()
  await settle()
  // 数え終わったら、また押せる。
  await ui.press({ key: 'band-exact' })
  await settle()
  expect(data.calls.map(c => c.breakdown)).toEqual(['full', 'full'])
  await ui.unmount()
})

test('the exact count stays, labelled 正確, through summary fetches until the next turn.start', async ($, on) => {
  engine(on)
  const exact = withBreakdown({}, [cat('Messages', 'used', 300000), cat('Free space', 'free', 700000)])
  const data = fakeData(on, { usage: (e: any) => (e.breakdown === 'full' ? exact : withBreakdown()) })
  const ui = await openBreakdown($)
  let t = await draw(ui)
  expect(t).toContain('500k')
  expect(t).toContain('概算')
  await ui.press({ key: 'band-exact' })
  await settle()
  t = await draw(ui)
  expect(t).toContain('300k')
  expect(t).toContain('正確')
  expect(t).not.toContain('概算')
  data.calls.length = 0
  await $.tool.call({ tool: 'Grep', pattern: 'x' })
  await $.turn.complete(done({ reason: 'error' }))
  await settle()
  expect(data.calls.length).toBeGreaterThan(0)
  expect(data.calls.every(c => c.breakdown === 'summary')).toBe(true)
  t = await draw(ui)
  expect(t).toContain('300k')
  expect(t).not.toContain('500k')
  expect(t).toContain('正確')
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await settle()
  t = await draw(ui)
  expect(t).toContain('500k')
  expect(t).toContain('概算')
  expect(t).not.toContain('正確')
  await ui.unmount()
})

test('a new session start drops an exact count from before; the next fetch brings the summary back with the label 概算', async ($, on) => {
  engine(on)
  const exact = withBreakdown({}, [cat('Messages', 'used', 300000), cat('Free space', 'free', 700000)])
  fakeData(on, { usage: (e: any) => (e.breakdown === 'full' ? exact : withBreakdown()) })
  const ui = await openBreakdown($)
  await ui.press({ key: 'band-exact' })
  await settle()
  let t = await draw(ui)
  expect(t).toContain('正確')
  expect(t).toContain('300k')
  await start($)
  await settle()
  t = await draw(ui)
  expect(t).not.toContain('正確')
  expect(t).not.toContain('300k')
  await $.turn.complete(done())
  await settle()
  t = await draw(ui)
  expect(t).not.toContain('正確')
  expect(t).toContain('概算')
  expect(t).toContain('500k')
  await ui.unmount()
})

test('a full call that returns no breakdown counts as a failure: toast, summary numbers kept, 概算', async ($, on) => {
  const gate = engine(on)
  const calls: any[] = []
  fakeData(on, {
    usage: (e: any) => {
      calls.push(e)

      return e.breakdown === 'full' ? { startedAt: 0, context: { window: 1000000, tokens: 1, percent: 1 }, rateLimits: [] } : withBreakdown()
    },
  })
  const ui = await openBreakdown($)
  calls.length = 0
  await ui.press({ key: 'band-exact' })
  await settle()
  expect(calls.map(c => c.breakdown)).toEqual(['full', 'summary'])
  expect(gate.toasts).toEqual(['正確な数え直しに失敗しました'])
  const t = await draw(ui)
  expect(t).toContain('概算')
  expect(t).not.toContain('正確')
  expect(t).toContain('500k')
  await ui.unmount()
})

test('a toast that fails to show does not stop the 正確に数える button from working again', async ($, on) => {
  const calls: any[] = []
  engine(on, undefined, { toastThrows: true })
  fakeData(on, {
    usage: (e: any) => {
      calls.push(e)
      if (e.breakdown === 'full') throw new Error('full failed')

      return withBreakdown()
    },
  })
  const ui = await openBreakdown($)
  calls.length = 0
  await ui.press({ key: 'band-exact' })
  await settle()
  await ui.press({ key: 'band-exact' })
  await settle()
  expect(calls.filter(c => c.breakdown === 'full').length).toBe(2)
  await ui.unmount()
})
