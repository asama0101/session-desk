import { expect, test } from 'claude-code/testing'

import { DEFAULT_QUICK, addQuick, addSkip, moveQuick, parseQuick, parseSkips, removeQuick } from './lib'
import { ancestorsOf, parentOf, textsOf } from './test-kit'

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

const PHRASES = [
  '残りのタスクは？',
  '選択肢ごとにメリット・デメリットを明確にして推奨および影響をレポートして',
  'Artifact使ってデザインを見せて',
]

// エンジンの代わりの受け皿。送信された文言を submitted に、ストアの中身を saved に残す。
function fakeEngine(on: any, entries?: Record<string, unknown>) {
  const submitted: string[] = []
  const saved = new Map<string, unknown>(Object.entries({ quick: PHRASES, ...entries }))
  on('store.get', (_: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', (_: any, e: any) => {
    saved.set(e.key, e.value)

    return { value: undefined }
  })
  on('prompt.submit', (_: any, e: any) => {
    submitted.push(e.text)

    return { text: e.text }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  return { submitted, saved }
}

const start = ($: any) => $.session.start({ cwd: 'D:/p', surface: 'terminal', interactive: true })
const send = ($: any, text: string, origin: any = { kind: 'composer' }) => $.prompt.submit({ text, origin })
// 定型文の一覧は、ふつうの Text。ボタンの label は props にあり、children には入らない。
const labels = async (ui: any): Promise<string[]> => textsOf(await ui.drawn()).filter(text => !/^[▲▼] /.test(text))
const open = async ($: any) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-quick' })

  return ui
}

test('DEFAULT_QUICK is empty', async () => {
  expect([...DEFAULT_QUICK]).toEqual([])
})

test('parseQuick accepts only an array of non-empty strings', async () => {
  expect(parseQuick(['a', 'b'])).toEqual(['a', 'b'])
  expect(parseQuick([])).toEqual([])
  expect(parseQuick('a')).toBe(null)
  expect(parseQuick(['a', 1])).toBe(null)
  expect(parseQuick(['a', ''])).toBe(null)
  expect(parseQuick(undefined)).toBe(null)
})

test('addQuick ignores blanks and duplicates; removeQuick drops one index', async () => {
  expect(addQuick(['a'], 'b')).toEqual(['a', 'b'])
  expect(addQuick(['a'], 'a')).toEqual(['a'])
  expect(addQuick(['a'], '  ')).toEqual(['a'])
  expect(removeQuick(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
  expect(removeQuick(['a'], 5)).toEqual(['a'])
})

test('with an empty store the quick tab lists the three default phrases', async ($, on) => {
  fakeEngine(on)
  await start($)
  const ui = await open($)
  expect(await labels(ui)).toEqual(PHRASES)
  await ui.unmount()
})

test('the phrase is plain text; actions are borderless words on the next line, with a blank row between entries', async ($, on) => {
  fakeEngine(on)
  await start($)
  const ui = await open($)
  const tree = await ui.drawn()
  const json = JSON.stringify(tree)
  // 文は Button の label に入れない。操作は、枠のない（plain）短い言葉。
  for (const phrase of PHRASES) {
    expect(json).not.toContain(`"label":"${phrase}"`)
  }
  expect(json).toContain('"label":"▶ 送信"')
  expect(json).toContain('"label":"× 削除"')
  // 送信と削除は同じ段にあり、その段に文は入っていない。
  const actions = parentOf(tree, 'quick-1')
  expect(parentOf(tree, 'quick-del-1')).toBe(actions)
  expect(JSON.stringify(actions)).not.toContain(PHRASES[1] ?? '')
  // どちらも枠なし。
  const send = JSON.stringify(await ui.find({ key: 'quick-1' }))
  expect(send).toContain('"plain":true')
  expect(send).not.toContain('"variant"')
  expect(send).toContain('"color":"suggestion"')
  expect(send).toContain('"children":["▶ 送信"]')
  const del = JSON.stringify(await ui.find({ key: 'quick-del-1' }))
  expect(del).toContain('"plain":true')
  // 削除は、記号も言葉も赤（薄くしない）。
  expect(del).toContain('"color":"error"')
  expect(del).toContain('"children":["× 削除"]')
  expect(del).not.toContain('"dimColor"')
  // 定型文の一覧は縦並びで、項目の間に空行（gap 1）がある。
  const list = ancestorsOf(tree, 'quick-1').some(
    box => (box.props as { flexDirection?: string; gap?: number } | undefined)?.gap === 1 &&
      (box.props as { flexDirection?: string } | undefined)?.flexDirection === 'column',
  )
  expect(list).toBe(true)
  await ui.unmount()
})

test('every row has the same four actions in the same order: 送信, 削除, 上へ, 下へ; the ends keep a dim, unpressable slot', async ($, on) => {
  fakeEngine(on)
  await start($)
  const ui = await open($)
  const tree = await ui.drawn()
  const rows = [0, 1, 2].map(i => parentOf(tree, `quick-${i}`) as { children: { type: string; props?: { label?: string }; children?: unknown[] }[] })
  const words = (row: (typeof rows)[number]) =>
    row.children.map(c => (c.type === 'Button' ? c.props?.label : (c.children as string[])[0]))
  for (const row of rows) {
    expect(words(row)).toEqual(['▶ 送信', '× 削除', '▲ 上へ', '▼ 下へ'])
  }
  // 先頭の「上へ」と末尾の「下へ」は、押せない字。
  expect(rows[0]!.children[2]!.type).toBe('Text')
  expect(rows[1]!.children.map(c => c.type)).toEqual(['Button', 'Button', 'Button', 'Button'])
  expect(rows[2]!.children[3]!.type).toBe('Text')
  await ui.unmount()
})

const SEVEN = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']

test('quick: only the first 5 phrases show; 「もっと見る」 opens the rest and 「閉じる」 closes them', async ($, on) => {
  fakeEngine(on, { quick: SEVEN })
  await start($)
  const ui = await open($)
  expect(await labels(ui)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  expect(JSON.stringify(await ui.find({ key: 'more-quick' }))).toContain('▾ もっと見る（あと 2 件）')
  await ui.press({ key: 'more-quick' })
  expect(await labels(ui)).toEqual(SEVEN)
  expect(JSON.stringify(await ui.find({ key: 'more-quick' }))).toContain('▴ 閉じる')
  await ui.press({ key: 'more-quick' })
  expect(await labels(ui)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
  await ui.unmount()
})

test('quick: 5 phrases or fewer have no 「もっと見る」', async ($, on) => {
  fakeEngine(on, { quick: SEVEN.slice(0, 5) })
  await start($)
  const ui = await open($)
  expect(await labels(ui)).toEqual(SEVEN.slice(0, 5))
  expect(await ui.find({ key: 'more-quick' })).toBeUndefined()
  await ui.unmount()
})

test('quick: a question dialog holds the keys, so a phrase is not sent and the person is told', async ($, on) => {
  const { submitted } = fakeEngine(on)
  const toasts: string[] = []
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('prompt.fill', () => ({ isFilled: false, refusal: 'dialog', text: '' }))
  await start($)
  const ui = await open($)
  await ui.press({ key: 'quick-0' })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(submitted).toEqual([])
  // ほかの通知（Git タブの更新の失敗など）は、この確認に関係しない。
  expect(toasts.filter(t => t.startsWith('質問や許可'))).toEqual(['質問や許可の待ち中です。先に答えてください'])
  await ui.unmount()
})

test('pressing a phrase submits its exact text', async ($, on) => {
  const { submitted } = fakeEngine(on)
  await start($)
  const ui = await open($)
  await ui.press({ key: 'quick-0' })
  await ui.press({ key: 'quick-2' })
  expect(submitted).toEqual([PHRASES[0], PHRASES[2]])
  await ui.unmount()
})

test('adding from history keeps one copy and saves to the store', async ($, on) => {
  const { saved } = fakeEngine(on)
  await start($)
  await send($, 'レビューして')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  await ui.press({ key: 'history-add-1' })
  await ui.press({ key: 'history-add-1' })
  await ui.press({ key: 'tab-quick' })
  expect(await labels(ui)).toEqual([...PHRASES, 'レビューして'])
  expect(saved.get('quick')).toEqual([...PHRASES, 'レビューして'])
  await ui.unmount()
})

test('deleting removes the phrase and saves to the store', async ($, on) => {
  const { saved } = fakeEngine(on)
  await start($)
  const ui = await open($)
  await ui.press({ key: 'quick-del-0' })
  expect(await labels(ui)).toEqual([PHRASES[1], PHRASES[2]])
  expect(saved.get('quick')).toEqual([PHRASES[1], PHRASES[2]])
  await ui.unmount()
})

test('saved phrases are loaded at session start; a bad stored value falls back to the defaults', async ($, on) => {
  fakeEngine(on, { quick: ['x', 'y'] })
  await start($)
  const ui = await open($)
  expect(await labels(ui)).toEqual(['x', 'y'])
  await ui.unmount()
})

test('a bad stored value falls back to the defaults (no phrases)', async ($, on) => {
  fakeEngine(on, { quick: 'not-an-array' })
  await start($)
  const ui = await open($)
  expect(await labels(ui)).toEqual(['なし'])
  await ui.unmount()
})

test('session start still completes when the store cannot be read, and the defaults (no phrases) are used', async ($, on) => {
  // store.get の受け皿がないので、$.store.get は失敗する。
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const started = await start($)
  expect(started.cwd).toBe('D:/p')
  const ui = await open($)
  expect(await labels(ui)).toEqual(['なし'])
  await ui.unmount()
})

test('the quick tab shows a note when every phrase is deleted', async ($, on) => {
  fakeEngine(on, { quick: [] })
  await start($)
  const ui = await open($)
  expect(await ui.find({ type: 'Text', text: 'なし' })).toBeDefined()
  await ui.unmount()
})

test('moveQuick swaps a phrase with its neighbour and ignores moves off either end', async () => {
  expect(moveQuick(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c'])
  expect(moveQuick(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b'])
  expect(moveQuick(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c'])
  expect(moveQuick(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c'])
  expect(moveQuick(['a', 'b', 'c'], 9, -1)).toEqual(['a', 'b', 'c'])
})

test('the first phrase has no ▲ and the last has no ▼; the others have both', async ($, on) => {
  fakeEngine(on)
  await start($)
  const ui = await open($)
  expect(await ui.find({ key: 'quick-up-0' })).toBeUndefined()
  expect(await ui.find({ key: 'quick-down-0' })).toBeDefined()
  expect(await ui.find({ key: 'quick-up-1' })).toBeDefined()
  expect(await ui.find({ key: 'quick-down-1' })).toBeDefined()
  expect(await ui.find({ key: 'quick-up-2' })).toBeDefined()
  expect(await ui.find({ key: 'quick-down-2' })).toBeUndefined()
  const up = JSON.stringify(await ui.find({ key: 'quick-up-1' }))
  expect(up).toContain('"plain":true')
  expect(up).toContain('"children":["▲ 上へ"]')
  const down = JSON.stringify(await ui.find({ key: 'quick-down-1' }))
  expect(down).toContain('"children":["▼ 下へ"]')
  // 並び替えは、送信・削除より目立たないように、グレー（dimColor）で出す。アクセント色は付けない。
  for (const move of [up, down]) {
    expect(move).toContain('"dimColor":true')
    expect(move).not.toContain('"color":"suggestion"')
  }
  // 4 つの操作は、同じ段にある。
  const tree = await ui.drawn()
  expect(parentOf(tree, 'quick-up-1')).toBe(parentOf(tree, 'quick-1'))
  expect(parentOf(tree, 'quick-down-1')).toBe(parentOf(tree, 'quick-del-1'))
  await ui.unmount()
})

test('▼ and ▲ reorder the phrases and save the new order to the store', async ($, on) => {
  const { saved } = fakeEngine(on)
  await start($)
  const ui = await open($)
  await ui.press({ key: 'quick-down-0' })
  expect(await labels(ui)).toEqual([PHRASES[1], PHRASES[0], PHRASES[2]])
  expect(saved.get('quick')).toEqual([PHRASES[1], PHRASES[0], PHRASES[2]])
  await ui.press({ key: 'quick-up-2' })
  expect(await labels(ui)).toEqual([PHRASES[1], PHRASES[2], PHRASES[0]])
  expect(saved.get('quick')).toEqual([PHRASES[1], PHRASES[2], PHRASES[0]])
  await ui.unmount()
})

test('an order saved earlier is restored at session start', async ($, on) => {
  fakeEngine(on, { quick: [PHRASES[2], PHRASES[0]] })
  await start($)
  const ui = await open($)
  expect(await labels(ui)).toEqual([PHRASES[2], PHRASES[0]])
  await ui.unmount()
})

test('the field at the top of the quick tab adds a phrase of your own, saves it and is replaced by an empty one', async ($, on) => {
  const { saved } = fakeEngine(on)
  await start($)
  const ui = await open($)
  const field = JSON.stringify(await ui.find({ key: 'quick-new-3' }))
  expect(field).toContain('"placeholder"')
  expect(field).toContain('"submitLabel":"追加"')
  await ui.input({ key: 'quick-new-3', text: '  テストを実行して  ' })
  expect(await labels(ui)).toEqual([...PHRASES, 'テストを実行して'])
  expect(saved.get('quick')).toEqual([...PHRASES, 'テストを実行して'])
  // 足したあとは、入力欄が新しい（空の）ものに替わる。
  expect(await ui.find({ key: 'quick-new-3' })).toBeUndefined()
  expect(await ui.find({ key: 'quick-new-4' })).toBeDefined()
  await ui.unmount()
})

test('the field ignores a blank and a phrase that is already there', async ($, on) => {
  const { saved } = fakeEngine(on)
  await start($)
  const ui = await open($)
  await ui.input({ key: 'quick-new-3', text: '   ' })
  await ui.input({ key: 'quick-new-3', text: PHRASES[0] ?? '' })
  expect(await labels(ui)).toEqual(PHRASES)
  expect(saved.get('quick')).toEqual(PHRASES)
  // 足せなかったときは入力欄を作り直さない（入力した文が残る）。
  expect(await ui.find({ key: 'quick-new-3' })).toBeDefined()
  await ui.unmount()
})

test('a phrase added in the field can be sent, moved and deleted like the others', async ($, on) => {
  const { submitted, saved } = fakeEngine(on)
  await start($)
  const ui = await open($)
  await ui.input({ key: 'quick-new-3', text: '追加した文' })
  await ui.press({ key: 'quick-3' })
  expect(submitted).toEqual(['追加した文'])
  await ui.press({ key: 'quick-up-3' })
  expect(await labels(ui)).toEqual([PHRASES[0], PHRASES[1], '追加した文', PHRASES[2]])
  await ui.press({ key: 'quick-del-2' })
  expect(await labels(ui)).toEqual(PHRASES)
  expect(saved.get('quick')).toEqual(PHRASES)
  await ui.unmount()
})

test('parseSkips keeps the newest 20 strings and ignores anything else', async () => {
  expect(parseSkips('oops')).toEqual([])
  expect(parseSkips(undefined)).toEqual([])
  expect(parseSkips(['a', 1, '', 'b'])).toEqual(['a', 'b'])
  const many = Array.from({ length: 25 }, (_, i) => `k${i}`)
  expect(parseSkips(many)).toEqual(many.slice(5))
})

test('addSkip adds a key once and drops the oldest past 20', async () => {
  expect(addSkip(['a'], 'a')).toEqual(['a'])
  expect(addSkip(['a'], 'b')).toEqual(['a', 'b'])
  const full = Array.from({ length: 20 }, (_, i) => `k${i}`)
  expect(addSkip(full, 'new')).toEqual([...full.slice(1), 'new'])
})

test('a phrase that cannot be sent shows a toast instead of failing silently', async ($, on) => {
  const toasts: string[] = []
  on('store.get', () => ({ value: PHRASES }))
  on('store.set', () => ({ value: undefined }))
  on('prompt.submit', () => {
    throw new Error('refused')
  })
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await start($)
  const ui = await open($)
  await ui.press({ key: 'quick-0' })
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
  expect(toasts).toContain('依頼を送れませんでした')
  await ui.unmount()
})

test('a phrase that cannot be saved shows a toast; the screen still changes', async ($, on) => {
  const toasts: string[] = []
  on('store.get', () => ({ value: PHRASES }))
  on('store.set', () => {
    throw new Error('disk full')
  })
  on('ui.toast', (_: any, e: any) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await start($)
  const ui = await open($)
  await ui.press({ key: 'quick-del-0' })
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
  expect(toasts).toContain('定型文を保存できませんでした')
  expect(await labels(ui)).toEqual([PHRASES[1], PHRASES[2]])
  await ui.unmount()
})

test('adding a duplicate does not write the store again', async ($, on) => {
  let writes = 0
  on('store.get', () => ({ value: PHRASES }))
  on('store.set', () => {
    writes++

    return { value: undefined }
  })
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await start($)
  const ui = await open($)
  await ui.input({ key: 'quick-new-3', text: PHRASES[0] ?? '' })
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
  expect(writes).toBe(0)
  await ui.unmount()
})

test('pressing delete twice on the same drawn row removes only that phrase', async ($, on) => {
  const { saved } = fakeEngine(on)
  await start($)
  const ui = await open($)
  await Promise.all([ui.press({ key: 'quick-del-0' }), ui.press({ key: 'quick-del-0' })])
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0))
  expect(saved.get('quick')).toEqual(await labels(ui))
  expect(saved.get('quick')).not.toContain(PHRASES[0])
  await ui.unmount()
})
