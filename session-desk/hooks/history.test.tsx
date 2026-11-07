import { expect, test } from 'claude-code/testing'

import { preview } from './lib'
import { ESC, ancestorsOf, parentOf, textsOf } from './test-kit'

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

// エンジンの代わりの受け皿。送信は、そのまま通す。
function fakeEngine(on: any) {
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('session.cwd', () => ({ value: 'D:/p' }))
}

// 実際の送信は wait と origin も持つ。テストでは text と、ユーザーの送信を表す origin を渡す。
const send = ($: any, text: string, origin: any = { kind: 'composer' }) => $.prompt.submit({ text, origin })

// 一覧の行は、番号つきの Text。描画の JSON から、順に取り出す。
const rows = async (ui: any): Promise<string[]> => textsOf(await ui.drawn()).filter(text => /^[0-9]+\. /.test(text))

test('preview collapses whitespace, strips control codes and cuts at 60 characters', async () => {
  expect(preview('short')).toBe('short')
  expect(preview(`a${String.fromCharCode(0x200b)}b${String.fromCharCode(0x202e)}c`)).toBe('abc')
  expect(preview('a\n  b\tc')).toBe('a b c')
  expect(preview(`${ESC}[31mred${ESC}[0m`)).toBe('red')
  expect(preview('x'.repeat(60))).toBe('x'.repeat(60))
  expect(preview('x'.repeat(61))).toBe(`${'x'.repeat(60)}…`)
})

test('history lists sent prompts newest first with numbers, keeping duplicates', async ($, on) => {
  fakeEngine(on)
  for (const text of ['first', 'second', 'second', 'third']) {
    await send($, text)
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  expect(await rows(ui)).toEqual(['4. third', '3. second', '2. second', '1. first'])
  await ui.unmount()
})

test('history does not record blank prompts and passes the prompt through unchanged', async ($, on) => {
  fakeEngine(on)
  const sent = await send($, '  \n ')
  expect(sent.text).toBe('  \n ')
  await send($, 'real')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  expect(await rows(ui)).toEqual(['1. real'])
  await ui.unmount()
})

test('history shows 60 characters; the full-text action turns that very line into the whole prompt, and back', async ($, on) => {
  fakeEngine(on)
  const long = `${'a'.repeat(60)}${'b'.repeat(40)}`
  await send($, long)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  expect(await rows(ui)).toEqual([`1. ${'a'.repeat(60)}…`])
  expect(JSON.stringify(await ui.find({ key: 'history-1' }))).toContain('"label":"▾ 全文"')
  await ui.press({ key: 'history-1' })
  // 全文は、別の行に足さず、いま出ている行そのものが全文になる。
  expect(await rows(ui)).toEqual([`1. ${long}`])
  expect(JSON.stringify(await ui.find({ key: 'history-1' }))).toContain('"label":"▴ 短く"')
  await ui.press({ key: 'history-1' })
  expect(await rows(ui)).toEqual([`1. ${'a'.repeat(60)}…`])
  await ui.unmount()
})

test('only one line is expanded at a time: opening another shortens the first', async ($, on) => {
  fakeEngine(on)
  const first = `${'a'.repeat(60)}${'b'.repeat(40)}`
  const second = `${'c'.repeat(60)}${'d'.repeat(40)}`
  await send($, first)
  await send($, second)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  await ui.press({ key: 'history-1' })
  expect(await rows(ui)).toEqual([`2. ${'c'.repeat(60)}…`, `1. ${first}`])
  await ui.press({ key: 'history-2' })
  expect(await rows(ui)).toEqual([`2. ${second}`, `1. ${'a'.repeat(60)}…`])
  await ui.unmount()
})

test('the prompt is plain text; actions are borderless words on the next line, with a blank row between entries', async ($, on) => {
  fakeEngine(on)
  const long = 'x'.repeat(100)
  await send($, long)
  await send($, 'second')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  const tree = await ui.drawn()
  const json = JSON.stringify(tree)
  // 文は Button の label に入れない。操作は、枠のない（plain）短い言葉。
  expect(json).not.toContain('"label":"1. ')
  expect(json).toContain('"label":"＋ 定型文に追加"')
  for (const key of ['history-1', 'history-add-1']) {
    const button = JSON.stringify(await ui.find({ key }))
    expect(button).toContain('"plain":true')
    expect(button).not.toContain('"variant"')
    // 操作は、記号も言葉もアクセント色（1 つの Text にまとめる）。
    expect(button).toContain('"color":"suggestion"')
  }
  expect(JSON.stringify(await ui.find({ key: 'history-1' }))).toContain('"children":["▾ 全文"]')
  expect(JSON.stringify(await ui.find({ key: 'history-add-1' }))).toContain('"children":["＋ 定型文に追加"]')
  // 2 つの操作は同じ段にあり、その段に文は入っていない。
  const actions = parentOf(tree, 'history-1')
  expect(parentOf(tree, 'history-add-1')).toBe(actions)
  expect(JSON.stringify(actions)).not.toContain('xxxx')
  // 履歴の一覧は縦並びで、項目の間に空行（gap 1）がある。
  const list = ancestorsOf(tree, 'history-1').some(
    box => (box.props as { flexDirection?: string; gap?: number } | undefined)?.gap === 1 &&
      (box.props as { flexDirection?: string } | undefined)?.flexDirection === 'column',
  )
  expect(list).toBe(true)
  await ui.unmount()
})

test('history: the newest 5 show; 「もっと見る」 opens the older ones', async ($, on) => {
  fakeEngine(on)
  for (let i = 1; i <= 7; i++) await send($, `h${i}`)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  expect(await rows(ui)).toEqual(['7. h7', '6. h6', '5. h5', '4. h4', '3. h3'])
  expect(JSON.stringify(await ui.find({ key: 'more-history' }))).toContain('あと 2 件')
  await ui.press({ key: 'more-history' })
  expect(await rows(ui)).toEqual(['7. h7', '6. h6', '5. h5', '4. h4', '3. h3', '2. h2', '1. h1'])
  await ui.press({ key: 'more-history' })
  expect(await rows(ui)).toHaveLength(5)
  await ui.unmount()
})

test('the panel opens on 定型文; the selected tab is marked with ▸ and drawn normally, the other is dim', async ($, on) => {
  fakeEngine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tab = async (key: string) => JSON.stringify(await ui.find({ key }))
  expect(await tab('tab-quick')).toContain('"label":"▸ 定型文"')
  expect(await tab('tab-quick')).not.toContain('"dimColor":true')
  // 選択中のタブは、水色の太字に下線。選んでいないタブは、薄い字。
  expect(await tab('tab-quick')).toContain('"color":"#4fd6e0"')
  expect(await tab('tab-quick')).toContain('"bold":true')
  expect(await tab('tab-quick')).toContain('"underline":true')
  expect(await tab('tab-history')).toContain('"label":"履歴"')
  expect(await tab('tab-history')).toContain('"dimColor":true')
  expect(await ui.find({ key: 'tab-changes' })).toBeUndefined()
  await ui.press({ key: 'tab-history' })
  expect(await tab('tab-history')).toContain('"label":"▸ 履歴"')
  expect(await tab('tab-history')).not.toContain('"dimColor":true')
  expect(await tab('tab-quick')).toContain('"label":"定型文"')
  expect(await tab('tab-quick')).toContain('"dimColor":true')
  await ui.unmount()
})

test('the tabs are in the order 定型文, 履歴', async ($, on) => {
  fakeEngine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const json = JSON.stringify(await ui.drawn())
  expect(json.indexOf('tab-quick')).toBeGreaterThan(-1)
  expect(json.indexOf('tab-quick')).toBeLessThan(json.indexOf('tab-history'))
  await ui.unmount()
})

test('one blank row separates the tabs from the body, on both tabs', async ($, on) => {
  fakeEngine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // タブの行と本文は同じ縦並びの Box にあり、本文は 1 行（marginTop 1）あけて置かれる。
  const gap = async () => {
    const tabs = ancestorsOf(await ui.drawn(), 'tab-quick').at(-1) as { props?: { flexDirection?: string }; children?: { props?: { marginTop?: number } }[] }
    const column = ancestorsOf(await ui.drawn(), 'tab-quick').at(-2) as { props?: { flexDirection?: string }; children?: { props?: { marginTop?: number } }[] }
    expect(tabs).toBeDefined()
    return column.props?.flexDirection === 'column' && column.children?.some(c => c.props?.marginTop === 1)
  }
  expect(await gap()).toBe(true)
  await ui.press({ key: 'tab-history' })
  expect(await gap()).toBe(true)
  await ui.unmount()
})

test('history shows a note when nothing was sent', async ($, on) => {
  fakeEngine(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  expect(await ui.find({ type: 'Text', text: 'なし' })).toBeDefined()
  await ui.unmount()
})

test('history records only prompts the user sent: Enter, the phone or web, and the pane\'s own send', async ($, on) => {
  fakeEngine(on)
  await send($, 'typed')
  await send($, 'remote', { kind: 'bridge' })
  await send($, 'quick', { kind: 'plugin', name: 'session-desk' })
  await send($, 'to subagent', { kind: 'plugin', name: 'other' })
  await send($, 'notice', { kind: 'task-notification' })
  await send($, 'loop', { kind: 'scheduled-trigger' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-history' })
  expect(await rows(ui)).toEqual(['3. quick', '2. remote', '1. typed'])
  await ui.unmount()
})
