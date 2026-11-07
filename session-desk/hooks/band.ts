// セッション帯の表示用の純粋な関数。エンジンにも `$` にも触れない。

import { stripControl } from './lib'

// ---- カテゴリと色 ----

export type CategoryId =
  | 'messages'
  | 'mcp'
  | 'systemTools'
  | 'systemPrompt'
  | 'memory'
  | 'skills'
  | 'other'
  | 'free'

export const CATEGORY_COLORS: Record<CategoryId, string> = {
  messages: '#61afef',
  mcp: '#c678dd',
  systemTools: '#56b6c2',
  systemPrompt: '#7ec699',
  memory: '#e5c07b',
  skills: '#d19a66',
  free: '#55555a',
  other: '#8b8b8b',
}

const USED_NAMES: Record<string, CategoryId> = {
  'System prompt': 'systemPrompt',
  'System tools': 'systemTools',
  'MCP tools': 'mcp',
  'Memory files': 'memory',
  Skills: 'skills',
  Messages: 'messages',
}

// kind と名前（完全一致）で分ける。used 以外の kind は名前を見ない。
export function classifyCategory(c: { name: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }): CategoryId {
  if (c.kind === 'free') return 'free'
  if (c.kind !== 'used') return 'other'
  return USED_NAMES[c.name] ?? 'other'
}

// ---- 整形 ----

// 使用率の色（ステータスラインと同じ境目）。60% 未満は通常（緑）、60% 以上で黄、80% 以上で赤。
export function usageColor(percent: number): 'normal' | 'warning' | 'error' {
  if (percent >= 80) return 'error'
  if (percent >= 60) return 'warning'
  return 'normal'
}

// 押せない操作の薄い字。
export const OFF_COLOR = '#555a65'

// 帯の配色。ステータスラインの配色（モデルの系統ごとに色を分け、ブランチは水色）に合わせた、暗い背景で読める明るさの色。
export const BRANCH_COLOR = '#4fd6e0'
const MODEL_COLORS: [string, string][] = [
  ['opus', '#d78bff'],
  ['sonnet', '#4fd6e0'],
  ['haiku', '#7db4ff'],
  ['fable', '#7ff0f0'],
]

// モデル名に含まれる系統名（小文字で判定）で色を分ける。どれにも当たらないときは水色。
export function modelColor(name: string): string {
  const lower = name.toLowerCase()

  return MODEL_COLORS.find(([key]) => lower.includes(key))?.[1] ?? BRANCH_COLOR
}

// 行の頭に付けるアイコン。どれも、端末で 2 桁に描かれる絵文字（Emoji_Presentation）に限る（⏸ や ☁ のような、1 桁か 2 桁か分からないものは使わない）。
export const ICONS = {
  model: '🤖',
  dir: '📁',
  goal: '🎯',
  stopped: '💤',
  running: '⚡',
  context: '📊',
  fiveHour: '⏳',
  sevenDay: '📅',
  branch: '🌿',
  quick: '💬',
  history: '🕘',
  git: '🔀',
  suggest: '💡',
  local: '💻',
  remote: '🌐',
} as const

// アイコンの幅（桁）。絵文字は 2 桁、後ろの空白が 1 桁。
export const ICON_CELLS = 3

// モデルの id（claude-sonnet-5-5 など）を、人が読む名前（Sonnet 5.5）にする。分からない形は、そのまま返す。末尾の [1m] は (1M) にする。
export function prettyModel(id: string): string {
  const ctx = /\[(\w+)\]$/.exec(id)
  const base = id.replace(/\[\w+\]$/, '')
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const ver = (major: string, minor: string | undefined) => (minor === undefined ? major : `${major}.${minor}`)
  const tail = ctx === null ? '' : ` (${(ctx[1] as string).toUpperCase()})`
  // claude-sonnet-5-5、claude-opus-4-1-20250805
  const next = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(base)
  if (next !== null) return `${cap(next[1] as string)} ${ver(next[2] as string, next[3])}${tail}`
  // 古い形: claude-3-5-sonnet-20241022
  const old = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(base)
  if (old !== null) return `${cap(old[3] as string)} ${ver(old[1] as string, old[2])}${tail}`

  return id
}

// effort の色（ステータスラインと同じ）。low は灰色、medium は通常、high は水色、xhigh は紫、max は太字の紫。
export const EFFORT_COLORS: Record<string, string | null> = { low: '#8a8f9c', medium: null, high: '#4fd6e0', xhigh: '#d78bff', max: '#d78bff' }

// 長い文字列を、末尾（いちばん大事な部分）を残して cells 桁に収める。全角は 2 桁と数える。収まらなければ、先頭を … にする。
export function fitTail(text: string, cells: number): string {
  const width = (ch: string) => ((ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1)
  const chars = [...text]
  let total = chars.reduce((sum, ch) => sum + width(ch), 0)
  if (total <= cells) return text
  let at = 0
  while (at < chars.length && total + 1 > cells) {
    total -= width(chars[at] as string)
    at++
  }

  return `…${chars.slice(at).join('')}`
}

export function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m${String(total % 60).padStart(2, '0')}s`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// 枠の残り時間。過去・不正な日付は null。
export function formatRemaining(resetsAtIso: string, nowMs: number): string | null {
  const t = Date.parse(resetsAtIso)
  if (!Number.isFinite(t) || t <= nowMs) return null
  const min = Math.floor((t - nowMs) / 60_000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${min % 60}m`
  return `${min}m`
}

// ---- バー ----

// 使用分の長さは round(percent / 100 × width)。その中を parts の比率で分け、残りは free。
// 0 より大きい項目は最小 1 マス。過不足は最大の項目で合わせる。
export function barCells(
  parts: { id: CategoryId; tokens: number }[],
  percent: number,
  width: number,
): { id: CategoryId; cells: number }[] {
  const used = Math.min(width, Math.max(0, Math.round((percent / 100) * width)))
  const total = parts.reduce((a, p) => a + p.tokens, 0)
  const out: { id: CategoryId; cells: number }[] = []
  if (used > 0 && total > 0) {
    for (const p of parts) {
      if (p.tokens > 0) out.push({ id: p.id, cells: Math.max(1, Math.round((p.tokens / total) * used)) })
    }
    const sum = out.reduce((a, c) => a + c.cells, 0)
    const biggest = out.reduce((a, c) => (c.cells > a.cells ? c : a))
    biggest.cells = Math.max(1, biggest.cells + used - sum)
  }
  const usedCells = out.reduce((a, c) => a + c.cells, 0)
  if (width - usedCells > 0) out.push({ id: 'free', cells: width - usedCells })
  return out
}

// ---- compact と枠 ----

// 自動 compact までの残りトークン。無効・閾値なしは null。
export function compactIn(tokens: number, threshold: number | undefined, enabled: boolean): number | null {
  if (!enabled || threshold === undefined) return null
  return Math.max(0, threshold - tokens)
}

export type LimitRow = { label: '5時間枠' | '7日枠'; percent: number; remaining: string | null }

const LIMIT_LABELS: Record<string, LimitRow['label']> = { five_hour: '5時間枠', seven_day: '7日枠' }

export function limitRows(
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[],
  nowMs: number,
): LimitRow[] {
  const rows: LimitRow[] = []
  for (const r of rateLimits) {
    const label = LIMIT_LABELS[r.kind]
    if (!label) continue
    rows.push({ label, percent: r.percentUsed, remaining: r.resetsAt ? formatRemaining(r.resetsAt, nowMs) : null })
  }
  return rows
}

// ---- fork の返答の解析 ----

const GOAL_MAX = 40
const REASON_MAX = 30
const STEP_MAX = 40
const STEPS_MAX = 4
const WAITING = '判断待ち'

// 制御コードを除き、空白（改行を含む）を 1 つにまとめる。
function clean(text: string): string {
  return stripControl(text).replace(/\s+/g, ' ').trim()
}

// 長すぎる値は切らずに捨てる（null）。
function fit(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = clean(value)
  return text !== '' && text.length <= max ? text : null
}

export function parseForkReply(text: string, prevGoal: string | null): { goal: string | null; reason: string; steps: string[]; recommended: number | null } {
  const broken = { goal: prevGoal, reason: WAITING, steps: [] as string[], recommended: null }
  const from = text.indexOf('{')
  const to = text.lastIndexOf('}')
  if (from < 0 || to < from) return broken
  let json: unknown
  try {
    json = JSON.parse(text.slice(from, to + 1))
  } catch {
    return broken
  }
  if (typeof json !== 'object' || json === null) return broken
  const obj = json as Record<string, unknown>
  if (typeof obj.goal !== 'string') return broken
  // 捨てた案があっても、recommended は元の並びの番号で来るので、残した案の番号に直す。
  const kept = (Array.isArray(obj.steps) ? obj.steps : [])
    .map((s, at) => ({ text: fit(s, STEP_MAX), at }))
    .filter((s): s is { text: string; at: number } => s.text !== null)
    .slice(0, STEPS_MAX)
  const rec = kept.findIndex(s => s.at === obj.recommended)

  return {
    goal: fit(obj.goal, GOAL_MAX) ?? prevGoal,
    reason: fit(obj.reason, REASON_MAX) ?? WAITING,
    steps: kept.map(s => s.text),
    recommended: rec >= 0 ? rec : null,
  }
}

// fork への指示。fork は会話ごと引き継ぐので、直前の返答は渡さない。
export function forkPrompt(prevGoal: string | null): string {
  return [
    '直前の返答について、JSON だけを返してください。説明や前置きは書かないでください。',
    '形式: {"goal": "<1行、40字以内>", "reason": "<止まった理由、30字以内>", "steps": [...], "recommended": <番号または null>}',
    `前回のゴール: ${prevGoal ?? 'なし'}`,
    'goal は、会話の目的が大きく変わったときだけ書き換え、そうでなければ前回のゴールをそのまま返す（前回のゴールがなければ新しく書く）。',
    'steps は、返答が人の判断を求めているとき（質問、案の選択、確認待ち、エラーの対処）だけ、次に頼みそうな行動を最大 4 個、1 つ 40 字以内の具体的な命令文で返す。判断が要らなければ空配列を返す。',
    'recommended は、steps のうち、あなたが勧める 1 つの番号（0 始まり）。案を比べて勧められるときだけ書き、勧める案がなければ null にする。',
    '返答にない新しい作業を足さない。',
  ].join('\n')
}

// ---- 実行状態 ----

export type RunState = { startedAt: number | null; tools: { id: number; name: string }[] }

export function startTurn(now: number): RunState {
  return { startedAt: now, tools: [] }
}

export function addTool(s: RunState, id: number, name: string): RunState {
  return { ...s, tools: [...s.tools, { id, name }] }
}

export function removeTool(s: RunState, id: number): RunState {
  return { ...s, tools: s.tools.filter(t => t.id !== id) }
}

// 最も古い 1 件の名前。2 件以上なら `名前 +n`。
export function toolLabel(s: RunState): string | null {
  if (s.tools.length === 0) return null
  const first = s.tools[0]?.name ?? ''
  return s.tools.length === 1 ? first : `${first} +${s.tools.length - 1}`
}

// ---- サブエージェント ----

export type AgentRow = {
  id: string
  type: string
  description: string
  state: 'running' | 'waiting' | 'done'
  elapsedMs: number | null
}

function agentState(status: string): AgentRow['state'] {
  if (status === 'running' || status === 'pending') return 'running'
  if (status === 'waiting' || status === 'idle') return 'waiting'
  return 'done'
}

export function summarizeAgents(
  list: { id: string; type: string; description: string; status: string }[],
  startedAt: ReadonlyMap<string, number>,
  nowMs: number,
): { running: number; rows: AgentRow[] } {
  // 完了した行は、経過時間を持たない（終わったあとも伸び続けないように）。
  const rows = list.map(a => {
    const t = startedAt.get(a.id)
    const state = agentState(a.status)
    return { id: a.id, type: a.type, description: a.description, state, elapsedMs: t === undefined || state === 'done' ? null : nowMs - t }
  })
  return { running: rows.filter(r => r.state === 'running').length, rows }
}

// 0 から 1 以上になったら開く。手で閉じたあとは、0 に戻るまで開き直さない。
export function nextAgentsOpen(
  prev: { running: number; closedByUser: boolean },
  running: number,
): { open: boolean; closedByUser: boolean } {
  if (running === 0) return { open: false, closedByUser: false }
  if (prev.running === 0) return { open: true, closedByUser: false }
  return { open: !prev.closedByUser, closedByUser: prev.closedByUser }
}
