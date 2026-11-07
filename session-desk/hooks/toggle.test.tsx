import { expect, test } from 'claude-code/testing'

// 入力欄の上のバンド（AbovePrompt）を mount するときの引数。
const BAND = {
  plugin: 'session-desk',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

type FakePane = { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }
const pane = (isPlaced: boolean): FakePane => ({ id: 'session-desk', title: 'Session Desk', isShown: true, isFocused: false, isPlaced })

// エンジンの代わりの受け皿。開いているパネルの一覧は panes、開閉の呼び出しは calls に残す。
function fakeEngine(on: any, panes: FakePane[]) {
  const calls: string[] = []
  on('ui.panes', () => ({ value: panes }))
  on('ui.open', (_: any, e: any) => {
    calls.push(`open:${e.id}`)

    return { value: { isPlaced: true } }
  })
  on('ui.close', (_: any, e: any) => {
    calls.push(`close:${e.id}`)

    return { value: undefined }
  })
  // 何も足さないときに、エンジンが描くもの。
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>engine</Text>
  })

  return { calls }
}

test('the panel button opens a closed panel', async ($, on) => {
  const { calls } = fakeEngine(on, [])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'panel-toggle' })
  expect(calls).toEqual(['open:session-desk'])
  await ui.unmount()
})

test('the panel button opens a panel that waits undrawn because the terminal is narrow', async ($, on) => {
  const { calls } = fakeEngine(on, [pane(false)])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'panel-toggle' })
  expect(calls).toEqual(['open:session-desk'])
  await ui.unmount()
})

test('the panel button closes an open panel', async ($, on) => {
  const { calls } = fakeEngine(on, [pane(true)])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  await ui.press({ key: 'panel-toggle' })
  expect(calls).toEqual(['close:session-desk'])
  await ui.unmount()
})

test('the button reads サイドパネルの開閉', async ($, on) => {
  fakeEngine(on, [])
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).toContain('"label":"サイドパネルの開閉"')
  await ui.unmount()
})

test('the band yields to a survey', async ($, on) => {
  fakeEngine(on, [])
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^engine$/ })).toBeDefined()
  expect(await ui.find({ key: 'panel-toggle' })).toBeUndefined()
  await ui.unmount()
})
