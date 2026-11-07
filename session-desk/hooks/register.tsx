import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Tab } from '../types'
import { actionOf, decideAnswer, remember } from './branch'
import type { Action, Step } from './branch'
import { renderBranchTab } from './branch-view'
import { collect, enrich, replaceIfSame } from './git'
import type { Run, Snapshot } from './git'
import {
  DEFAULT_QUICK,
  addQuick,
  moveQuick,
  parseQuick,
  preview,
  removeQuick,
  stripControl,
} from './lib'
import { around, createRefresher, ghDelayMs, wantsGh } from './refresh'

const PANE = 'session-desk'
const STORE_KEY = 'quick'

// 状態は、このモジュールの atom に持つ。形を変えるときは、shape のタグを変える。
const SHAPE = { shape: 'desk-1' } as const
const history = atom({ plugin: 'session-desk', key: 'history' } as const, [], SHAPE)
const quick = atom({ plugin: 'session-desk', key: 'quick' } as const, [...DEFAULT_QUICK], SHAPE)
const tab = atom({ plugin: 'session-desk', key: 'tab' } as const, 'quick' as Tab)
const selected = atom({ plugin: 'session-desk', key: 'selected' } as const, null as number | null)
const snapshot = atom({ plugin: 'session-desk', key: 'snapshot' } as const, null as Snapshot | null)
const branchSel = atom({ plugin: 'session-desk', key: 'branchSel' } as const, null as string | null)
// yes/no の状態。dismissed: 答え済みの質問の key、confirm: 削除の 2 段目の確認中の key。
const branchAct = atom({ plugin: 'session-desk', key: 'branchAct' } as const, { dismissed: [] as string[], confirm: null as string | null })

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'quick', label: '定型文' },
  { id: 'history', label: '履歴' },
  { id: 'branch', label: 'ブランチ' },
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

// ブランチタブの更新の状態。`$` は変数に入れられないので、`$` の見える session.start で予約を作り、ここに置く。
type Desk = {
  refresher: { request(withGh: boolean): void } | null
  timer: { cancel(): void } | null
  ghNextAt: number
  ghFailures: number
  failed: boolean
}

const runOf = ($: any): Run => argv => $.process.run(argv, { timeoutMs: 15000, env: { LC_ALL: 'C' } })

// ブランチタブが表示中のときだけ、git（と、withGh なら gh）を読んで snapshot を更新する。
async function refreshNow($: any, desk: Desk, withGh: boolean): Promise<void> {
  if ((await read($, tab)) !== 'branch') {
    return
  }
  const panes: { id: string; isPlaced: boolean }[] = await $.ui.panes()
  if (!panes.some(pane => pane.id === PANE && pane.isPlaced)) {
    return
  }
  const cwd: string = await $.session.cwd()
  const prev = (await read($, snapshot)) as Snapshot | null
  // 作業フォルダが変わったら、前のリポジトリの表示と、gh の後退間隔を捨てて、gh も読み直す。
  const moved = prev !== null && prev.cwd !== cwd
  if (moved) {
    desk.ghFailures = 0
    desk.ghNextAt = 0
    await update($, snapshot, () => null)
    await update($, branchAct, () => ({ dismissed: [], confirm: null }))
  }
  const readGh = withGh || moved
  const collected = await collect(runOf($), moved ? null : prev, {
    withGh: readGh,
    cwd,
    selected: await read($, branchSel),
    now: () => new Date(),
  })
  if ((await $.session.cwd()) !== cwd) {
    return
  }
  if (readGh) {
    desk.ghFailures = collected.ghProblem ? desk.ghFailures + 1 : 0
    desk.ghNextAt = Date.now() + ghDelayMs(desk.ghFailures)
  }
  // 選んだブランチがなくなったら、選択を外して、チェックアウト中のブランチに戻す。
  // 取得のあいだに選び直されることがあるので、選択は取得のあとで読む。
  const chosen = await read($, branchSel)
  const gone = chosen !== null && !collected.branches.some(b => b.name === chosen)
  if (gone) {
    await update($, branchSel, () => null)
  }
  const current = collected.branches.find(b => b.isCurrent)
  const target = gone || chosen === null ? current?.name : chosen
  const next = target === undefined ? collected : await enrich(runOf($), collected, target)
  // 削除の 2 段目の確認は、同じ質問のあいだだけ有効にする（状態が進んだら、1 段目に戻す）。
  // 質問は、PR を引き直したあとの現在ブランチ（next）から作る。
  const nowCurrent = next.branches.find(b => b.isCurrent)
  const askedKey = nowCurrent === undefined ? null : (actionOf(nowCurrent)?.key ?? null)
  await update($, branchAct, state => (state.confirm === null || state.confirm === askedKey ? state : { ...state, confirm: null }))
  await update($, snapshot, () => next)
}

async function selectBranch($: any, desk: Desk, name: string) {
  const before = await read($, branchSel)
  await update($, branchSel, () => name)
  // ほかのブランチへ移ったら、削除の 2 段目の確認は 1 段目に戻す（同じブランチを押し直したときは戻さない）。
  if (before !== name) {
    await update($, branchAct, state => ({ ...state, confirm: null }))
  }
  const snap = (await read($, snapshot)) as Snapshot | null
  if (snap !== null) {
    const next = await enrich(runOf($), snap, name)
    // 取得のあいだに別のブランチが選ばれていたら、古い結果は書かない（選び直した側が取る）。
    if ((await read($, branchSel)) !== name) {
      return
    }
    let replaced = false
    await update($, snapshot, cur => {
      const result = replaceIfSame(cur as Snapshot | null, snap, next)
      replaced = result === next

      return result
    })
    // 取得のあいだに別の更新が入っていたら、日時が抜けないように、読み直す。
    if (!replaced) {
      desk.refresher?.request(false)
    }
  }
}

// 「はい」「いいえ」を答える。「はい」は Claude に依頼を送る（削除だけ、確認を 2 段にする）。
// 押下が古い・二度押しのときは、decideAnswer が何もしないと決める。
async function answerAction($: any, action: Action, step: Step) {
  const now = await read($, branchAct)
  const snap = (await read($, snapshot)) as Snapshot | null
  const decision = decideAnswer(step, action, now.dismissed, now.confirm, snap?.branches.find(b => b.isCurrent))
  if (decision === 'ignore') {
    return
  }
  if (decision === 'confirm') {
    await update($, branchAct, state => ({ ...state, confirm: action.key }))

    return
  }
  await update($, branchAct, state => ({ dismissed: remember(state.dismissed, action.key, 20), confirm: null }))
  if (decision === 'send') {
    // 送れなかったときは、確認が消えただけで終わらないように、知らせる。
    $.prompt.submit({ text: action.prompt }).catch(() => {
      void $.ui.toast('依頼を送れませんでした')
      // 押し直せるように、答え済みの記録を外す。
      void update($, branchAct, state => ({ ...state, dismissed: state.dismissed.filter(k => k !== action.key) }))
    })
  }
}

async function selectTab($: any, desk: Desk, id: Tab) {
  await update($, tab, () => id)
  if (id === 'branch') {
    // gh が失敗して間隔が延びている間は、タブを押しても gh は読み直さない（git は読み直す）。
    desk.refresher?.request(desk.ghFailures === 0 || Date.now() >= desk.ghNextAt)
  }
}

export const register: Register = on => {
  const desk: Desk = { refresher: null, timer: null, ghNextAt: 0, ghFailures: 0, failed: false }

  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    if (!['Bash', 'Edit', 'Write'].includes(tool)) {
      return next(e)
    }
    const command = tool === 'Bash' ? String((e as { command?: unknown }).command ?? '') : ''

    return around(() => next(e), () => desk.refresher?.request(wantsGh(command)))
  })

  on('session.start', async ($, e, next) => {
    desk.timer?.cancel()
    desk.refresher = createRefresher({
      // 更新が例外で止まったときは、「読み込み中」のまま黙らないように、1 回だけ知らせる。
      run: withGh =>
        refreshNow($, desk, withGh).then(
          () => {
            desk.failed = false
          },
          () => {
            if (!desk.failed) {
              desk.failed = true
              void $.ui.toast('ブランチタブを更新できませんでした')
            }
          },
        ),
      now: () => Date.now(),
      delay: ms => $.clock.sleep(ms),
    })
    try {
      desk.timer = $.clock.every(10_000, () => {
        desk.refresher?.request(Date.now() >= desk.ghNextAt)
      })
    } catch {
      // タイマーを作れなくても、ツール実行後の更新と、タブを押したときの更新は動く。
    }
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
    } else if (current === 'branch') {
      const act = await read($, branchAct)
      body = renderBranchTab(
        { Box, Text, Button },
        {
          snapshot: (await read($, snapshot)) as Snapshot | null,
          selected: await read($, branchSel),
          columns: e.props.bodyColumns,
          offsetMin: -new Date().getTimezoneOffset(),
          onSelect: name => void selectBranch($, desk, name),
          act: {
            dismissed: act.dismissed,
            confirm: act.confirm,
            onYes: action => void answerAction($, action, 'yes'),
            onNo: action => void answerAction($, action, 'no'),
            onConfirm: action => void answerAction($, action, 'confirm'),
          },
        },
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
              <Button key={`tab-${item.id}`} plain label={`▸ ${item.label}`} onPress={() => selectTab($, desk, item.id)}>
                <Text color="suggestion">▸</Text> <Text bold>{item.label}</Text>
              </Button>
            ) : (
              <Button key={`tab-${item.id}`} plain dimColor label={item.label} onPress={() => selectTab($, desk, item.id)} />
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
