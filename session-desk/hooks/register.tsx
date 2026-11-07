import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Tab } from '../types'
import { addTool, BRANCH_COLOR, classifyCategory, ICONS, compactIn, forkPrompt, limitRows, nextAgentsOpen, parseForkReply, OFF_COLOR, removeTool, startTurn, summarizeAgents, toolLabel } from './band'
import type { AgentRow, CategoryId } from './band'
import { renderBand } from './band-view'
import type { BandArgs } from './band-view'
import { renderBranchTab } from './branch-view'
import { renderMore, shownCount } from './more'
import type { Next } from './branch'
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
// 一覧の「もっと見る」を開いているか。タブごと。
// 「リリースしますか」で「今はしない」を押した状態の key。状態（最新のタグ・未リリースの数）が変わると、また出る。
const releaseSkip = atom({ plugin: 'session-desk', key: 'releaseSkip' } as const, null as string | null)
// 「今はしない」を押したブランチ（リリースの段階を飛ばす）。
const releaseSkipped = atom({ plugin: 'session-desk', key: 'releaseSkipped' } as const, [] as string[])
const more = atom({ plugin: 'session-desk', key: 'more' } as const, { quick: false, history: false, git: false })
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
    recommended: null as number | null,
    turnId: null as string | null,
  },
)
const usageView = atom(
  { plugin: 'session-desk', key: 'usageView' } as const,
  {
    model: null as string | null,
    // 今のモデルの effort（/config の行から読む。読めなければ null）と、セッションのディレクトリ。
    effort: null as string | null,
    cwd: null as string | null,
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
    // 「正確に数える」の内訳を出しているか。真のあいだは、概算の取得で breakdown を上書きしない。次の turn.start で戻す。
    exactHeld: false,
  },
)
const agentsView = atom(
  { plugin: 'session-desk', key: 'agentsView' } as const,
  { running: 0, rows: [] as AgentRow[], open: false, startedAt: {} as Record<string, number> },
)
const bandUi = atom(
  { plugin: 'session-desk', key: 'bandUi' } as const,
  { exact: false, detail: [] as string[] },
)
// 今の effort を、読めるところから順に探す。どれも読めなければ null（見出しに effort を出さない）。
//   1. /config の行（名前に effort を含む行）
//   2. 環境変数 CLAUDE_EFFORT
//   3. 設定ファイルの effortLevel（プロジェクトの settings.local.json、settings.json、ユーザーの settings.json の順）。起動後に /effort で変えた値は、ここには載らない。
async function readEffort($: any, cwd: string | null): Promise<string | null> {
  const level = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  try {
    const rows: { key: string; label: string; value: unknown }[] = await $.config.list()
    const row = rows.find(r => /effort/i.test(r.key) || /effort/i.test(r.label))
    const found = level(row?.value)
    if (found !== null) {
      return found
    }
  } catch {
    // 次の手段へ。
  }
  try {
    const found = level(await $.env.get('CLAUDE_EFFORT'))
    if (found !== null) {
      return found
    }
  } catch {
    // 次の手段へ。
  }
  const files: string[] = []
  const slash = (path: string) => path.split(String.fromCharCode(92)).join('/')
  if (cwd !== null) {
    files.push(`${slash(cwd)}/.claude/settings.local.json`, `${slash(cwd)}/.claude/settings.json`)
  }
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? null
    const home = config === null ? ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? null) : null
    const user = config !== null ? slash(config) : home !== null ? `${slash(home)}/.claude` : null
    if (user !== null) {
      files.push(`${user}/settings.json`)
    }
  } catch {
    // ユーザーの設定は探さない。
  }
  for (const file of files) {
    try {
      const found = level(JSON.parse(await $.fs.read(file)).effortLevel)
      if (found !== null) {
        return found
      }
    } catch {
      // ファイルがない・読めない・JSON でないときは、次へ。
    }
  }

  return null
}

// 概算の取得のまとめ。running: 取得中、again: 取得中に要求が来た（終わった直後に 1 回だけ取り直す）。session.start で戻す。
const bandFetch = { running: false, again: false }
// 実行中のツールの印。呼び出しごとに 1 つ増やす。
let toolSeq = 0
// 自分の fork の印。id は走っている fork の番号（なければ null）。userSent は、fork の開始後に prompt.submit があったか（送信元は問わない）。
// fork の最中の turn.start・turn.complete・tool.call は、prompt.submit のあとの turn.start までは帯に反映しない。session.start で戻す。
const forkGuard = { seq: 0, id: null as number | null, userSent: false }
const FORK_TIMEOUT_MS = 30_000
const branchSel = atom({ plugin: 'session-desk', key: 'branchSel' } as const, null as string | null)

// タブの名前の前のアイコン。
const TAB_ICON: Record<Tab, string> = { quick: ICONS.quick, history: ICONS.history, git: ICONS.git }

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
  }
  const readGh = withGh || moved
  const collected = await collect(runOf($), moved ? null : prev, {
    withGh: readGh,
    cwd,
    selected: await read($, branchSel),
    now: () => new Date(),
    releaseSkips: await read($, releaseSkipped),
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
  await update($, snapshot, () => next)
  await refreshBand($, cwd)
}

// モデル・コンテキスト・上限・サブエージェントを読んで atom に書く。個々の失敗は握りつぶし、その項目を空にする。例外は投げない。
// exact が真のときだけ内訳を正確に数える（full）。ふだんは概算（summary）。full が失敗したときだけ偽を返す。
async function fetchBandData($: any, exact: boolean): Promise<boolean> {
  let fullOk = exact
  try {
    let usage: any = null
    try {
      usage = await $.session.usage({ breakdown: exact ? 'full' : 'summary' })
    } catch {
      // 取れなければ、コンテキストと上限は出さない。
      fullOk = false
    }
    // 正確に数えた結果に内訳が無いときも失敗として扱う（空の内訳が「正確」のまま残らないように）。
    if (exact && fullOk && !Array.isArray(usage?.context?.breakdown?.categories)) {
      fullOk = false
    }
    // 正確に数えるのに失敗したときは、概算で読み直して帯を保つ。
    if (exact && !fullOk) {
      try {
        usage = await $.session.usage({ breakdown: 'summary' })
      } catch {
        usage = null
      }
    }
    let model: string | null = null
    try {
      const name = await $.session.model()
      model = typeof name === 'string' && name !== '' ? name : null
    } catch {
      // モデル名は出さない。
    }
    let cwd: string | null = null
    try {
      const dir = await $.session.cwd()
      cwd = typeof dir === 'string' && dir !== '' ? dir : null
    } catch {
      // ディレクトリは出さない。
    }
    const effort = await readEffort($, cwd)
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
    // 正確に数えた内訳を出しているあいだは、概算の取得で内訳を上書きしない（書く時点の atom で決める）。
    await update($, usageView, cur => ({
      model,
      effort,
      cwd,
      context: percent === null ? null : { percent, tokens: typeof ctx.tokens === 'number' ? ctx.tokens : null, window: typeof ctx.window === 'number' ? ctx.window : null },
      rateLimits: Array.isArray(usage?.rateLimits) ? usage.rateLimits : [],
      exactHeld: fullOk || cur.exactHeld,
      breakdown: !fullOk && cur.exactHeld
        ? cur.breakdown
        : b === undefined || b === null || !Array.isArray(b.categories)
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
    await update($, agentsView, cur => {
      const summary = list === null ? { running: 0, rows: [] as AgentRow[] } : summarizeAgents(list, new Map(Object.entries(cur.startedAt)), Date.now())
      const opened = nextAgentsOpen({ running: cur.running, closedByUser: cur.running > 0 && !cur.open }, summary.running)

      return { ...cur, running: summary.running, rows: summary.rows, open: opened.open }
    })
  } catch {
    // atom を更新できなくても、フックを失敗させない。
  }

  return fullOk || !exact
}

// 概算の取得を 1 本にまとめる。取得中に来た要求は、終わった直後の 1 回にまとめる（古い結果が新しい結果を上書きしない）。
async function fetchSummary($: any): Promise<void> {
  if (bandFetch.running) {
    bandFetch.again = true

    return
  }
  bandFetch.running = true
  try {
    do {
      bandFetch.again = false
      await fetchBandData($, false)
    } while (bandFetch.again)
  } finally {
    bandFetch.running = false
  }
}

// 取得は待たない。フックの結果に影響させない。
function refetch($: any) {
  void fetchSummary($).catch(() => {})
}

// 10 秒ごとの更新。パネルが置かれていないときは、帯の取得をしない（Git の更新は refreshNow が自分で確かめる）。
async function tick($: any, desk: Desk): Promise<void> {
  desk.refresher?.request(Date.now() >= desk.ghNextAt)
  const panes: { id: string; isPlaced: boolean }[] = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE && pane.isPlaced)) {
    refetch($)
  }
}

// 「正確に数える」: full で 1 回だけ読み、成功しても失敗しても exact を戻す。数えている間の押下は無視する。
async function countExactly($: any) {
  let mine = false
  try {
    await update($, bandUi, v => {
      // update は書き込みが競り負けると、この関数をやり直す。書けた回の判断だけを残す。
      mine = !v.exact

      return mine ? { ...v, exact: true } : v
    })
  } catch {
    return
  }
  if (!mine) {
    return
  }
  try {
    if (!(await fetchBandData($, true))) {
      // 出せなくても、数え直しの結果には関係しない。
      void Promise.resolve()
        .then(() => $.ui.toast('正確な数え直しに失敗しました'))
        .catch(() => {})
    }
  } finally {
    await update($, bandUi, v => ({ ...v, exact: false })).catch(() => {})
  }
}

async function toggleDetail($: any, id: string) {
  await update($, bandUi, v => ({ ...v, detail: v.detail.includes(id) ? v.detail.filter(d => d !== id) : [...v.detail, id] }))
}

// サブエージェントの一覧を手で開閉する。閉じたときは、次に 0 件から増えるまで閉じたままにする。
async function toggleAgents($: any) {
  const cur = await read($, agentsView)
  await update($, agentsView, v => ({ ...v, open: !cur.open }))
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

const CATEGORY_NAMES: Record<CategoryId, string> = {
  messages: 'メッセージ',
  mcp: 'MCP',
  systemTools: 'ツール',
  systemPrompt: 'システム',
  memory: 'メモリ',
  skills: 'スキル',
  other: 'その他',
  free: '空き',
}

// 内訳の表示用の値。トークン数の多い順、空きは最後。「あと」は kind が used の合計から数える。
function breakdownArgs(bd: any, ui: { detail: string[] }, exact: boolean): BandArgs['breakdown'] {
  if (bd === null) {
    return null
  }
  const sums = new Map<CategoryId, number>()
  let used = 0
  for (const c of bd.categories as { name: string; kind: string; tokens: number }[]) {
    const id = classifyCategory({ name: c.name, kind: c.kind as 'used' | 'free' | 'buffer' | 'deferred' })
    sums.set(id, (sums.get(id) ?? 0) + c.tokens)
    used += c.kind === 'used' ? c.tokens : 0
  }
  const lists: Partial<Record<CategoryId, { name: string; tokens: number }[]>> = { mcp: bd.mcpTools, memory: bd.memoryFiles, skills: bd.skills }
  const rows = [...sums]
    .filter(([, tokens]) => tokens > 0)
    .sort(([a, x], [b, y]) => (a === 'free' ? 1 : b === 'free' ? -1 : y - x))
    .map(([id, tokens]) => {
      const list = lists[id]

      return {
        id,
        name: CATEGORY_NAMES[id],
        tokens,
        detail: list !== undefined && list.length > 0 ? [...list].sort((p, q) => q.tokens - p.tokens) : null,
        detailOpen: ui.detail.includes(id),
      }
    })

  return {
    exact,
    rows,
    compactIn: compactIn(used, bd.autoCompactThreshold, bd.isAutoCompactEnabled),
    threshold: bd.autoCompactThreshold ?? null,
  }
}

// リリースの段階の「今はしない」。そのブランチを覚えて、段階を読み直す。
async function skipRelease($: any, desk: Desk, name: string) {
  await update($, releaseSkipped, list => (list.includes(name) ? list : [...list, name])).catch(() => {})
  desk.refresher?.request(false)
}

async function selectBranch($: any, desk: Desk, name: string) {
  await update($, branchSel, () => name)
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

// ターンの終わりに 1 回だけ fork を呼び、ゴール・理由・選択肢を帯に書く。今のターンの結果でなければ捨てる。
// 失敗（未回答・例外・解けない JSON）では何も書かず、前回のゴールを残す。トーストは出さない。
async function askFork($: any, turnId: string): Promise<void> {
  const id = ++forkGuard.seq
  forkGuard.id = id
  forkGuard.userSent = false
  try {
    const prevGoal = (await read($, band)).goal
    // 費用を抑えるため、effort は low にする。
    const req = { prompt: forkPrompt(prevGoal), effort: 'low' as const }
    // 返らない fork で印が残らないように、30 秒で未回答として扱う（トーストは出さない）。
    const stop = new AbortController()
    let result: any
    try {
      result = await Promise.race([$.model.fork(req), $.clock.sleep(FORK_TIMEOUT_MS, { signal: stop.signal }).then(() => null)])
    } finally {
      stop.abort()
    }
    if (result?.isAnswered !== true) {
      return
    }
    // 結果が出る前に次のプロンプトが送られていたら、消した選択肢を戻さないように捨てる。
    if (forkGuard.id === id && forkGuard.userSent) {
      return
    }
    const got = parseForkReply(String(result.text ?? ''), prevGoal)
    await update($, band, b => (b.turnId === turnId ? { ...b, goal: got.goal, reason: got.reason, steps: got.steps, recommended: got.recommended } : b))
  } catch {
    // 選択肢が出ないだけ。
  } finally {
    if (forkGuard.id === id) {
      forkGuard.id = null
    }
  }
}

// 選択肢を押すと、その文をそのまま送る。
// 二度押しで 2 回送らないように、送る前に、書く時点の atom から選択肢を消す。
async function pickStep($: any, i: number) {
  // ダイアログが開いているあいだは、選択肢を消さずに、何も送らない。
  if (await blockedByDialog($)) {
    return
  }
  let sent: { text: string; steps: string[]; recommended: number | null; turnId: string | null } | null = null
  await update($, band, b => {
    // update は書き込みが競り負けると、この関数をやり直す。書けた回の判断だけを残す。
    sent = null
    const text = b.steps[i]
    if (text === undefined) {
      return b
    }
    sent = { text, steps: b.steps, recommended: b.recommended, turnId: b.turnId }

    return { ...b, steps: [], recommended: null }
  })
  const s = sent as { text: string; steps: string[]; recommended: number | null; turnId: string | null } | null
  if (s === null) {
    return
  }
  stepSent.push(s.text)
  $.prompt.submit({ text: s.text }).then(
    () => {
      // 自分の prompt.submit のフックが受けなかったときは、ここで履歴に載せる（二重には載せない）。
      if (takeStepSent(s.text)) {
        void update($, history, list => [...list, s.text]).catch(() => {})
      }
    },
    () => {
      takeStepSent(s.text)
      void $.ui.toast('依頼を送れませんでした')
      // 押し直せるように、同じターンのあいだなら選択肢を戻す。
      void update($, band, b => (b.turnId === s.turnId && b.steps.length === 0 ? { ...b, steps: s.steps, recommended: s.recommended } : b)).catch(() => {})
    },
  )
}

// 質問や許可の待ち（ダイアログ）が開いているか。空の文を下書きの後ろに足す呼び出しで調べる（下書きは変わらない）。
// ダイアログが入力を持っているあいだ、エンジンは refusal: 'dialog' で断る。ほかのプラグインのフックが断ったときは、理由が付かない。
// 理由が分からない断りは、入力欄を守る側（開いている）に倒す。入力欄がない（no_composer）とき、調べられないとき（呼び出しが失敗）は、開いていないとみなす。
async function dialogOpen($: any): Promise<boolean> {
  try {
    const result = await $.prompt.fill({ text: '', mode: 'append' })

    return result.isFilled === false && result.refusal !== 'no_composer'
  } catch {
    return false
  }
}

// ダイアログが開いているなら、依頼を送らずに知らせる（質問の答えと、ボタンの依頼が衝突するため）。送ってよければ偽。
async function blockedByDialog($: any): Promise<boolean> {
  if (await dialogOpen($)) {
    void Promise.resolve()
      .then(() => $.ui.toast('質問や許可の待ち中です。先に答えてください'))
      .catch(() => {})

    return true
  }

  return false
}

// 定型文を送る。
async function sendQuick($: any, text: string) {
  if (await blockedByDialog($)) {
    return
  }
  void $.prompt.submit({ text })
}

// Git タブの「次へ進む」を押す。同じ状態（key が同じ）での二度押しは、送らない。Claude が止まったら、また押せる。
let nextSentKey: string | null = null

async function pressNext($: any, next: Next) {
  // Claude が動いている間は送らない。質問や許可の待ちに依頼が割り込んで、答えが衝突するため。画面の押下が古いこともあるので、ここでも見る。
  if ((await read($, band)).state === 'running' || nextSentKey === next.key || (await blockedByDialog($))) {
    return
  }
  nextSentKey = next.key
  stepSent.push(next.prompt)
  $.prompt.submit({ text: next.prompt }).then(
    () => {
      if (takeStepSent(next.prompt)) {
        void update($, history, list => [...list, next.prompt]).catch(() => {})
      }
    },
    () => {
      takeStepSent(next.prompt)
      nextSentKey = null
      void $.ui.toast('依頼を送れませんでした')
    },
  )
}

// 選択肢から送った文のうち、まだ履歴に載せていないもの。
const stepSent: string[] = []

// 待っている文を 1 つ取り除く。あれば真。
function takeStepSent(text: string): boolean {
  const at = stepSent.indexOf(text)
  if (at >= 0) {
    stepSent.splice(at, 1)
  }

  return at >= 0
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
    // 帯に出して取り直すのは、メインのやり取りのツールだけ（サブエージェントのものと、自分の fork の最中は除く）。
    // fork の最中でも、Git の更新の要求は出す。
    const shown = forkGuard.id === null && (e as { agentId?: unknown }).agentId === undefined
    if (shown) {
      await update($, band, b => ({ ...b, run: addTool(b.run, id, tool) }))
      refetch($)
    }
    const refreshes = ['Bash', 'Edit', 'Write'].includes(tool)
    const command = tool === 'Bash' ? String((e as { command?: unknown }).command ?? '') : ''

    return around(
      () => next(e),
      () => {
        if (refreshes) {
          desk.refresher?.request(wantsGh(command))
        }
        if (shown) {
          void update($, band, b => ({ ...b, run: removeTool(b.run, id) })).catch(() => {})
        }
      },
    )
  })

  on('turn.start', async ($, e, next) => {
    if (forkGuard.id !== null) {
      // prompt.submit のあとの turn.start は、本物のターン。印を外して、ふつうに扱う。
      if (!forkGuard.userSent || e.agentId !== undefined) {
        return next(e)
      }
      forkGuard.id = null
    }
    if (e.agentId === undefined) {
      await update($, band, b => ({ ...b, state: 'running', run: startTurn(Date.now()), stop: null, steps: [], recommended: null, turnId: e.turnId }))
      // 正確に数えた内訳は、新しいターンでは古くなるので、概算に戻す。
      await update($, usageView, v => (v.exactHeld ? { ...v, exactHeld: false } : v)).catch(() => {})
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
    // 依頼のターンが終わったら、同じ状態でも「次へ進む」をもう一度押せる。
    nextSentKey = null
    if (forkGuard.id !== null) {
      return next(e)
    }
    // 開始を見ていないターンの完了（時間切れのあとに遅れて届いた fork 自身のものなど）は、本物のターンとして扱わない。
    const seenTurn = e.agentId === undefined ? (await read($, band)).turnId : null
    if (seenTurn !== null && seenTurn !== e.turnId) {
      return next(e)
    }
    if (e.agentId === undefined) {
      const tokens = (e.usage?.input_tokens ?? 0) + (e.usage?.output_tokens ?? 0)
      const stop = e.reason === 'answer' ? null : e.reason
      await update($, band, b => ({ ...b, state: 'stopped', lastTurn: { durationMs: e.durationMs, tokens }, stop }))
    }
    refetch($)
    const out = await next(e)
    // ターンの完了を遅らせないように、fork は待たない。
    if (e.agentId === undefined && e.reason === 'answer') {
      void askFork($, e.turnId).catch(() => {})
    }

    return out
  })

  on('session.start', async ($, e, next) => {
    forkGuard.id = null
    forkGuard.userSent = false
    bandFetch.running = false
    bandFetch.again = false
    // 前のセッションの正確な内訳は、「正確」のまま残さない。内訳は空にして、次の取得で概算が入る。
    await update($, usageView, v => (v.exactHeld ? { ...v, exactHeld: false, breakdown: null } : v)).catch(() => {})
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
        void tick($, desk).catch(() => {})
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
      if (e.origin?.kind === 'plugin') {
        takeStepSent(e.text)
      }
      await update($, history, list => [...list, e.text])
    }
    // 自分の fork は prompt.submit を通らないので、fork の最中の送信は、どの送信元でも本物のターンの始まり。
    if (forkGuard.id !== null && (e as { agentId?: unknown }).agentId === undefined) {
      forkGuard.userSent = true
    }
    if (byUser) {
      try {
        await update($, band, b => ({ ...b, steps: [], recommended: null }))
      } catch {
        // 選択肢が残るだけ。
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Input, Link, Text } = $.ui.resolve(e)
    const current = await read($, tab)
    const b = await read($, band)
    const u = await read($, usageView)
    const ag = await read($, agentsView)

    const opened = await read($, more)
    const toggleMore = (id: Tab) => void update($, more, v => ({ ...v, [id]: !v[id] })).catch(() => {})
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
            .slice(0, shownCount(sent.length, opened.history))
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
          {renderMore({ Text, Button }, { tab: 'history', total: sent.length, open: opened.history, onToggle: () => toggleMore('history') })}
        </Box>
      )
    } else if (current === 'git') {
      body = renderBranchTab(
        { Box, Text, Button, Link },
        {
          snapshot: (await read($, snapshot)) as Snapshot | null,
          selected: await read($, branchSel),
          columns: e.props.bodyColumns,
          offsetMin: -new Date().getTimezoneOffset(),
          onSelect: name => void selectBranch($, desk, name),
          more: { open: opened.git, onToggle: () => toggleMore('git') },
          onNext: next => void pressNext($, next),
          onSkipRelease: name => void skipRelease($, desk, name),
          release: { skippedKey: await read($, releaseSkip), onSkip: key => void update($, releaseSkip, () => key).catch(() => {}) },
          busy: b.state === 'running',
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
          {phrases.slice(0, shownCount(phrases.length, opened.quick)).map((text, i) => (
            <Box flexDirection="column">
              <Text>{stripControl(text)}</Text>
              <Box gap={2}>
                <Button
                  key={`quick-${i}`}
                  plain
                  label="▶ 送信"
                  onPress={() => {
                    void sendQuick($, text)
                  }}
                >
                  <Text color="suggestion">▶ 送信</Text>
                </Button>
                <Button
                  key={`quick-del-${i}`}
                  plain
                  label="× 削除"
                  onPress={() => saveQuick($, removeQuick(phrases, i))}
                >
                  <Text color="error">× 削除</Text>
                </Button>
                {/* 順は 送信・削除・上へ・下へ。先頭の「上へ」と末尾の「下へ」は、押せない薄い字で位置を保つ。 */}
                {i > 0 ? (
                  <Button
                    key={`quick-up-${i}`}
                    plain
                    label="▲ 上へ"
                    onPress={() => saveQuick($, moveQuick(phrases, i, -1))}
                  >
                    <Text dimColor>▲ 上へ</Text>
                  </Button>
                ) : (
                  <Text color={OFF_COLOR}>▲ 上へ</Text>
                )}
                {i < phrases.length - 1 ? (
                  <Button
                    key={`quick-down-${i}`}
                    plain
                    label="▼ 下へ"
                    onPress={() => saveQuick($, moveQuick(phrases, i, 1))}
                  >
                    <Text dimColor>▼ 下へ</Text>
                  </Button>
                ) : (
                  <Text color={OFF_COLOR}>▼ 下へ</Text>
                )}
              </Box>
            </Box>
          ))}
          {renderMore({ Text, Button }, { tab: 'quick', total: phrases.length, open: opened.quick, onToggle: () => toggleMore('quick') })}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {renderBand({ Box, Text, Button }, {
          goal: b.goal,
          run: { state: b.state, tool: toolLabel(b.run), elapsedMs: b.state === 'running' && b.run.startedAt !== null ? Date.now() - b.run.startedAt : null },
          lastTurn: b.lastTurn,
          stop: b.stop,
          agents: { running: ag.running, rows: ag.rows, open: ag.open },
          model: u.model,
          effort: u.effort,
          cwd: u.cwd,
          context: u.context === null ? null : { ...u.context, parts: partsOf(u.breakdown) },
          breakdown: breakdownArgs(u.breakdown, await read($, bandUi), u.exactHeld),
          limits: limitRows(u.rateLimits, Date.now()),
          git: await read($, bandGit),
          // 実行中は選択肢を描かない。
          steps: b.state === 'running' || b.steps.length === 0 ? null : { items: b.steps, reason: b.reason, recommended: b.recommended },
          on: { toggleAgents: () => void toggleAgents($), exact: () => void countExactly($), toggleDetail: id => void toggleDetail($, id).catch(() => {}), pick: i => void pickStep($, i).catch(() => {}) },
          between: <Box flexDirection="column">
              <Box gap={3}>
                {TABS.map(item =>
                  current === item.id ? (
                    <Button key={`tab-${item.id}`} plain label={`▸ ${item.label}`} onPress={() => selectTab($, desk, item.id)}>
                      <Text bold underline color={BRANCH_COLOR}>{`${TAB_ICON[item.id]} ${item.label}`}</Text>
                    </Button>
                  ) : (
                    <Button key={`tab-${item.id}`} plain dimColor label={item.label} onPress={() => selectTab($, desk, item.id)}>
                      <Text dimColor>{`${TAB_ICON[item.id]} ${item.label}`}</Text>
                    </Button>
                  ),
                )}
              </Box>
              <Box marginTop={1}>{body}</Box>
            </Box>,
          columns: e.props.bodyColumns,
        })}
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
