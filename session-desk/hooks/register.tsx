import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Tab } from '../types'
import {
  DEFAULT_QUICK,
  addQuick,
  moveQuick,
  parseQuick,
  preview,
  removeQuick,
  stripControl,
} from './lib'

const PANE = 'session-desk'
const STORE_KEY = 'quick'

// 状態は、このモジュールの atom に持つ。形を変えるときは、shape のタグを変える。
const SHAPE = { shape: 'desk-1' } as const
const history = atom({ plugin: 'session-desk', key: 'history' } as const, [], SHAPE)
const quick = atom({ plugin: 'session-desk', key: 'quick' } as const, [...DEFAULT_QUICK], SHAPE)
const tab = atom({ plugin: 'session-desk', key: 'tab' } as const, 'quick' as Tab)
const selected = atom({ plugin: 'session-desk', key: 'selected' } as const, null as number | null)

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'quick', label: '定型文' },
  { id: 'history', label: '履歴' },
]

// 定型文を変えたら、atom（画面）とストア（次のセッション）の両方に書く。`$` を受け取る関数は、トップレベルに置く。
async function saveQuick($: any, next: string[]) {
  await update($, quick, () => next)
  await $.store.set(STORE_KEY, next)
}

// パネルが開いていれば閉じ、閉じていれば（幅が足りず、描かれずに待っているときも）開く。
// 人の押下で開くため、端末の幅に関係なく出る。
async function togglePane($: any) {
  const isUp = (await $.ui.panes()).some((pane: { id: string; isPlaced: boolean }) => pane.id === PANE && pane.isPlaced)
  if (isUp) {
    await $.ui.close({ id: PANE })
  } else {
    await $.ui.open({ id: PANE, title: 'Session Desk' })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void $.ui.open({ id: PANE, title: 'Session Desk' }).catch(() => {})
    try {
      const saved = parseQuick(await $.store.get(STORE_KEY))
      await update($, quick, () => saved ?? [...DEFAULT_QUICK])
    } catch {
      // 保存した定型文を読めなくても、初期値で動く。
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // 履歴には、ユーザーが送ったものだけを載せる。サブエージェント宛てなど、他の送信元は載せない。
    const byUser =
      e.origin?.kind === 'composer' ||
      e.origin?.kind === 'bridge' ||
      (e.origin?.kind === 'plugin' && e.origin.name === 'session-desk')
    if (byUser && e.text.trim() !== '') {
      await update($, history, list => [...list, e.text])
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const current = await read($, tab)

    let body
    if (current === 'history') {
      const sent = await read($, history)
      const phrases = await read($, quick)
      const chosen = await read($, selected)
      body = (
        <Box flexDirection="column" gap={1}>
          {sent.length === 0 && <Text dimColor>なし</Text>}
          {sent
            .map((text, i) => ({ text, n: i + 1 }))
            .reverse()
            .map(({ text, n }) => {
              // 開いているかの判定は 1 回にして、label と見た目で食い違わないようにする。
              const isOpen = chosen === n
              const mark = isOpen ? '▴' : '▾'
              const word = isOpen ? '短く' : '全文'

              return (
                <Box flexDirection="column">
                  <Text>{`${n}. ${isOpen ? stripControl(text) : preview(text)}`}</Text>
                  <Box gap={2}>
                    <Button
                      key={`history-${n}`}
                      plain
                      label={`${mark} ${word}`}
                      onPress={() => update($, selected, now => (now === n ? null : n))}
                    >
                      <Text color="suggestion">{`${mark} ${word}`}</Text>
                    </Button>
                    <Button
                      key={`history-add-${n}`}
                      plain
                      label="＋ 定型文に追加"
                      onPress={() => saveQuick($, addQuick(phrases, text))}
                    >
                      <Text color="suggestion">＋ 定型文に追加</Text>
                    </Button>
                  </Box>
                </Box>
              )
            })}
        </Box>
      )
    } else {
      const phrases = await read($, quick)
      body = (
        <Box flexDirection="column" gap={1}>
          {/* 文を足すと key が変わって作り直され、入力欄が空になる。足せなかったとき（空・重複）は、入力した文が残る。 */}
          <Input
            key={`quick-new-${phrases.length}`}
            placeholder="新しい定型文を入力して Enter"
            submitLabel="追加"
            onSubmit={value => {
              const next = addQuick(phrases, value)
              if (next.length !== phrases.length) {
                void saveQuick($, next)
              }
            }}
          />
          {phrases.length === 0 && <Text dimColor>なし</Text>}
          {phrases.map((text, i) => (
            <Box flexDirection="column">
              <Text>{stripControl(text)}</Text>
              <Box gap={2}>
                <Button
                  key={`quick-${i}`}
                  plain
                  label="▶ 送信"
                  onPress={() => {
                    void $.prompt.submit({ text })
                  }}
                >
                  <Text color="suggestion">▶ 送信</Text>
                </Button>
                {i > 0 && (
                  <Button
                    key={`quick-up-${i}`}
                    plain
                    label="▲ 上へ"
                    onPress={() => saveQuick($, moveQuick(phrases, i, -1))}
                  >
                    <Text dimColor>▲ 上へ</Text>
                  </Button>
                )}
                {i < phrases.length - 1 && (
                  <Button
                    key={`quick-down-${i}`}
                    plain
                    label="▼ 下へ"
                    onPress={() => saveQuick($, moveQuick(phrases, i, 1))}
                  >
                    <Text dimColor>▼ 下へ</Text>
                  </Button>
                )}
                <Button
                  key={`quick-del-${i}`}
                  plain
                  label="× 削除"
                  onPress={() => saveQuick($, removeQuick(phrases, i))}
                >
                  <Text color="error">× 削除</Text>
                </Button>
              </Box>
            </Box>
          ))}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box gap={2}>
          {TABS.map(item =>
            current === item.id ? (
              <Button key={`tab-${item.id}`} plain label={`▸ ${item.label}`} onPress={() => update($, tab, () => item.id)}>
                <Text color="suggestion">▸</Text> <Text bold>{item.label}</Text>
              </Button>
            ) : (
              <Button key={`tab-${item.id}`} plain dimColor label={item.label} onPress={() => update($, tab, () => item.id)} />
            ),
          )}
        </Box>
        {body}
      </Box>
    )
  })

  // 入力欄の上のバンド: パネルの開閉ボタン 1 つ。アンケート中は出さない。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Button } = $.ui.resolve(e)

    return (
      <Box>
        <Button key="panel-toggle" label="サイドパネルの開閉" onPress={() => togglePane($)} />
      </Box>
    )
  })
}
