// コンテキストの内訳を、帯に出す値に整える。状態は読み書きしない。

import { classifyCategory, compactIn } from './band'
import type { CategoryId } from './band'
import type { BandArgs } from './band-view'

// 内訳のカテゴリを、帯の色分けの区分ごとに合計する（空きは除く）。
export function partsOf(breakdown: { categories: { name: string; kind: string; tokens: number }[] } | null): { id: CategoryId; tokens: number }[] {
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
export function breakdownArgs(bd: any, ui: { detail: string[]; legendHidden: boolean }, exact: boolean): BandArgs['breakdown'] {
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
    legendHidden: ui.legendHidden,
    rows,
    compactIn: compactIn(used, bd.autoCompactThreshold, bd.isAutoCompactEnabled),
    threshold: bd.autoCompactThreshold ?? null,
  }
}
