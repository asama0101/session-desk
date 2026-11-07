// git・gh を呼んで、ブランチタブの Snapshot を作る。このファイルだけが外部コマンドを呼ぶ。
import {
  adoptPr,
  buildRow,
  defaultBranchOf,
  isDirty,
  kindOf,
  lastLineOf,
  parseAhead,
  parseCreatedAt,
  parseDirtyCount,
  parseNewestReflogDate,
  parsePrList,
  parseRefs,
  parseRemotes,
} from './branch'
import type { BranchRow, Facts, Pr, Relation, Remote } from './branch'
import { stripControl } from './lib'

type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }
export type Run = (argv: string[]) => Promise<RunResult>
export type Problem = 'not-repo' | 'no-commit' | 'unsafe-owner' | 'timeout' | 'git-failed' | null

export type Snapshot = {
  cwd: string
  gitAt: string
  ghAt: string | null
  problem: Problem
  ghProblem: boolean
  prs: Pr[] | null
  prCapped: boolean
  baseRef: string | null
  // `git remote -v` の結果。取れなかったときは null。
  remotes: Remote[] | null
  branches: BranchRow[]
  warnings: string[]
}

type Detail = { createdAt: string | null; firstCommitAt: string | null; pushedAt: string | null }

const BUDGET = 30
const PR_LIMIT = 200
const PR_FIELDS =
  'number,state,isDraft,reviewDecision,createdAt,mergedAt,headRefName,headRefOid,isCrossRepository,latestReviews'

// reject（起動できない・時間切れ）は、終了コード -1 の結果にそろえる。
type Safe = RunResult & { rejected: boolean }
async function safe(run: Run, argv: string[]): Promise<Safe> {
  try {
    return { ...(await run(argv)), rejected: false }
  } catch {
    return { exitCode: -1, stdout: '', stderr: '', isStdoutTruncated: false, rejected: true }
  }
}

const git = (run: Run, ...args: string[]) => safe(run, ['git', '--no-optional-locks', ...args])
const usable = (r: Safe) => r.exitCode === 0 && !r.isStdoutTruncated

const clock = (d: Date) => d.toTimeString().slice(0, 8)

function emptySnapshot(cwd: string, gitAt: string, problem: Problem, warnings: string[] = []): Snapshot {
  return { cwd, gitAt, ghAt: null, problem, ghProblem: false, prs: null, prCapped: false, baseRef: null, remotes: null, branches: [], warnings }
}

// 現在のブランチ、選択中のブランチ、残りは名前順に並べて、先頭 limit 件。
export function pickBudget(names: readonly string[], current: string | null, selected: string | null, limit: number): string[] {
  const rest = names.filter(n => n !== current && n !== selected).sort()
  const first = [current, selected].filter((n, i, all): n is string => n !== null && names.includes(n) && all.indexOf(n) === i)

  return [...first, ...rest].slice(0, limit)
}

async function countOf(run: Run, range: string): Promise<number | null> {
  const r = await git(run, 'rev-list', '--count', range)
  const n = Number(r.stdout.trim())

  return usable(r) && Number.isInteger(n) ? n : null
}

// right にあって left にない commit 数（ahead）と、その逆（behind）を、1 回で数える。
async function diffOf(run: Run, left: string, right: string): Promise<{ ahead: number; behind: number } | null> {
  const r = await git(run, 'rev-list', '--left-right', '--count', `${left}...${right}`)
  const [behind, ahead] = r.stdout.trim().split(/\s+/).map(Number)
  if (!usable(r) || behind === undefined || ahead === undefined || !Number.isInteger(behind) || !Number.isInteger(ahead)) {
    return null
  }

  return { ahead, behind }
}

// ローカルの先頭 tip と PR の先頭の関係。ローカルの先頭と一致すれば、プロセスを使わずに same。
function sameOrOther(prs: readonly Pr[], tip: string): Map<number, Relation> {
  return new Map(prs.filter(p => p.state !== 'OPEN').map(p => [p.number, p.headRefOid === tip ? 'same' : 'other'] as const))
}

// PR の先頭が、基準（origin の既定ブランチ）に入っているか。入っていれば、merge commit でマージされている。
async function isInBase(run: Run, oid: string, baseRef: string): Promise<boolean> {
  const r = await git(run, 'merge-base', '--is-ancestor', oid, baseRef)

  return !r.rejected && r.exitCode === 0
}

async function ancestry(run: Run, ref: string, oid: string): Promise<Relation> {
  const r = await git(run, 'merge-base', '--is-ancestor', ref, oid)
  if (r.rejected) {
    return 'unknown'
  }

  return r.exitCode === 0 ? 'ancestor' : r.exitCode === 1 ? 'other' : 'unknown'
}

const newestClosed = (prs: readonly Pr[]) =>
  prs.filter(p => p.state !== 'OPEN' && !p.isCrossRepository).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]

export async function collect(
  run: Run,
  prev: Snapshot | null,
  opts: { withGh: boolean; cwd: string; selected: string | null; now: () => Date },
): Promise<Snapshot> {
  const gitAt = clock(opts.now())
  const repo = await git(run, 'rev-parse', '--git-dir')
  if (repo.rejected) {
    return emptySnapshot(opts.cwd, gitAt, 'timeout')
  }
  if (repo.exitCode !== 0) {
    return emptySnapshot(opts.cwd, gitAt, repo.stderr.includes('dubious ownership') ? 'unsafe-owner' : 'not-repo')
  }

  const [sym, head, status, refsRes, remoteRes] = await Promise.all([
    git(run, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD'),
    git(run, 'symbolic-ref', '-q', 'HEAD'),
    git(run, 'status', '--porcelain=v1', '-z'),
    git(run, 'for-each-ref', '--format=%(refname)%09%(objectname)%09%(committerdate:iso-strict)', 'refs/heads', 'refs/remotes/origin'),
    git(run, 'remote', '-v'),
  ])
  if (refsRes.rejected) {
    return emptySnapshot(opts.cwd, gitAt, 'timeout')
  }
  if (refsRes.isStdoutTruncated) {
    return emptySnapshot(opts.cwd, gitAt, null, ['ブランチ一覧が長すぎます'])
  }
  if (refsRes.exitCode !== 0) {
    return emptySnapshot(opts.cwd, gitAt, 'git-failed')
  }
  const rows = parseRefs(refsRes.stdout)
  const HEADS = 'refs/heads/'
  const ORIGIN = 'refs/remotes/origin/'
  const locals = rows.filter(r => r.ref.startsWith(HEADS))
  if (locals.length === 0) {
    return emptySnapshot(opts.cwd, gitAt, 'no-commit')
  }
  const oidOf = new Map(locals.map(r => [r.ref.slice(HEADS.length), r]))
  const origin = new Map(rows.filter(r => r.ref.startsWith(ORIGIN)).map(r => [r.ref.slice(ORIGIN.length), r.oid]))
  const heads = [...oidOf.keys()]

  const defaultName = defaultBranchOf(usable(sym) ? sym.stdout : null, heads)
  const baseRef =
    defaultName === null ? null : origin.has(defaultName) ? `${ORIGIN}${defaultName}` : oidOf.has(defaultName) ? `${HEADS}${defaultName}` : null
  const currentName = head.exitCode === 0 && head.stdout.trim().startsWith(HEADS) ? head.stdout.trim().slice(HEADS.length) : null
  const dirty = usable(status) ? isDirty(status.stdout) : null
  // 取れなかったときは、origin があるものとして判定する（ないと言い切らない）。
  const remotes = usable(remoteRes) ? parseRemotes(remoteRes.stdout) : null
  const hasRemote = remotes === null ? true : remotes.some(r => r.name === 'origin')

  let aheadMap: Map<string, number> | null = null
  if (baseRef !== null) {
    const a = await git(run, 'for-each-ref', `--format=%(refname)%09%(ahead-behind:${baseRef})`, 'refs/heads')
    aheadMap = usable(a) ? parseAhead(a.stdout) : null
  }

  const warnings: string[] = []
  if (head.exitCode === 1) {
    warnings.push('HEAD は分離状態')
  }
  if (defaultName !== null && currentName === defaultName && dirty === true) {
    warnings.push('既定ブランチ上に未 commit の変更があります')
  }
  let defaultDiff: Facts['originDiff'] = null
  if (hasRemote && defaultName !== null && origin.has(defaultName) && oidOf.has(defaultName)) {
    const d = await diffOf(run, `${ORIGIN}${defaultName}`, `${HEADS}${defaultName}`)
    if (d !== null && d.ahead >= 1) {
      warnings.push('既定ブランチに未 push の commit があります')
    }
    defaultDiff = d !== null && (d.ahead > 0 || d.behind > 0) ? d : null
  }

  // PR（gh）
  let prs: Pr[] | null = null
  let prCapped = false
  let ghAt: string | null = null
  let ghProblem = false
  const sameCwd = prev !== null && prev.cwd === opts.cwd
  if (!hasRemote) {
    // リモートがなければ、gh は対象外。
  } else if (opts.withGh) {
    const g = await safe(run, ['gh', 'pr', 'list', '--state', 'all', '--limit', String(PR_LIMIT), '--json', PR_FIELDS])
    const parsed = usable(g) ? parsePrList(g.stdout) : null
    if (parsed === null) {
      ghProblem = true
    } else {
      prs = parsed
      prCapped = parsed.length >= PR_LIMIT
      ghAt = gitAt
    }
  } else if (sameCwd && prev.prs !== null) {
    prs = prev.prs
    prCapped = prev.prCapped
    ghAt = prev.ghAt
  } else if (sameCwd) {
    ghProblem = prev.ghProblem
  }

  // ブランチごとの問い合わせ（合計 BUDGET 本まで）
  let left = BUDGET
  const spend = () => (left > 0 ? (left--, true) : false)
  const names = heads.filter(n => n !== defaultName)
  const built = new Map<string, BranchRow>()
  for (const name of pickBudget(names, currentName, opts.selected, names.length)) {
    const tip = oidOf.get(name)?.oid ?? ''
    const ref = `${HEADS}${name}`

    let ahead: number | null = null
    if (baseRef !== null) {
      ahead = aheadMap?.get(ref) ?? null
      if (aheadMap === null && spend()) {
        ahead = await countOf(run, `${baseRef}..${ref}`)
      }
    }

    const originOid = origin.get(name)
    let pushed: boolean | null
    let originDiff: Facts['originDiff'] = null
    if (!hasRemote || originOid === undefined) {
      pushed = false
    } else if (originOid === tip) {
      pushed = true
    } else {
      const d = spend() ? await diffOf(run, `${ORIGIN}${name}`, ref) : null
      pushed = d === null ? null : d.ahead === 0
      originDiff = d !== null && (d.ahead > 0 || d.behind > 0) ? d : null
    }

    const own = (prs ?? []).filter(p => p.headRefName === name)
    const relation = sameOrOther(own, tip)
    const candidate = newestClosed(own)
    if (candidate !== undefined && !own.some(p => p.state === 'OPEN') && relation.get(candidate.number) !== 'same') {
      let found = spend() ? await ancestry(run, ref, candidate.headRefOid) : 'unknown'
      // 自分の commit がないブランチ（古い main から切り直した直後）は、同名の古い PR の元にはなれない。
      // ただし、PR の先頭が基準に入っている（merge commit でマージ済み）ときは、そのまま採る。
      if (found === 'ancestor' && ahead === 0 && baseRef !== null && spend() && !(await isInBase(run, candidate.headRefOid, baseRef))) {
        found = 'other'
      }
      relation.set(candidate.number, found)
    }
    const adopted = prs === null ? { pr: null, known: false } : adoptPr(own, p => relation.get(p.number) ?? 'other')
    const prKnown = adopted.known && !(prCapped && adopted.pr === null)

    const facts: Facts = {
      dirty: name === currentName ? dirty : false,
      ahead,
      pushed,
      createdAt: null,
      firstCommitAt: null,
      lastCommitAt: oidOf.get(name)?.date ?? null,
      pushedAt: null,
      pr: adopted.pr,
      prKnown,
      hasRemote,
      originDiff,
    }
    built.set(name, buildRow(stripControl(name), kindOf(name, defaultName), name === currentName, facts))
  }
  if (defaultName !== null && oidOf.has(defaultName)) {
    const facts: Facts = { dirty: false, ahead: 0, pushed: origin.get(defaultName) === oidOf.get(defaultName)?.oid, createdAt: null, firstCommitAt: null, lastCommitAt: oidOf.get(defaultName)?.date ?? null, pushedAt: null, pr: null, prKnown: true, hasRemote, originDiff: defaultDiff }
    built.set(defaultName, buildRow(stripControl(defaultName), 'default', defaultName === currentName, facts))
  }
  const branches = heads.map(n => built.get(n)).filter((b): b is BranchRow => b !== undefined)

  return { cwd: opts.cwd, gitAt, ghAt, problem: null, ghProblem, prs, prCapped, baseRef, remotes, branches, warnings }
}

// 他のタブでも使う、軽い読み取り。git は 2 本だけ。status が取れなければ、Git のリポジトリとはみなさない。
export async function collectLight(run: Run): Promise<{ isRepo: boolean; branch: string | null; dirtyCount: number | null }> {
  const [head, status] = await Promise.all([git(run, 'symbolic-ref', '-q', 'HEAD'), git(run, 'status', '--porcelain=v1', '-z')])
  if (!usable(status)) {
    return { isRepo: false, branch: null, dirtyCount: null }
  }
  const HEADS = 'refs/heads/'
  const ref = head.exitCode === 0 ? head.stdout.trim() : ''

  return { isRepo: true, branch: ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null, dirtyCount: parseDirtyCount(status.stdout) }
}

export async function detailOf(run: Run, name: string, baseRef: string | null): Promise<Detail> {
  const [created, pushed, first] = await Promise.all([
    git(run, 'reflog', 'show', '--date=iso-strict', '--format=%gd%x09%gs', `refs/heads/${name}`),
    git(run, 'reflog', 'show', '--date=iso-strict', '--format=%gd', '-1', `refs/remotes/origin/${name}`),
    baseRef === null ? Promise.resolve(null) : git(run, 'log', '--format=%cI', `${baseRef}..refs/heads/${name}`),
  ])

  return {
    createdAt: usable(created) ? parseCreatedAt(created.stdout) : null,
    firstCommitAt: first !== null && usable(first) ? lastLineOf(first.stdout) : null,
    pushedAt: usable(pushed) ? parseNewestReflogDate(pushed.stdout) : null,
  }
}

export function applyDetail(row: BranchRow, d: Detail): BranchRow {
  return buildRow(row.name, row.kind, row.isCurrent, { ...row.facts, ...d })
}

// PR の一覧が上限に達したときに、選択中のブランチだけを引き直す。
export async function requeryPr(
  run: Run,
  name: string,
  tip: string,
  ahead: number | null,
  baseRef: string | null,
): Promise<{ pr: Pr | null; known: boolean }> {
  const g = await safe(run, ['gh', 'pr', 'list', '--state', 'all', '--head', name, '--json', PR_FIELDS])
  const prs = usable(g) ? parsePrList(g.stdout) : null
  if (prs === null) {
    return { pr: null, known: false }
  }
  const own = prs.filter(p => p.headRefName === name)
  const relation = sameOrOther(own, tip)
  const candidate = newestClosed(own)
  if (candidate !== undefined && !own.some(p => p.state === 'OPEN') && relation.get(candidate.number) !== 'same') {
    let found = await ancestry(run, `refs/heads/${name}`, candidate.headRefOid)
    if (found === 'ancestor' && ahead === 0 && baseRef !== null && !(await isInBase(run, candidate.headRefOid, baseRef))) {
      found = 'other'
    }
    relation.set(candidate.number, found)
  }

  return adoptPr(own, p => relation.get(p.number) ?? 'other')
}

// 画面の snapshot が、作り直しの元にした snapshot のままなら新しいほうに替える。
// 取得の途中で別の更新が入っていたら、画面のほうを残す（古い結果で上書きしない）。
export function replaceIfSame(cur: Snapshot | null, base: Snapshot, next: Snapshot): Snapshot | null {
  return cur !== null && cur.cwd === base.cwd && cur.gitAt === base.gitAt ? next : cur
}

// 選んだブランチだけ、日時を取り、PR の一覧が上限に達していたときは PR を引き直す。
export async function enrich(run: Run, snap: Snapshot, name: string): Promise<Snapshot> {
  const row = snap.branches.find(b => b.name === name)
  if (row === undefined || row.kind === 'default') {
    return snap
  }
  let next = applyDetail(row, await detailOf(run, name, snap.baseRef))
  if (snap.prCapped && next.facts.pr === null && snap.ghAt !== null) {
    const tip = await git(run, 'rev-parse', '--verify', `refs/heads/${name}`)
    if (usable(tip)) {
      const found = await requeryPr(run, name, tip.stdout.trim(), next.facts.ahead, snap.baseRef)
      next = buildRow(next.name, next.kind, next.isCurrent, { ...next.facts, pr: found.pr, prKnown: found.known })
    }
  }

  return { ...snap, branches: snap.branches.map(b => (b === row ? next : b)) }
}
