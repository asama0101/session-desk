// セッション帯の表示用の純粋な関数。エンジンにも `$` にも触れない。

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

// 使用率の数字の色。80% 以上で黄、95% 以上で赤。
export function usageColor(percent: number): 'normal' | 'warning' | 'error' {
  if (percent >= 95) return 'error'
  if (percent >= 80) return 'warning'
  return 'normal'
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
    const biggest = out.reduce((a, c) => (c.cells > a.cells ? c : a), out[0])
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
