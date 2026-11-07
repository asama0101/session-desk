import { expect, test } from 'claude-code/testing'

import { DEFAULT_QUICK, addQuick, parseQuick, removeQuick } from './lib'
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
  const saved = new Map<string, unknown>(Object.entries(entries ?? {}))
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
const labels = async (ui: any): Promise<string[]> => textsOf(await ui.drawn())
const open = async ($: any) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-quick' })

  return ui
}

test('DEFAULT_QUICK is the three phrases', async () => {
  expect([...DEFAULT_QUICK]).toEqual(PHRASES)
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

test('a bad stored value falls back to the defaults', async ($, on) => {
  fakeEngine(on, { quick: 'not-an-array' })
  await start($)
  const ui = await open($)
  expect(await labels(ui)).toEqual(PHRASES)
  await ui.unmount()
})

test('session start still completes when the store cannot be read, and the defaults are used', async ($, on) => {
  // store.get の受け皿がないので、$.store.get は失敗する。
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const started = await start($)
  expect(started.cwd).toBe('D:/p')
  const ui = await open($)
  expect(await labels(ui)).toEqual(PHRASES)
  await ui.unmount()
})

test('the quick tab shows a note when every phrase is deleted', async ($, on) => {
  fakeEngine(on, { quick: [] })
  await start($)
  const ui = await open($)
  expect(await ui.find({ type: 'Text', text: 'なし' })).toBeDefined()
  await ui.unmount()
})
