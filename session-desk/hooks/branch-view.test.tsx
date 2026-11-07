import { expect, test } from 'claude-code/testing'

import { buildRow } from './branch'
import { formatAt, renderBranchTab } from './branch-view'
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
  status?: string
  symref?: string
  refsTruncated?: boolean
  refsExit?: number
  submitFails?: boolean
  describe?: object
  tagCount?: string
}

function engine(on: any, over: Over = {}) {
  const calls: string[] = []
  const submitted: string[] = []
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.submit', (_: any, e: any) => {
    if (over.submitFails) {
      throw new Error('refused')
    }
    submitted.push(e.text)

    return { text: e.text }
  })
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
    else if (key === 'symbolic-ref -q refs/remotes/origin/HEAD') result = { exitCode: 0, stdout: over.symref ?? 'refs/remotes/origin/main\n' }
    else if (key === 'symbolic-ref -q HEAD') result = { exitCode: 0, stdout: 'refs/heads/feat/a\n', ...over.head }
    else if (key.startsWith('for-each-ref --format=%(refname)%09%(objectname)')) result = { exitCode: over.refsExit ?? 0, stdout: over.refs ?? REFS, ...(over.refsTruncated ? { isStdoutTruncated: true } : {}) }
    else if (key.startsWith('for-each-ref --format=%(refname)%09%(ahead-behind:')) result = { exitCode: 0, stdout: AHEAD }
    else if (key === 'status --porcelain=v1 -z') result = { exitCode: 0, stdout: over.status ?? '' }
    else if (key === 'remote -v') result = { exitCode: 0, stdout: REMOTE_V, ...over.remote }
    else if (key.startsWith('rev-list --left-right --count')) result = { exitCode: 0, stdout: over.diff ?? '0\t0\n' }
    else if (key.startsWith('describe --tags')) result = { exitCode: 128, stdout: '', ...over.describe }
    else if (key.startsWith('rev-list --count refs/tags/')) result = { exitCode: 0, stdout: over.tagCount ?? '0\n' }
    else if (key.startsWith('rev-list --count')) result = { exitCode: 0, stdout: '0\n' }
    else if (key.startsWith('gh pr list')) result = { exitCode: 0, stdout: PRS, ...over.gh }
    else if (key !== 'status --porcelain=v1 -z') result = { exitCode: 1, stdout: '' }

    return { value: { stderr: '', isStdoutTruncated: false, isStderrTruncated: false, ...result } }
  })
  on('tool.call', () => ({ result: {} }))

  return { calls, submitted, toasts }
}

const start = ($: any) => $.session.start({ cwd: 'D:/p', surface: 'terminal', interactive: true })
async function open($: any, calls: string[], pane: object = PANE) {
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  await ui.press({ key: 'tab-git' })
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
  // 日時は、右端の別の Text。経過の見出しは、選んだブランチの名前。
  expect(lines).toContain('✓ ブランチを切る')
  expect(lines).toContain('—')
  expect(lines).toContain('✓ commit  2 件')
  expect(lines).toContain('● push  次: push')
  expect(lines).toContain('○ PR')
  expect(lines).toContain('feat/a')
  // 縦の線（レール）: 先頭は ┌、末尾は └、間は ├（8 段階）。
  const rail = lines.filter(l => ['┌', '├', '└'].includes(l))
  expect(rail).toEqual(['┌', '├', '├', '├', '├', '├', '├', '└'])
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
  await ui.press({ key: 'tab-git' })
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
  {
    const lines = await texts(ui)
    expect(lines).toContain('origin')
    expect(JSON.stringify(await ui.drawn())).toContain('"href":"https://github.com/a/b"')
  }
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
  expect(lines).toContain('origin')
  expect(JSON.stringify(await ui.drawn())).toContain('"href":"https://github.com/a/b"')
  expect(lines).toContain('upstream')
  expect(JSON.stringify(await ui.drawn())).toContain('"href":"https://github.com/c/d"')
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
  expect(lines).toContain('upstream')
  expect(JSON.stringify(await ui.drawn())).toContain('"href":"https://github.com/c/d"')
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

// 質問ごとに key が違うので、ボタンは言葉で探す。
async function pressText(ui: any, text: string) {
  const button = await ui.find({ type: 'Button', text })
  await ui.press({ key: button.key })
}
const hasText = async (ui: any, text: string) => (await ui.find({ type: 'Button', text })) !== undefined

const textJson = async (ui: any, text: string) => JSON.stringify(await ui.find({ type: 'Text', text }))

test('colors: done is green, now is yellow and bold, todo is grey', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  expect(await textJson(ui, '✓ ブランチを切る')).toContain('"color":"success"')
  // レールの線は、済は緑、今は黄色、これからは灰色。
  expect(await textJson(ui, '┌')).toContain('"color":"success"')
  expect(await textJson(ui, '└')).toContain('"color":"inactive"')
  const now = await textJson(ui, '● push  次: push')
  expect(now).toContain('"color":"warning"')
  expect(now).toContain('"bold":true')
  expect(await textJson(ui, '○ PR')).toContain('"color":"inactive"')
  await ui.unmount()
})

test('colors: unknown is red', async ($, on) => {
  const e = engine(on, { gh: { exitCode: 1 } })
  await start($)
  const ui = await open($, e.calls)
  expect(await textJson(ui, '? PR')).toContain('"color":"error"')
  await ui.unmount()
})

test('colors: a skipped stage (no remote) is grey', async ($, on) => {
  const e = engine(on, { remote: { stdout: '' } })
  await start($)
  const ui = await open($, e.calls)
  expect(await textJson(ui, '－ push')).toContain('"color":"inactive"')
  await ui.unmount()
})

test('colors: each list row is colored by its next step', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  expect(await jsonOf(ui, 'branch-feat/a')).toContain('"color":"suggestion"')
  expect(await jsonOf(ui, 'branch-docs/b')).toContain('"color":"merged"')
  expect(await jsonOf(ui, 'branch-main')).toContain('"color":"inactive"')
  await ui.unmount()
})

test('colors: editing is yellow in the list', async ($, on) => {
  const e = engine(on, { status: ' M x\0' })
  await start($)
  const ui = await open($, e.calls)
  expect(await jsonOf(ui, 'branch-feat/a')).toContain('"color":"warning"')
  await ui.unmount()
})

test('with no branch to show (the list was too long), the screen says ブランチがありません, not the default-branch note', async ($, on) => {
  const e = engine(on, { refsTruncated: true })
  await start($)
  const ui = await open($, e.calls)
  const lines = await texts(ui)
  expect(lines).toContain('ブランチがありません')
  expect(lines).toContain('ブランチ一覧が長すぎます')
  expect(lines).not.toContain('経過はありません（既定ブランチ）')
  await ui.unmount()
})

test('the problem texts tell a git failure apart from a timeout', async ($, on) => {
  const e = engine(on, { refsExit: 128 })
  await start($)
  const ui = await open($, e.calls)
  expect(await texts(ui)).toContain('git の実行に失敗しました')
  await ui.unmount()
})

test('remote line shows the origin name and the URL in separate texts', async ($, on) => {
  const e = engine(on, { remote: { stdout: 'origin\tgithub.com/a/b (fetch)\norigin\tgithub.com/a/b (push)\n' } })
  await start($)
  const ui = await open($, e.calls)
  const lines = await texts(ui)
  expect(lines).toContain('origin')
  expect(JSON.stringify(await ui.drawn())).toContain('"href":"https://github.com/a/b"')
  await ui.unmount()
})

test('a token in a remote URL never reaches the screen', async () => {
  const ui = { Box: 'Box', Text: 'Text', Button: 'Button' }
  const tree = renderBranchTab(ui, {
    snapshot: {
      problem: null,
      branches: [],
      remotes: [{ name: 'origin', url: 'https://user:tok123@github.com/a/b.git' }],
      release: null,
      cwd: 'D:/p',
      warnings: [],
      gitAt: '00:00:00',
      ghAt: null,
    } as any,
    selected: null,
    columns: 80,
    offsetMin: 0,
    onSelect() {},
    more: { open: false, onToggle() {} },
    onNext() {},
    busy: false,
  })
  expect(JSON.stringify(tree)).not.toContain('tok123')
})

// 一覧が長いとき: 閉じていれば先頭から 5 件（いまのブランチと選んだブランチは外れていても出す）。「もっと見る」で全部。
const manyBranches = (count: number, currentIndex: number) => ({
  problem: null,
  remotes: [{ name: 'origin', url: 'github.com/a/b' }],
  release: null,
  cwd: 'D:/p',
  warnings: [],
  gitAt: '00:00:00',
  ghAt: null,
  branches: Array.from({ length: count }, (_, i) => ({
    name: `b${i + 1}`,
    kind: 'other',
    isCurrent: i === currentIndex,
    facts: { originDiff: null },
    stages: [],
    now: { id: null, text: '-' },
  })),
})

test('git: a long branch list shows 5 rows; the current and chosen branch stay in even when beyond them', async () => {
  const ui = { Box: 'Box', Text: 'Text', Button: 'Button' }
  const draw = (over: { selected: string | null; open: boolean; current: number }) =>
    JSON.stringify(
      renderBranchTab(ui, {
        snapshot: manyBranches(8, over.current) as any,
        selected: over.selected,
        columns: 80,
        offsetMin: 0,
        onSelect() {},
        more: { open: over.open, onToggle() {} },
        onNext() {},
    busy: false,
      }),
    )
  const rowsIn = (json: string) => [...json.matchAll(/"key":"branch-(b\d+)"/g)].map(m => m[1])
  const closed = draw({ selected: null, open: false, current: 0 })
  expect(new Set(rowsIn(closed))).toEqual(new Set(['b1', 'b2', 'b3', 'b4', 'b5']))
  expect(closed).toContain('▾ もっと見る（あと 3 件）')
  // いまのブランチが 7 番目でも、一覧に出る。あと何件かも、出ている行を引いて数える。
  const withCurrent = draw({ selected: null, open: false, current: 6 })
  expect(new Set(rowsIn(withCurrent))).toEqual(new Set(['b1', 'b2', 'b3', 'b4', 'b5', 'b7']))
  expect(withCurrent).toContain('あと 2 件')
  // 選んだブランチも同じ。
  expect(new Set(rowsIn(draw({ selected: 'b8', open: false, current: 0 })))).toEqual(new Set(['b1', 'b2', 'b3', 'b4', 'b5', 'b8']))
  const open = draw({ selected: null, open: true, current: 0 })
  expect(rowsIn(open)).toHaveLength(8)
  expect(open).toContain('▴ 閉じる')
  // 5 件以下なら、ボタンはない。
  expect(JSON.stringify(renderBranchTab(ui, { snapshot: manyBranches(5, 0) as any, selected: null, columns: 80, offsetMin: 0, onSelect() {}, more: { open: false, onToggle() {} }, onNext() {} }))).not.toContain('more-git')
})

test('next button: the current branch gets a button on its 今 row; pressing it sends the request once', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  expect(JSON.stringify(await ui.find({ key: 'git-next' }))).toContain('▶ push する')
  await ui.press({ key: 'git-next' })
  await ui.press({ key: 'git-next' })
  await flush()
  expect(e.submitted).toEqual(['ブランチ「feat/a」を push してください'])
  await ui.unmount()
})

test('next button: editing offers commit', async ($, on) => {
  const e = engine(on, { status: ' M x\0' })
  await start($)
  const ui = await open($, e.calls)
  expect(JSON.stringify(await ui.find({ key: 'git-next' }))).toContain('▶ commit する')
  await ui.press({ key: 'git-next' })
  await flush()
  expect(e.submitted).toEqual(['ブランチ「feat/a」の未コミットの変更を commit してください'])
  await ui.unmount()
})

test('next button: a branch that is not the current one has no button', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  await ui.press({ key: 'branch-docs/b' })
  await flush()
  expect(await ui.find({ key: 'git-next' })).toBeUndefined()
  await ui.unmount()
})

test('next button: while Claude is working it is a dim label that cannot be pressed (a pending question must not collide with the request)', async ($, on) => {
  const e = engine(on)
  on('turn.start', (_: any, ev: any) => ({ turnId: ev.turnId }))
  on('turn.complete', (_: any, ev: any) => ({ text: ev.answer }))
  await start($)
  const ui = await open($, e.calls)
  expect(await ui.find({ key: 'git-next' })).toBeDefined()
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await flush()
  expect(await ui.find({ key: 'git-next' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▶ push する' })).toBeDefined()
  await $.turn.complete({ answer: 'a', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await flush()
  await flush()
  expect(await ui.find({ key: 'git-next' })).toBeDefined()
  await ui.press({ key: 'git-next' })
  await flush()
  expect(e.submitted).toEqual(['ブランチ「feat/a」を push してください'])
  await ui.unmount()
})

test('next button: a question dialog holds the keys, so the request is not sent and the person is told', async ($, on) => {
  const e = engine(on)
  on('prompt.fill', () => ({ isFilled: false, refusal: 'dialog', text: '' }))
  await start($)
  const ui = await open($, e.calls)
  await ui.press({ key: 'git-next' })
  await flush()
  expect(e.submitted).toEqual([])
  expect(e.toasts).toEqual(['質問や許可の待ち中です。先に答えてください'])
  await ui.unmount()
})

// 「リリースするか、しないか」: 既定ブランチをチェックアウトしていて、最新のタグより先に commit があるとき。
const ON_MAIN = { head: { stdout: 'refs/heads/main\n' }, describe: { exitCode: 0, stdout: 'v1.2.0\n' }, tagCount: '3\n' }

test('release: on the default branch with commits after the latest tag, the choice is offered and 「リリースする」 sends the request once', async ($, on) => {
  const e = engine(on, ON_MAIN)
  await start($)
  const ui = await open($, e.calls)
  expect(await texts(ui)).toContain('リリース  v1.2.0 以降 3 件が、まだリリースされていません')
  expect(JSON.stringify(await ui.find({ key: 'git-release' }))).toContain('▶ リリースする')
  expect(await ui.find({ key: 'git-release-skip' })).toBeDefined()
  await ui.press({ key: 'git-release' })
  await ui.press({ key: 'git-release' })
  await flush()
  expect(e.submitted).toEqual(['main の未リリースの変更（v1.2.0 以降 3 件）をリリースしてください（version を上げる PR、タグ、Release の順）'])
  await ui.unmount()
})

test('release: 「今はしない」 hides the choice until the state changes', async ($, on) => {
  const e = engine(on, ON_MAIN)
  await start($)
  const ui = await open($, e.calls)
  await ui.press({ key: 'git-release-skip' })
  await flush()
  expect(await ui.find({ key: 'git-release' })).toBeUndefined()
  expect(await ui.find({ key: 'git-release-skip' })).toBeUndefined()
  expect(await texts(ui)).not.toContain('リリース  v1.2.0 以降 3 件が、まだリリースされていません')
  expect(e.submitted).toEqual([])
  await ui.unmount()
})

const NOT_OFFERED: [string, object][] = [
  ['off the default branch', {}],
  ['with no commit after the tag', { ...ON_MAIN, tagCount: '0\n' }],
  ['with no tag', { ...ON_MAIN, describe: { exitCode: 128 } }],
]
for (const [name, over] of NOT_OFFERED) {
  test(`release: nothing is offered ${name}`, async ($, on) => {
    const e = engine(on, over)
    await start($)
    const ui = await open($, e.calls)
    expect(await ui.find({ key: 'git-release' })).toBeUndefined()
    expect((await texts(ui)).some(t => t.startsWith('リリース  '))).toBe(false)
    await ui.unmount()
  })
}

test('local and remote are labelled: ローカル shows the folder, リモート shows the name and the URL', async ($, on) => {
  const e = engine(on)
  await start($)
  const ui = await open($, e.calls)
  const lines = await texts(ui)
  expect(lines).toContain('💻 ローカル')
  expect(lines).toContain('D:/p')
  expect(lines).toContain('🌐 リモート')
  expect(lines).toContain('origin')
  // ローカルの行が先、リモートの行がその次。
  expect(lines.indexOf('💻 ローカル')).toBeLessThan(lines.indexOf('🌐 リモート'))
  await ui.unmount()
})

test('a GitHub-style remote URL is a link (https), and a local path or a URL with no host name is plain text', async () => {
  const ui = { Box: 'Box', Text: 'Text', Button: 'Button', Link: 'Link' }
  const draw = (url: string) =>
    JSON.stringify(
      renderBranchTab(ui, {
        snapshot: { problem: null, branches: [], remotes: [{ name: 'origin', url }], release: null, cwd: 'D:/p', warnings: [], gitAt: '00:00:00', ghAt: null } as any,
        selected: null,
        columns: 80,
        offsetMin: 0,
        onSelect() {},
        more: { open: false, onToggle() {} },
        onNext() {},
        release: { skippedKey: null, onSkip() {} },
        busy: false,
      }),
    )
  const link = draw('https://user:tok@github.com/a/b.git')
  expect(link).toContain('"type":"Link"')
  expect(link).toContain('"href":"https://github.com/a/b"')
  expect(link).not.toContain('tok')
  expect(draw('C:/repos/x.git')).not.toContain('"type":"Link"')
  expect(draw('/srv/git/x')).not.toContain('"type":"Link"')
  // Link が渡されないときも、URL は文字として出る。
  expect(JSON.stringify(renderBranchTab({ Box: 'Box', Text: 'Text', Button: 'Button' }, { snapshot: { problem: null, branches: [], remotes: [{ name: 'origin', url: 'github.com/a/b' }], release: null, cwd: 'D:/p', warnings: [], gitAt: 'x', ghAt: null } as any, selected: null, columns: 80, offsetMin: 0, onSelect() {}, more: { open: false, onToggle() {} }, onNext() {}, release: { skippedKey: null, onSkip() {} }, busy: false }))).toContain('github.com/a/b')
})

// マージの段階では、PR のページへのリンクを、その行の右端に出す。
const prRow = (over: Record<string, unknown>) =>
  buildRow('feat/x', 'feat', true, {
    dirty: false,
    ahead: 2,
    pushed: true,
    createdAt: null,
    firstCommitAt: null,
    lastCommitAt: null,
    pushedAt: null,
    pr: { number: 19, state: 'OPEN', isDraft: false, reviewDecision: '', createdAt: '2026-11-07T12:00:00Z', mergedAt: null, headRefName: 'feat/x', headRefOid: 'abc', isCrossRepository: false, latestReviews: [], url: 'https://github.com/a/b/pull/19', ...over },
    prKnown: true,
    hasRemote: true,
    originDiff: null,
  } as any)

test('merge: the stage row of a PR waiting to be merged carries a link to the PR page', async () => {
  const ui = { Box: 'Box', Text: 'Text', Button: 'Button', Link: 'Link' }
  const draw = (row: any, Link = 'Link') =>
    JSON.stringify(
      renderBranchTab({ ...ui, Link } as any, {
        snapshot: { problem: null, branches: [row], remotes: [], release: null, cwd: 'D:/p', warnings: [], gitAt: '00:00:00', ghAt: '00:00:00' } as any,
        selected: null,
        columns: 80,
        offsetMin: 0,
        onSelect() {},
        more: { open: false, onToggle() {} },
        onNext() {},
        release: { skippedKey: null, onSkip() {} },
        busy: false,
      }),
    )
  const row = prRow({})
  expect(row.now).toEqual({ id: 6, text: 'マージ待ち' })
  const json = draw(row)
  expect(json).toContain('"href":"https://github.com/a/b/pull/19"')
  expect(json).toContain('PR #19  github.com/a/b/pull/19')
  // レビューの段階はない。レビュー待ちや草稿でも、PR が開いていれば、マージの行に出す。
  expect(draw(prRow({ reviewDecision: 'REVIEW_REQUIRED' }))).toContain('/pull/19')
  expect(draw(prRow({ isDraft: true }))).toContain('/pull/19')
  // url がない・https でない・閉じた PR は、出さない。
  expect(draw(prRow({ url: undefined }))).not.toContain('/pull/')
  expect(draw(prRow({ url: 'javascript:alert(1)' }))).not.toContain('javascript')
  // Link が渡されないときは、文字で出す。
  expect(draw(row, undefined as any)).toContain('PR #19  github.com/a/b/pull/19')
})

test('release stage row: 「▶ リリースする」 and 「今はしない」 sit on the 今 row of a merged branch', async () => {
  const ui = { Box: 'Box', Text: 'Text', Button: 'Button' }
  const pressed: string[] = []
  const row = prRow({ state: 'MERGED', mergedAt: '2026-11-05T14:00:00+09:00' })
  expect(row.now).toEqual({ id: 7, text: '次: リリース' })
  const tree = renderBranchTab(ui, {
    snapshot: { problem: null, branches: [row], remotes: [], release: null, cwd: 'D:/p', warnings: [], gitAt: '00:00:00', ghAt: '00:00:00' } as any,
    selected: null,
    columns: 80,
    offsetMin: 0,
    onSelect() {},
    more: { open: false, onToggle() {} },
    onNext(n: any) {
      pressed.push(`next:${n.label}`)
    },
    onSkipRelease(name: string) {
      pressed.push(`skip:${name}`)
    },
    release: { skippedKey: null, onSkip() {} },
    busy: false,
  } as any)
  const json = JSON.stringify(tree)
  expect(json).toContain('"key":"git-next"')
  expect(json).toContain('"key":"git-stage-release-skip"')
  expect(json).toContain('▶ リリースする')
  // マージ済みなので、マージの行にはリンクを出さない（開いた PR のときだけ）。
  expect(json).not.toContain('/pull/19')
  // 忙しいときは、リリースするは薄い字になるが、「今はしない」は押せる。
  const busy = JSON.stringify(
    renderBranchTab(ui, { snapshot: { problem: null, branches: [row], remotes: [], release: null, cwd: 'D:/p', warnings: [], gitAt: 'x', ghAt: 'x' } as any, selected: null, columns: 80, offsetMin: 0, onSelect() {}, more: { open: false, onToggle() {} }, onNext() {}, onSkipRelease() {}, release: { skippedKey: null, onSkip() {} }, busy: true } as any),
  )
  expect(busy).not.toContain('"key":"git-next"')
  expect(busy).toContain('"key":"git-stage-release-skip"')
})
