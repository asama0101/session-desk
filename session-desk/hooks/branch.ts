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
  // origin があるか。なければ、push 以降の段階は対象外（skipped）。
  hasRemote: boolean
  // origin の同名ブランチとの差。ahead: origin にまだない commit、behind: origin だけにある commit。差がない・origin にない・不明のときは null。
  originDiff: { ahead: number; behind: number } | null
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

// 変更のあるパスの数。改名・コピーの項目は、直後の NUL 区切りに旧パスが続くので、それは数えない。
export function parseDirtyCount(porcelainZ: string): number {
  const fields = porcelainZ.split('\0')
  let count = 0
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i] ?? ''
    if (entry === '') {
      continue
    }
    count++
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      i++
    }
  }

  return count
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

export type BranchRow = {
  name: string
  kind: Kind
  isCurrent: boolean
  facts: Facts
  stages: Stage[]
  now: Now
}

const LABELS = ['ブランチを切る', '編集', 'commit', 'push', 'PR', 'レビュー', 'マージ', '削除'] as const

function statusesOf(f: Facts): Status[] {
  const pr = f.pr
  const merged = pr?.state === 'MERGED'
  const yes = (cond: boolean): Status => (cond ? 'done' : 'todo')

  const s1: Status = 'done'
  let s2: Status
  let s3: Status
  let s4: Status
  if (merged) {
    s2 = 'done'
    s3 = f.dirty === true ? 'todo' : 'done'
    s4 = 'done'
  } else {
    const noBase = f.ahead === null || f.dirty === null
    s2 = noBase ? 'unknown' : yes((f.ahead ?? 0) > 0 || f.dirty === true)
    s3 = noBase ? 'unknown' : yes((f.ahead ?? 0) > 0 && f.dirty === false)
    s4 = f.ahead === null || f.pushed === null ? 'unknown' : yes(f.pushed)
  }

  let s5: Status
  let s6: Status
  let s7: Status
  if (merged) {
    s5 = s6 = s7 = 'done'
  } else if (!f.prKnown) {
    s5 = s6 = s7 = 'unknown'
  } else {
    s5 = yes(pr !== null && pr.state !== 'CLOSED')
    s7 = 'todo'
    if (pr === null || pr.state !== 'OPEN' || pr.isDraft) {
      s6 = 'todo'
    } else if (pr.reviewDecision === 'APPROVED') {
      s6 = 'done'
    } else {
      s6 = pr.reviewDecision === '' ? 'skipped' : 'todo'
    }
  }
  let s8: Status = !merged && (s5 === 'unknown' || s6 === 'unknown' || s7 === 'unknown') ? 'unknown' : 'todo'

  if (!merged && !f.hasRemote) {
    // リモートがなければ、push 以降は対象外。比較の基準が決まらないときだけ、段階 4 は不明のまま。
    s4 = f.ahead === null ? 'unknown' : 'skipped'
    s5 = s6 = s7 = s8 = 'skipped'
  }

  return [s1, s2, s3, s4, s5, s6, s7, s8]
}

export function computeStages(f: Facts): Stage[] {
  const pr = f.pr
  const reviewedAt = (pr?.latestReviews ?? []).map(r => r.submittedAt).sort().pop() ?? null
  const dates: (string | null)[] = [
    f.createdAt,
    f.firstCommitAt,
    f.lastCommitAt,
    f.pushedAt,
    pr?.createdAt ?? null,
    reviewedAt,
    pr?.mergedAt ?? null,
    null,
  ]

  return statusesOf(f).map((status, i) => ({
    id: i + 1,
    label: LABELS[i] as string,
    status,
    at: status === 'done' ? (dates[i] ?? null) : null,
    note: i === 2 && status === 'done' && (f.ahead ?? 0) >= 1 ? `${f.ahead} 件` : null,
  }))
}

export function nowOf(stages: readonly Stage[], f: Facts): Now {
  if (f.pr?.state !== 'MERGED' && (f.ahead === null || f.dirty === null)) {
    return { id: null, text: '今: 判定できない' }
  }
  const stage = stages.find(s => s.status === 'todo')
  if (stage === undefined) {
    return { id: null, text: f.hasRemote ? '今: PR 以降は不明' : 'commit 済み（リモートなし）' }
  }
  const pr = f.pr
  const texts: Record<number, string> = {
    2: '次: 編集',
    3: '編集中',
    4: '次: push',
    5: pr?.state === 'CLOSED' ? '次: PR を作り直す' : '次: PR を作る',
    6: pr?.isDraft ? '次: 草稿を解除する' : pr?.reviewDecision === 'CHANGES_REQUESTED' ? '次: 指摘を直す' : '次: レビューを待つ',
    7: 'マージ待ち',
    8: '次: ブランチを削除',
  }

  return { id: stage.id, text: texts[stage.id] ?? '' }
}

export function buildRow(name: string, kind: Kind, isCurrent: boolean, facts: Facts): BranchRow {
  if (kind === 'default') {
    return { name, kind, isCurrent, facts, stages: [], now: { id: null, text: '既定' } }
  }
  const stages = computeStages(facts)

  return { name, kind, isCurrent, facts, stages, now: nowOf(stages, facts) }
}

export function parsePrList(json: string): Pr[] | null {
  try {
    const value: unknown = JSON.parse(json)

    return Array.isArray(value) ? (value as Pr[]) : null
  } catch {
    return null
  }
}

const newestFirst = (a: Pr, b: Pr) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)

// prs は、同じブランチ名の PR。OPEN を優先し、なければ、ローカルの先頭と関係のある MERGED・CLOSED の最新を採る。
export function adoptPr(prs: readonly Pr[], relation: (pr: Pr) => Relation): { pr: Pr | null; known: boolean } {
  const own = prs.filter(p => !p.isCrossRepository)
  const open = own.filter(p => p.state === 'OPEN').sort(newestFirst)[0]
  if (open !== undefined) {
    return { pr: open, known: true }
  }
  const closed = own.filter(p => p.state !== 'OPEN')
  const related = closed.filter(p => ['same', 'ancestor'].includes(relation(p))).sort(newestFirst)[0]
  if (related !== undefined) {
    return { pr: related, known: true }
  }

  return { pr: null, known: !closed.some(p => relation(p) === 'unknown') }
}

export type Remote = { name: string; url: string }

// 画面に出す URL。スキームと末尾の .git を落とし、ユーザー名やトークン（user:token@）は必ず除く。
export function tidyUrl(url: string): string {
  let rest = url.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(rest)) {
    rest = rest.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^/]*@/, '')
  } else {
    const scp = /^[^/@:]+@([^/:]+):(.+)$/.exec(rest)
    if (scp !== null) {
      rest = `${scp[1]}/${(scp[2] as string).replace(/^\/+/, '')}`
    }
  }

  return rest.replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/, '')
}

// `git remote -v` の出力から、名前と URL を、現れた順に取る。URL が空のリモートも落とさない。
export function parseRemotes(stdout: string): Remote[] {
  const found: Remote[] = []
  for (const line of linesOf(stdout)) {
    const match = /^(\S+)\t(.*?)(?: \((fetch|push)\))?$/.exec(line.replace(/\r$/, ''))
    if (match === null || match[3] === 'push' || found.some(r => r.name === match[1])) {
      continue
    }
    const url = tidyUrl(match[2] as string)
    found.push({ name: match[1] as string, url: url === '' ? '（URL なし）' : url })
  }

  return found
}

// 「次へ進む」ボタン。いまチェックアウトしているブランチの「今」が commit・push・PR・削除のとき、その段階の行に出す。
// 押すと、prompt を Claude に送る（確認は挟まない）。マージとレビューは人の番なので、ボタンはない。
export type Next = {
  // 同じ状態では同じ値。状態が進む（段階か commit 数が変わる）と変わる。二度押しを止める目印。
  key: string
  // ボタンの文字（例: ▶ push する）
  label: string
  prompt: string
}

export function nextOf(row: BranchRow, base: string | null = null): Next | null {
  if (!row.isCurrent || row.kind === 'default') {
    return null
  }
  const key = `${row.name}:${row.now.id}:${row.facts.ahead}`
  switch (row.now.id) {
    case 3:
      // マージ済みのブランチに commit は促さない。
      return row.facts.dirty === true && row.facts.pr?.state !== 'MERGED'
        ? { key, label: '▶ commit する', prompt: `ブランチ「${row.name}」の未コミットの変更を commit してください` }
        : null
    case 4:
      // origin のほうが進んでいるときは、push を促さない（先に取り込みが要る）。
      return (row.facts.originDiff?.behind ?? 0) > 0 ? null : { key, label: '▶ push する', prompt: `ブランチ「${row.name}」を push してください` }
    case 5:
      // push の状態が不明なときは、PR を促さない。
      return row.facts.pushed === null
        ? null
        : { key, label: '▶ PR を作る', prompt: `ブランチ「${row.name}」の PR を${base === null ? '既定ブランチ' : ` ${base} `}向けに作ってください` }
    case 8:
      return { key, label: '▶ ブランチを削除', prompt: `マージ済みの作業ブランチ「${row.name}」を削除してください` }
    default:
      return null
  }
}
