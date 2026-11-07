import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Tab } from '../types'
import { addTool, classifyCategory, limitRows, nextAgentsOpen, removeTool, startTurn, summarizeAgents, toolLabel } from './band'
import type { AgentRow, CategoryId } from './band'
import { renderBand } from './band-view'
import { actionOf, decideAnswer, remember } from './branch'
import type { Action, Step } from './branch'
import { renderBranchTab } from './branch-view'
import { collect, collectLight, enrich, replaceIfSame } from './git'
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
const bandGit = atom({ plugin: 'session-desk', key: 'bandGit' } as const, null as { branch: string | null; dirtyCount: number | null } | null)
const band = atom(
  { plugin: 'session-desk', key: 'band' } as const,
  {
    run: { startedAt: null as number | null, tools: [] as { id: number; name: string }[] },
    state: null as 'running' | 'stopped' | null,
    lastTurn: null as { durationMs: number; tokens: number } | null,
    stop: null as 'error' | 'refusal' | 'aborted' | null,
    goal: null as string | null,
    reason: '',
    steps: [] as string[],
    confirming: null as number | null,
    turnId: null as string | null,
  },
)
const usageView = atom(
  { plugin: 'session-desk', key: 'usageView' } as const,
  {
    model: null as string | null,
    context: null as { percent: number; tokens: number | null; window: number | null } | null,
    rateLimits: [] as { kind: string; percentUsed: number; resetsAt?: string }[],
    breakdown: null as {
      categories: { name: string; kind: string; tokens: number }[]
      rawMaxTokens: number
      autoCompactThreshold?: number
      isAutoCompactEnabled: boolean
      mcpTools: { name: string; tokens: number }[]
      memoryFiles: { name: string; tokens: number }[]
      skills: { name: string; tokens: number }[]
    } | null,
  },
)
const agentsView = atom(
  { plugin: 'session-desk', key: 'agentsView' } as const,
  { running: 0, rows: [] as AgentRow[], open: false, startedAt: {} as Record<string, number> },
)
const bandUi = atom(
  { plugin: 'session-desk', key: 'bandUi' } as const,
  { breakdown: false, exact: false, agentsClosedByUser: false, detail: [] as string[] },
)
// 実行中のツールの印。呼び出しごとに 1 つ増やす。
let toolSeq = 0
const branchSel = atom({ plugin: 'session-desk', key: 'branchSel' } as const, null as string | null)
// yes/no の状態。dismissed: 答え済みの質問の key、confirm: 削除の 2 段目の確認中の key。
const branchAct = atom({ plugin: 'session-desk', key: 'branchAct' } as const, { dismissed: [] as string[], confirm: null as string | null })

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'quick', label: '定型文' },
  { id: 'history', label: '履歴' },
  { id: 'git', label: 'Git' },
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

// 今のブランチと未 commit の数を読んで bandGit に書く。読んでいるあいだに作業フォルダが変わったら捨てる。
async function refreshBand($: any, cwd: string): Promise<void> {
  const light = await collectLight(runOf($))
  if ((await $.session.cwd()) === cwd) {
    await update($, bandGit, () => (light.isRepo ? { branch: light.branch, dirtyCount: light.dirtyCount } : null))
  }
}

// パネルが表示中のときだけ読む。Git タブ以外では、今のブランチと未 commit の数だけ。Git タブでは、git（と、withGh なら gh）を読んで snapshot も更新する。
async function refreshNow($: any, desk: Desk, withGh: boolean): Promise<void> {
  const panes: { id: string; isPlaced: boolean }[] = await $.ui.panes()
  if (!panes.some(pane => pane.id === PANE && pane.isPlaced)) {
    return
  }
  if ((await read($, tab)) !== 'git') {
    await refreshBand($, await $.session.cwd())

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
  await refreshBand($, cwd)
}

// モデル・コンテキスト・上限・サブエージェントを読んで atom に書く。個々の失敗は握りつぶし、その項目を空にする。例外は投げない。
// 「正確に数える」（exact）は後続のタスクで足すので、今は常に概算（summary）で読む。
async function fetchBandData($: any, _exact: boolean): Promise<void> {
  try {
    let usage: any = null
    try {
      usage = await $.session.usage({ breakdown: 'summary' })
    } catch {
      // 取れなければ、コンテキストと上限は出さない。
    }
    let model: string | null = null
    try {
      const name = await $.session.model()
      model = typeof name === 'string' && name !== '' ? name : null
    } catch {
      // モデル名は出さない。
    }
    let list: { id: string; type: string; description: string; status: string }[] | null = null
    try {
      const got = await $.agent.list()
      list = Array.isArray(got) ? got : null
    } catch {
      // セッションに結び付いていないときは、一覧を出さない。
    }

    const ctx = usage?.context
    const percent = typeof ctx?.percent === 'number' ? ctx.percent : null
    const b = ctx?.breakdown
    await update($, usageView, () => ({
      model,
      context: percent === null ? null : { percent, tokens: typeof ctx.tokens === 'number' ? ctx.tokens : null, window: typeof ctx.window === 'number' ? ctx.window : null },
      rateLimits: Array.isArray(usage?.rateLimits) ? usage.rateLimits : [],
      breakdown:
        b === undefined || b === null || !Array.isArray(b.categories)
          ? null
          : {
              categories: b.categories.map((c: any) => ({ name: String(c.name), kind: String(c.kind), tokens: Number(c.tokens) || 0 })),
              rawMaxTokens: b.rawMaxTokens,
              autoCompactThreshold: b.autoCompactThreshold,
              isAutoCompactEnabled: b.isAutoCompactEnabled === true,
              // 1 件ずつの名前: MCP ツールは「サーバー / ツール」、メモリファイルは path、スキルは name。
              mcpTools: (b.mcpTools ?? []).map((t: any) => ({ name: `${t.serverName} / ${t.name}`, tokens: Number(t.tokens) || 0 })),
              memoryFiles: (b.memoryFiles ?? []).map((f: any) => ({ name: String(f.path), tokens: Number(f.tokens) || 0 })),
              skills: (b.skills?.skillFrontmatter ?? []).map((k: any) => ({ name: String(k.name), tokens: Number(k.tokens) || 0 })),
            },
    }))

    // 重なった取得や手での開閉と競らないように、次の値は書く時点の atom から作る。手で閉じた状態（open が偽）が勝つ。
    let closed = false
    await update($, agentsView, cur => {
      const summary = list === null ? { running: 0, rows: [] as AgentRow[] } : summarizeAgents(list, new Map(Object.entries(cur.startedAt)), Date.now())
      const opened = nextAgentsOpen({ running: cur.running, closedByUser: cur.running > 0 && !cur.open }, summary.running)
      closed = summary.running > 0 && !opened.open

      return { ...cur, running: summary.running, rows: summary.rows, open: opened.open }
    })
    await update($, bandUi, cur => ({ ...cur, agentsClosedByUser: closed }))
  } catch {
    // atom を更新できなくても、フックを失敗させない。
  }
}

// 取得は待たない。フックの結果に影響させない。
function refetch($: any) {
  void fetchBandData($, false).catch(() => {})
}

// サブエージェントの一覧を手で開閉する。閉じたときは、次に 0 件から増えるまで閉じたままにする。
async function toggleAgents($: any) {
  const cur = await read($, agentsView)
  await update($, agentsView, v => ({ ...v, open: !cur.open }))
  await update($, bandUi, v => ({ ...v, agentsClosedByUser: cur.open }))
}

// 内訳のカテゴリを、帯の色分けの区分ごとに合計する（空きは除く）。
function partsOf(breakdown: { categories: { name: string; kind: string; tokens: number }[] } | null): { id: CategoryId; tokens: number }[] {
  const sums = new Map<CategoryId, number>()
  for (const c of breakdown?.categories ?? []) {
    const id = classifyCategory({ name: c.name, kind: c.kind as 'used' | 'free' | 'buffer' | 'deferred' })
    if (id !== 'free') {
      sums.set(id, (sums.get(id) ?? 0) + c.tokens)
    }
  }

  return [...sums].map(([id, tokens]) => ({ id, tokens }))
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
  if (id === 'git') {
    // gh が失敗して間隔が延びている間は、タブを押しても gh は読み直さない（git は読み直す）。
    desk.refresher?.request(desk.ghFailures === 0 || Date.now() >= desk.ghNextAt)
  }
}

export const register: Register = on => {
  const desk: Desk = { refresher: null, timer: null, ghNextAt: 0, ghFailures: 0, failed: false }

  on('tool.call', async ($, e, next) => {
    const tool = e.tool as string
    const id = ++toolSeq
    // 帯に出すのはメインのやり取りのツールだけ（サブエージェントのものは除く）。
    const shown = (e as { agentId?: unknown }).agentId === undefined
    if (shown) {
      await update($, band, b => ({ ...b, run: addTool(b.run, id, tool) }))
    }
    refetch($)
    const refreshes = ['Bash', 'Edit', 'Write'].includes(tool)
    const command = tool === 'Bash' ? String((e as { command?: unknown }).command ?? '') : ''

    return around(
      () => next(e),
      () => {
        if (refreshes) {
          desk.refresher?.request(wantsGh(command))
        }
        if (shown) {
          void update($, band, b => ({ ...b, run: removeTool(b.run, id) }))
        }
      },
    )
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, band, b => ({ ...b, state: 'running', run: startTurn(Date.now()), stop: null, steps: [], confirming: null, turnId: e.turnId }))
    }
    refetch($)

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    const agentId = (out as { agentId?: string }).agentId
    if (agentId !== undefined) {
      try {
        await update($, agentsView, v => ({ ...v, startedAt: { ...v.startedAt, [agentId]: Date.now() } }))
      } catch {
        // 開始時刻を残せなくても、経過時間が出ないだけ。
      }
    }
    refetch($)

    return out
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const tokens = (e.usage?.input_tokens ?? 0) + (e.usage?.output_tokens ?? 0)
      const stop = e.reason === 'answer' ? null : e.reason
      await update($, band, b => ({ ...b, state: 'stopped', lastTurn: { durationMs: e.durationMs, tokens }, stop }))
    }
    refetch($)

    return next(e)
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
              void $.ui.toast('Git タブを更新できませんでした')
            }
          },
        ),
      now: () => Date.now(),
      delay: ms => $.clock.sleep(ms),
    })
    try {
      desk.timer = $.clock.every(10_000, () => {
        desk.refresher?.request(Date.now() >= desk.ghNextAt)
        refetch($)
      })
    } catch {
      // タイマーを作れなくても、ツール実行後の更新と、タブを押したときの更新は動く。
    }
    desk.refresher.request(false)
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
    const b = await read($, band)
    const u = await read($, usageView)
    const ag = await read($, agentsView)

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
    } else if (current === 'git') {
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
        {renderBand({ Box, Text, Button }, {
          goal: null,
          run: { state: b.state, tool: toolLabel(b.run), elapsedMs: b.state === 'running' && b.run.startedAt !== null ? Date.now() - b.run.startedAt : null },
          lastTurn: b.lastTurn,
          stop: b.stop,
          agents: { running: ag.running, rows: ag.rows, open: ag.open },
          model: u.model,
          context: u.context === null ? null : { ...u.context, parts: partsOf(u.breakdown) },
          breakdown: null,
          limits: limitRows(u.rateLimits, Date.now()),
          git: await read($, bandGit),
          steps: null,
          on: { toggleBreakdown() {}, toggleAgents: () => void toggleAgents($), exact() {}, toggleDetail() {}, pick() {}, confirm() {}, cancel() {} },
          columns: e.props.bodyColumns,
        })}
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
