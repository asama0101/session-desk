// ブランチタブの型と、git・gh の出力の解析。エンジンには触れない純粋な関数だけを置く。

export type Kind = 'feat' | 'fix' | 'docs' | 'chore' | 'other' | 'default'
export type Status = 'done' | 'todo' | 'unknown' | 'skipped'
// ローカルの先頭と PR の headRefOid の関係。same: 一致、ancestor: ローカルの先頭が PR の先頭の祖先。
export type Relation = 'same' | 'ancestor' | 'other' | 'unknown'

export type Pr = {
  number: number
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'
  createdAt: string
  mergedAt: string | null
  headRefName: string
  headRefOid: string
  isCrossRepository: boolean
  latestReviews: { submittedAt: string }[]
}

// null は「取れなかった」。dirty: status を取れない。ahead: 比較の基準が決まらない。pushed: 確認できない。
// prKnown が偽は、gh が使えない、または取りこぼしの疑い。
export type Facts = {
  dirty: boolean | null
  ahead: number | null
  pushed: boolean | null
  createdAt: string | null
  firstCommitAt: string | null
  lastCommitAt: string | null
  pushedAt: string | null
  pr: Pr | null
  prKnown: boolean
}

export type Stage = { id: number; label: string; status: Status; at: string | null; note: string | null }
export type Now = { id: number | null; text: string }
export type RefRow = { ref: string; oid: string; date: string }

const PREFIXES = ['feat', 'fix', 'docs', 'chore'] as const

export function kindOf(name: string, defaultName: string | null): Kind {
  if (name === defaultName) {
    return 'default'
  }
  const found = PREFIXES.find(prefix => name.startsWith(`${prefix}/`))

  return found ?? 'other'
}

function linesOf(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter(line => line.trim() !== '')
}

export function parseRefs(stdout: string): RefRow[] {
  const rows: RefRow[] = []
  for (const line of linesOf(stdout)) {
    const [ref, oid, date] = line.split('\t')
    if (ref === undefined || oid === undefined || date === undefined || ref === 'refs/remotes/origin/HEAD') {
      continue
    }
    rows.push({ ref, oid, date })
  }

  return rows
}

export function parseAhead(stdout: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const line of linesOf(stdout)) {
    const [ref, counts] = line.split('\t')
    const ahead = Number((counts ?? '').split(' ')[0])
    if (ref !== undefined && counts !== undefined && Number.isInteger(ahead)) {
      map.set(ref, ahead)
    }
  }

  return map
}

export function isDirty(porcelainZ: string): boolean {
  return porcelainZ !== ''
}

export function defaultBranchOf(symbolicRef: string | null, heads: readonly string[]): string | null {
  const prefix = 'refs/remotes/origin/'
  const ref = symbolicRef?.trim() ?? ''
  if (ref.startsWith(prefix) && ref.length > prefix.length) {
    return ref.slice(prefix.length)
  }

  return ['main', 'master'].find(name => heads.includes(name)) ?? null
}

// reflog の %gd は `<名>@{日時}` の形。日時の部分を取る。
function reflogDate(selector: string): string | null {
  const match = /@\{(.+)\}$/.exec(selector.trim())

  return match?.[1] ?? null
}

export function parseCreatedAt(stdout: string): string | null {
  // 新しい順に並んでいるので、最後に出る "branch: Created" が最も古い。
  const created = linesOf(stdout).filter(line => (line.split('\t')[1] ?? '').startsWith('branch: Created'))
  const oldest = created[created.length - 1]

  return oldest === undefined ? null : reflogDate(oldest.split('\t')[0] ?? '')
}

export function parseNewestReflogDate(stdout: string): string | null {
  const first = linesOf(stdout)[0]

  return first === undefined ? null : reflogDate(first)
}

export function lastLineOf(stdout: string): string | null {
  const lines = linesOf(stdout)
  const last = lines[lines.length - 1]

  return last === undefined ? null : last.trim()
}
