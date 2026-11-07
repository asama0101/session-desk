import { expect, test } from 'claude-code/testing'

import { applyDetail, collect, collectLight, detailOf, enrich, pickBudget, replaceIfSame, requeryPr } from './git'
import type { Run, Snapshot } from './git'

type Reply = { exitCode?: number; stdout?: string; stderr?: string; isStdoutTruncated?: boolean } | 'reject'

const NOW = () => new Date(2026, 10, 7, 12, 3, 10)
const ok = (stdout = ''): Reply => ({ exitCode: 0, stdout })
const GH_PR = (over: object) => ({
  number: 7,
  state: 'MERGED',
  isDraft: false,
  reviewDecision: '',
  createdAt: '2026-11-03T00:00:00Z',
  mergedAt: '2026-11-03T01:00:00Z',
  headRefName: 'docs/b',
  headRefOid: 'B1',
  isCrossRepository: false,
  latestReviews: [],
  ...over,
})

const REFS =
  'refs/heads/docs/b\tB1\t2026-11-03T10:00:00+09:00\n' +
  'refs/heads/feat/a\tA1\t2026-11-05T11:40:00+09:00\n' +
  'refs/heads/main\tM1\t2026-11-01T09:00:00+09:00\n' +
  'refs/remotes/origin/HEAD\tM1\t2026-11-01T09:00:00+09:00\n' +
  'refs/remotes/origin/docs/b\tB1\t2026-11-03T10:00:00+09:00\n' +
  'refs/remotes/origin/main\tM1\t2026-11-01T09:00:00+09:00\n'
const AHEAD = 'refs/heads/docs/b\t3 0\nrefs/heads/feat/a\t2 0\nrefs/heads/main\t0 0\n'

const REMOTE_V =
  'origin\thttps://github.com/a/b.git (fetch)\norigin\thttps://github.com/a/b.git (push)\n'

type Setup = Partial<Record<string, Reply>> & { refs?: string; ahead?: string; gh?: Reply; status?: Reply; remote?: Reply }

// 偽の run。git の呼び出しは argv の [1] が --no-optional-locks でなければ違反として記録する。
function fake(setup: Setup = {}) {
  const calls: string[] = []
  const violations: string[] = []
  const run: Run = async argv => {
    const key = argv[0] === 'git' ? argv.slice(2).join(' ') : argv.join(' ')
    if (argv[0] === 'git' && argv[1] !== '--no-optional-locks') {
      violations.push(key)
    }
    calls.push(key)
    let reply: Reply | undefined = setup[key]
    if (reply === undefined) {
      if (key === 'rev-parse --git-dir') reply = ok('.git\n')
      else if (key === 'symbolic-ref -q refs/remotes/origin/HEAD') reply = ok('refs/remotes/origin/main\n')
      else if (key === 'symbolic-ref -q HEAD') reply = ok('refs/heads/feat/a\n')
      else if (key === 'status --porcelain=v1 -z') reply = setup.status ?? ok('')
      else if (key.startsWith('for-each-ref --format=%(refname)%09%(objectname)')) reply = ok(setup.refs ?? REFS)
      else if (key.startsWith('for-each-ref --format=%(refname)%09%(ahead-behind:')) reply = ok(setup.ahead ?? AHEAD)
      else if (key.startsWith('gh pr list')) reply = setup.gh ?? ok(JSON.stringify([GH_PR({})]))
      else if (key === 'remote -v') reply = setup.remote ?? ok(REMOTE_V)
      else if (key.startsWith('rev-list --count refs/remotes/origin/main..')) reply = ok('0\n')
      else reply = { exitCode: 1 }
    }
    if (reply === 'reject') {
      throw new Error('timed out')
    }

    return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, ...reply }
  }

  return { run, calls, violations }
}

const OPTS = { withGh: true, cwd: 'D:/p', selected: null, now: NOW }
const row = (snap: Snapshot, name: string) => snap.branches.find(b => b.name === name)
const statuses = (snap: Snapshot, name: string) => row(snap, name)?.stages.map(s => s.status)

test('collect builds one row per local branch; origin/HEAD is not a branch; main is the default', async () => {
  const f = fake()
  const snap = await collect(f.run, null, OPTS)
  expect(f.violations).toEqual([])
  expect(snap.problem).toBe(null)
  expect(snap.branches.map(b => b.name)).toEqual(['docs/b', 'feat/a', 'main'])
  expect(row(snap, 'main')?.kind).toBe('default')
  expect(row(snap, 'main')?.stages).toEqual([])
  expect(row(snap, 'feat/a')?.now.text).toBe('次: push')
  expect(row(snap, 'feat/a')?.isCurrent).toBe(true)
  expect(row(snap, 'docs/b')?.now.text).toBe('次: ブランチを削除')
  expect(snap.baseRef).toBe('refs/remotes/origin/main')
  expect(snap.gitAt).toBe('12:03:10')
  expect(snap.ghAt).toBe('12:03:10')
  expect(snap.ghProblem).toBe(false)
})

test('uncommitted changes are attached to the current branch only', async () => {
  const snap = await collect(fake({ status: ok(' M x\0') }).run, null, OPTS)
  expect(row(snap, 'feat/a')?.facts.dirty).toBe(true)
  expect(row(snap, 'feat/a')?.now.text).toBe('編集中')
  expect(row(snap, 'docs/b')?.facts.dirty).toBe(false)
})

test('when status fails, the current branch has dirty=null and now reads 判定できない', async () => {
  const snap = await collect(fake({ status: { exitCode: 128 } }).run, null, OPTS)
  expect(row(snap, 'feat/a')?.facts.dirty).toBe(null)
  expect(row(snap, 'feat/a')?.now.text).toBe('今: 判定できない')
})

test('the base falls back to the local default branch, and to null when there is none (no ahead-behind call)', async () => {
  const noOriginMain =
    'refs/heads/feat/a\tA1\t2026-11-05T11:40:00+09:00\nrefs/heads/main\tM1\t2026-11-01T09:00:00+09:00\n'
  const f1 = fake({ refs: noOriginMain, 'symbolic-ref -q refs/remotes/origin/HEAD': { exitCode: 1 } })
  const s1 = await collect(f1.run, null, OPTS)
  expect(s1.baseRef).toBe('refs/heads/main')
  expect(f1.calls.some(c => c.includes('ahead-behind:refs/heads/main'))).toBe(true)

  const f2 = fake({
    refs: 'refs/heads/x\tX1\t2026-11-05T11:40:00+09:00\n',
    'symbolic-ref -q refs/remotes/origin/HEAD': { exitCode: 1 },
  })
  const s2 = await collect(f2.run, null, OPTS)
  expect(s2.baseRef).toBe(null)
  expect(f2.calls.some(c => c.includes('ahead-behind'))).toBe(false)
  expect(row(s2, 'x')?.now.text).toBe('今: 判定できない')
})

test('when gh rejects, exits non-zero or is truncated, PR stages are unknown and git stages stay', async () => {
  for (const gh of ['reject', { exitCode: 1 }, { isStdoutTruncated: true, stdout: '[' }] as Reply[]) {
    const snap = await collect(fake({ gh }).run, null, OPTS)
    expect(snap.ghProblem).toBe(true)
    expect(snap.ghAt).toBe(null)
    expect(statuses(snap, 'docs/b')).toEqual(['done', 'done', 'done', 'done', 'unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
    expect(row(snap, 'feat/a')?.now.text).toBe('次: push')
  }
})

test('when ahead-behind fails, the ahead count comes from rev-list per branch', async () => {
  const f = fake({
    'for-each-ref --format=%(refname)%09%(ahead-behind:refs/remotes/origin/main) refs/heads': { exitCode: 128 },
    'rev-list --count refs/remotes/origin/main..refs/heads/feat/a': ok('2\n'),
    'rev-list --count refs/remotes/origin/main..refs/heads/docs/b': ok('3\n'),
  })
  const snap = await collect(f.run, null, OPTS)
  expect(row(snap, 'feat/a')?.facts.ahead).toBe(2)
  expect(row(snap, 'feat/a')?.now.text).toBe('次: push')
})

test('a truncated branch list empties the list with a warning (not no-commit)', async () => {
  const snap = await collect(fake({ refs: undefined, 'for-each-ref --format=%(refname)%09%(objectname)%09%(committerdate:iso-strict) refs/heads refs/remotes/origin': { isStdoutTruncated: true, stdout: 'refs/heads/a' } }).run, null, OPTS)
  expect(snap.branches).toEqual([])
  expect(snap.problem).toBe(null)
  expect(snap.warnings).toEqual(['ブランチ一覧が長すぎます'])
})

test('withGh=false reuses the previous PRs for the same cwd, and drops them for another cwd', async () => {
  const first = await collect(fake().run, null, OPTS)
  const f = fake()
  const again = await collect(f.run, first, { ...OPTS, withGh: false })
  expect(f.calls.some(c => c.startsWith('gh '))).toBe(false)
  expect(row(again, 'docs/b')?.now.text).toBe('次: ブランチを削除')
  expect(again.ghAt).toBe(first.ghAt)
  const other = await collect(fake().run, first, { ...OPTS, withGh: false, cwd: 'D:/other' })
  expect(statuses(other, 'docs/b')?.slice(4)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
  expect(other.ghAt).toBe(null)
})

test('per-branch processes stop at 30; the current and selected branches are always inside the budget', async () => {
  const names = Array.from({ length: 39 }, (_, i) => `b${String(i).padStart(2, '0')}`)
  const all = [...names, 'z-current']
  const refs =
    'refs/heads/main\tM1\t2026-11-01T00:00:00+09:00\nrefs/remotes/origin/main\tM1\t2026-11-01T00:00:00+09:00\n' +
    all.map(n => `refs/heads/${n}\tL-${n}\t2026-11-02T00:00:00+09:00\nrefs/remotes/origin/${n}\tO-${n}\t2026-11-02T00:00:00+09:00\n`).join('')
  const ahead = ['main', ...all].map(n => `refs/heads/${n}\t1 0\n`).join('')
  const setup: Setup = {
    refs,
    ahead,
    'symbolic-ref -q HEAD': ok('refs/heads/z-current\n'),
    gh: ok(JSON.stringify([GH_PR({ headRefName: 'z-current', headRefOid: 'OLD' })])),
  }
  for (const n of all) {
    setup[`rev-list --left-right --count refs/remotes/origin/${n}...refs/heads/${n}`] = ok('0\t1\n')
  }
  setup['merge-base --is-ancestor refs/heads/z-current OLD'] = { exitCode: 0 }
  const f = fake(setup)
  const snap = await collect(f.run, null, { ...OPTS, selected: 'b05' })
  const perBranch = f.calls.filter(c => c.startsWith('rev-list --left-right --count refs/remotes/origin/b') || c.startsWith('rev-list --left-right --count refs/remotes/origin/z') || c.startsWith('merge-base'))
  expect(perBranch.length).toBe(30)
  expect(f.calls).toContain('rev-list --left-right --count refs/remotes/origin/z-current...refs/heads/z-current')
  expect(f.calls).toContain('merge-base --is-ancestor refs/heads/z-current OLD')
  expect(f.calls).toContain('rev-list --left-right --count refs/remotes/origin/b05...refs/heads/b05')
  expect(row(snap, 'z-current')?.facts.pushed).toBe(false)
  expect(row(snap, 'z-current')?.facts.pr?.state).toBe('MERGED')
  expect(row(snap, 'b05')?.facts.pushed).toBe(false)
  expect(snap.branches.filter(b => b.facts.pushed === null).length).toBe(11)
})

test('problems: not a repository, unsafe owner, no commit, timeout', async () => {
  const revParse = 'rev-parse --git-dir'
  expect((await collect(fake({ [revParse]: { exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' } }).run, null, OPTS)).problem).toBe('not-repo')
  expect((await collect(fake({ [revParse]: { exitCode: 128, stderr: "fatal: detected dubious ownership in repository at 'D:/p'" } }).run, null, OPTS)).problem).toBe('unsafe-owner')
  expect((await collect(fake({ refs: '' }).run, null, OPTS)).problem).toBe('no-commit')
  expect((await collect(fake({ [revParse]: 'reject' }).run, null, OPTS)).problem).toBe('timeout')
})

test('warnings: detached HEAD, uncommitted changes on the default branch, unpushed default branch', async () => {
  const detached = await collect(fake({ 'symbolic-ref -q HEAD': { exitCode: 1 } }).run, null, OPTS)
  expect(detached.warnings).toContain('HEAD は分離状態')
  expect(detached.branches.every(b => !b.isCurrent)).toBe(true)

  const dirtyMain = await collect(fake({ 'symbolic-ref -q HEAD': ok('refs/heads/main\n'), status: ok('?? x\0') }).run, null, OPTS)
  expect(dirtyMain.warnings).toContain('既定ブランチ上に未 commit の変更があります')

  const unpushed = await collect(fake({ 'rev-list --left-right --count refs/remotes/origin/main...refs/heads/main': ok('0\t2\n') }).run, null, OPTS)
  expect(unpushed.warnings).toContain('既定ブランチに未 push の commit があります')
})

test('a branch name goes through stripControl', async () => {
  const refs = 'refs/heads/feat/\u001b[31mx\tX1\t2026-11-05T11:40:00+09:00\nrefs/heads/main\tM1\t2026-11-01T00:00:00+09:00\n'
  const snap = await collect(fake({ refs, ahead: '' }).run, null, OPTS)
  expect(snap.branches.map(b => b.name)).toContain('feat/x')
})

test('pickBudget orders current, selected, then the rest by name, and cuts at the limit', async () => {
  expect(pickBudget(['a', 'b', 'c', 'd'], 'd', 'c', 3)).toEqual(['d', 'c', 'a'])
  expect(pickBudget(['a', 'b'], null, null, 5)).toEqual(['a', 'b'])
  expect(pickBudget(['a', 'b'], 'zz', 'yy', 5)).toEqual(['a', 'b'])
})

test('detailOf reads created, first-commit and push dates; empty reflogs give null; no base gives no first commit', async () => {
  const f = fake({
    'reflog show --date=iso-strict --format=%gd%x09%gs refs/heads/feat/a': ok('feat/a@{2026-11-05T10:02:00+09:00}\tcommit: a\nfeat/a@{2026-11-05T09:00:00+09:00}\tbranch: Created from main\n'),
    'reflog show --date=iso-strict --format=%gd -1 refs/remotes/origin/feat/a': ok('origin/feat/a@{2026-11-05T11:41:00+09:00}\n'),
    'log --format=%cI refs/remotes/origin/main..refs/heads/feat/a': ok('2026-11-05T10:02:00+09:00\n2026-11-05T09:30:00+09:00\n'),
  })
  expect(await detailOf(f.run, 'feat/a', 'refs/remotes/origin/main')).toEqual({
    createdAt: '2026-11-05T09:00:00+09:00',
    firstCommitAt: '2026-11-05T09:30:00+09:00',
    pushedAt: '2026-11-05T11:41:00+09:00',
  })
  expect(f.violations).toEqual([])
  const empty = await detailOf(fake().run, 'feat/a', null)
  expect(empty).toEqual({ createdAt: null, firstCommitAt: null, pushedAt: null })
})

test('applyDetail fills the dates and keeps the statuses', async () => {
  const snap = await collect(fake().run, null, OPTS)
  const before = row(snap, 'feat/a')!
  const after = applyDetail(before, { createdAt: 'c', firstCommitAt: '2026-11-05T09:30:00+09:00', pushedAt: null })
  expect(after.stages[1]?.at).toBe('2026-11-05T09:30:00+09:00')
  expect(after.stages[0]?.at).toBe('c')
  expect(after.stages.map(s => s.status)).toEqual(before.stages.map(s => s.status))
})

test('requeryPr adopts a PR found by --head, and reports unknown when gh fails', async () => {
  const found = fake({ 'gh pr list --state all --head docs/b --json number,state,isDraft,reviewDecision,createdAt,mergedAt,headRefName,headRefOid,isCrossRepository,latestReviews,url': ok(JSON.stringify([GH_PR({})])) })
  const r = await requeryPr(found.run, 'docs/b', 'B1', 3, 'refs/remotes/origin/main')
  expect(r.known).toBe(true)
  expect(r.pr?.state).toBe('MERGED')
  const failed = await requeryPr(fake({ 'gh pr list --state all --head docs/b --json number,state,isDraft,reviewDecision,createdAt,mergedAt,headRefName,headRefOid,isCrossRepository,latestReviews,url': { exitCode: 1 } }).run, 'docs/b', 'B1', 3, 'refs/remotes/origin/main')
  expect(failed).toEqual({ pr: null, known: false })
})

const FEAT_REFLOG = {
  'reflog show --date=iso-strict --format=%gd%x09%gs refs/heads/feat/a': ok(
    'feat/a@{2026-11-05T09:00:00+09:00}\tbranch: Created from main\n',
  ),
  'log --format=%cI refs/remotes/origin/main..refs/heads/feat/a': ok('2026-11-05T11:40:00+09:00\n2026-11-05T09:30:00+09:00\n'),
}

test('enrich fills the dates of the chosen branch only', async () => {
  const f = fake(FEAT_REFLOG)
  const snap = await collect(f.run, null, OPTS)
  const rich = await enrich(f.run, snap, 'feat/a')
  expect(row(rich, 'feat/a')?.stages[0]?.at).toBe('2026-11-05T09:00:00+09:00')
  expect(row(rich, 'feat/a')?.stages[1]?.at).toBe('2026-11-05T09:30:00+09:00')
  expect(row(rich, 'docs/b')?.stages[0]?.at).toBe(null)
  expect(f.violations).toEqual([])
})

test('enrich leaves the default branch, and an unknown name, untouched', async () => {
  const f = fake()
  const snap = await collect(f.run, null, OPTS)
  expect(await enrich(f.run, snap, 'main')).toBe(snap)
  expect(await enrich(f.run, snap, 'nope')).toBe(snap)
})

test('when the PR list hit its limit, enrich asks gh for the chosen branch alone and turns unknown into a real answer', async () => {
  const many = Array.from({ length: 200 }, (_, i) => GH_PR({ number: 100 + i, headRefName: `other${i}`, state: 'CLOSED' }))
  const headKey = 'gh pr list --state all --head feat/a --json number,state,isDraft,reviewDecision,createdAt,mergedAt,headRefName,headRefOid,isCrossRepository,latestReviews,url'
  const f = fake({ gh: ok(JSON.stringify(many)), 'rev-parse --verify refs/heads/feat/a': ok('A1\n'), [headKey]: ok('[]'), ...FEAT_REFLOG })
  const snap = await collect(f.run, null, OPTS)
  expect(snap.prCapped).toBe(true)
  expect(row(snap, 'feat/a')?.facts.prKnown).toBe(false)
  expect(statuses(snap, 'feat/a')?.slice(4)).toEqual(['unknown', 'unknown', 'unknown', 'unknown', 'unknown'])
  const rich = await enrich(f.run, snap, 'feat/a')
  expect(f.calls).toContain(headKey)
  expect(row(rich, 'feat/a')?.facts.prKnown).toBe(true)
  expect(statuses(rich, 'feat/a')?.slice(4)).toEqual(['todo', 'todo', 'todo', 'todo', 'todo'])
})

test('remotes: every remote is listed with a tidy URL; origin makes hasRemote true', async () => {
  const remote = ok(
    'origin\thttps://user:ghp_SECRET@github.com/a/b.git (fetch)\norigin\thttps://user:ghp_SECRET@github.com/a/b.git (push)\n' +
      'upstream\tgit@github.com:c/d.git (fetch)\nupstream\tgit@github.com:c/d.git (push)\n',
  )
  const snap = await collect(fake({ remote }).run, null, OPTS)
  expect(snap.remotes).toEqual([
    { name: 'origin', url: 'github.com/a/b' },
    { name: 'upstream', url: 'github.com/c/d' },
  ])
  expect(row(snap, 'feat/a')?.facts.hasRemote).toBe(true)
  expect(JSON.stringify(snap)).not.toContain('SECRET')
})

test('no remote at all: gh is not called, push onwards is skipped, and the branch reads commit 済み（リモートなし）', async () => {
  const f = fake({ remote: ok('') })
  const snap = await collect(f.run, null, OPTS)
  expect(snap.remotes).toEqual([])
  expect(f.calls.some(c => c.startsWith('gh '))).toBe(false)
  expect(row(snap, 'feat/a')?.facts.hasRemote).toBe(false)
  expect(statuses(snap, 'feat/a')).toEqual(['done', 'done', 'done', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped'])
  expect(row(snap, 'feat/a')?.now.text).toBe('commit 済み（リモートなし）')
  expect(snap.ghProblem).toBe(false)
})

test('only a remote other than origin counts as no origin: it is listed, but push onwards is skipped', async () => {
  const remote = ok('upstream\tgit@github.com:c/d.git (fetch)\nupstream\tgit@github.com:c/d.git (push)\n')
  const snap = await collect(fake({ remote }).run, null, OPTS)
  expect(snap.remotes).toEqual([{ name: 'upstream', url: 'github.com/c/d' }])
  expect(row(snap, 'feat/a')?.facts.hasRemote).toBe(false)
})

test('when git remote -v fails, remotes are unknown (null) and the stages are judged as if origin exists', async () => {
  const snap = await collect(fake({ remote: { exitCode: 128 } }).run, null, OPTS)
  expect(snap.remotes).toBe(null)
  expect(row(snap, 'feat/a')?.facts.hasRemote).toBe(true)
  expect(row(snap, 'feat/a')?.now.text).toBe('次: push')
})

test('the difference from origin: ahead and behind come from one left-right count; equal tips and no origin give none', async () => {
  const refs =
    REFS + 'refs/heads/feat/c\tC1\t2026-11-05T11:40:00+09:00\nrefs/remotes/origin/feat/c\tC0\t2026-11-05T10:00:00+09:00\n' +
    'refs/remotes/origin/feat/a\tA0\t2026-11-05T10:00:00+09:00\n'
  const f = fake({
    refs,
    'rev-list --left-right --count refs/remotes/origin/feat/a...refs/heads/feat/a': ok('1\t2\n'),
    'rev-list --left-right --count refs/remotes/origin/feat/c...refs/heads/feat/c': ok('3\t0\n'),
  })
  const snap = await collect(f.run, null, OPTS)
  expect(row(snap, 'feat/a')?.facts.originDiff).toEqual({ ahead: 2, behind: 1 })
  expect(row(snap, 'feat/a')?.facts.pushed).toBe(false)
  expect(row(snap, 'feat/c')?.facts.originDiff).toEqual({ ahead: 0, behind: 3 })
  expect(row(snap, 'feat/c')?.facts.pushed).toBe(true)
  expect(row(snap, 'docs/b')?.facts.originDiff).toBe(null)
  expect(row(snap, 'docs/b')?.facts.pushed).toBe(true)
  expect(f.violations).toEqual([])
})

test('without origin for the branch there is no difference to show', async () => {
  const snap = await collect(fake().run, null, OPTS)
  expect(row(snap, 'feat/a')?.facts.originDiff).toBe(null)
})

test('the default branch row also shows how far it is from origin, and the unpushed warning uses the same count', async () => {
  const refs = REFS.replace('refs/remotes/origin/main\tM1', 'refs/remotes/origin/main\tM0')
  const behind = await collect(fake({ refs, 'rev-list --left-right --count refs/remotes/origin/main...refs/heads/main': ok('3\t0\n') }).run, null, OPTS)
  expect(row(behind, 'main')?.facts.originDiff).toEqual({ ahead: 0, behind: 3 })
  expect(behind.warnings).not.toContain('既定ブランチに未 push の commit があります')

  const ahead = await collect(fake({ refs, 'rev-list --left-right --count refs/remotes/origin/main...refs/heads/main': ok('0\t2\n') }).run, null, OPTS)
  expect(row(ahead, 'main')?.facts.originDiff).toEqual({ ahead: 2, behind: 0 })
  expect(ahead.warnings).toContain('既定ブランチに未 push の commit があります')
})

test('a branch re-cut from a stale main (no commits of its own) does not adopt the old merged PR of the same name', async () => {
  const gh = ok(JSON.stringify([GH_PR({ headRefName: 'feat/a', headRefOid: 'OLD' })]))
  const f = fake({ gh, ahead: 'refs/heads/docs/b\t3 0\nrefs/heads/feat/a\t0 0\nrefs/heads/main\t0 0\n', 'merge-base --is-ancestor refs/heads/feat/a OLD': { exitCode: 0 } })
  const snap = await collect(f.run, null, OPTS)
  expect(row(snap, 'feat/a')?.facts.pr).toBe(null)
  expect(row(snap, 'feat/a')?.now.text).toBe('次: 編集')
})

test('a branch that was fast-forward merged (tip equals the PR head, no commits ahead) still reads as merged', async () => {
  const gh = ok(JSON.stringify([GH_PR({ headRefName: 'feat/a', headRefOid: 'A1' })]))
  const f = fake({ gh, ahead: 'refs/heads/docs/b\t3 0\nrefs/heads/feat/a\t0 0\nrefs/heads/main\t0 0\n' })
  const snap = await collect(f.run, null, OPTS)
  expect(row(snap, 'feat/a')?.facts.pr?.state).toBe('MERGED')
})

test('requeryPr also refuses an old merged PR when the branch has no commits of its own', async () => {
  const headKey = 'gh pr list --state all --head feat/a --json number,state,isDraft,reviewDecision,createdAt,mergedAt,headRefName,headRefOid,isCrossRepository,latestReviews,url'
  const f = fake({ [headKey]: ok(JSON.stringify([GH_PR({ headRefName: 'feat/a', headRefOid: 'OLD' })])), 'merge-base --is-ancestor refs/heads/feat/a OLD': { exitCode: 0 } })
  expect(await requeryPr(f.run, 'feat/a', 'A1', 0, 'refs/remotes/origin/main')).toEqual({ pr: null, known: true })
  expect((await requeryPr(f.run, 'feat/a', 'A1', 2, 'refs/remotes/origin/main')).pr?.state).toBe('MERGED')
})

test('problems: a failing for-each-ref is a git failure, not "no commit"', async () => {
  const refsKey = 'for-each-ref --format=%(refname)%09%(objectname)%09%(committerdate:iso-strict) refs/heads refs/remotes/origin'
  const snap = await collect(fake({ [refsKey]: { exitCode: 128, stderr: 'fatal: bad object' } }).run, null, OPTS)
  expect(snap.problem).toBe('git-failed')
})

test('replaceIfSame writes the new snapshot only when the screen still shows the one it was built from', async () => {
  const base = await collect(fake().run, null, OPTS)
  const next = { ...base, warnings: ['x'] }
  expect(replaceIfSame(base, base, next)).toBe(next)
  expect(replaceIfSame({ ...base, gitAt: '00:00:00' }, base, next)).not.toBe(next)
  expect(replaceIfSame({ ...base, cwd: 'D:/other' }, base, next)?.cwd).toBe('D:/other')
  expect(replaceIfSame(null, base, next)).toBe(null)
})

test('a PR merged with a merge commit and updated after the branch was cut still reads as merged (its head is in the base)', async () => {
  const gh = ok(JSON.stringify([GH_PR({ headRefName: 'feat/a', headRefOid: 'NEWER' })]))
  const f = fake({
    gh,
    ahead: 'refs/heads/docs/b\t3 0\nrefs/heads/feat/a\t0 0\nrefs/heads/main\t0 0\n',
    'merge-base --is-ancestor refs/heads/feat/a NEWER': { exitCode: 0 },
    'merge-base --is-ancestor NEWER refs/remotes/origin/main': { exitCode: 0 },
  })
  const snap = await collect(f.run, null, OPTS)
  expect(row(snap, 'feat/a')?.facts.pr?.state).toBe('MERGED')
  expect(f.violations).toEqual([])
})

test('requeryPr keeps a merge-commit merged PR for a branch with no commits ahead', async () => {
  const headKey = 'gh pr list --state all --head feat/a --json number,state,isDraft,reviewDecision,createdAt,mergedAt,headRefName,headRefOid,isCrossRepository,latestReviews,url'
  const f = fake({
    [headKey]: ok(JSON.stringify([GH_PR({ headRefName: 'feat/a', headRefOid: 'NEWER' })])),
    'merge-base --is-ancestor refs/heads/feat/a NEWER': { exitCode: 0 },
    'merge-base --is-ancestor NEWER refs/remotes/origin/main': { exitCode: 0 },
  })
  expect((await requeryPr(f.run, 'feat/a', 'A1', 0, 'refs/remotes/origin/main')).pr?.state).toBe('MERGED')
})

test('collectLight reads only symbolic-ref HEAD and status, and counts the changed paths', async () => {
  const f = fake({ status: ok(' M a\0') })
  expect(await collectLight(f.run)).toEqual({ isRepo: true, branch: 'feat/a', dirtyCount: 1 })
  expect(f.calls.sort()).toEqual(['status --porcelain=v1 -z', 'symbolic-ref -q HEAD'])
  expect(f.violations).toEqual([])
})

test('collectLight: a detached HEAD has no branch but is still a repository', async () => {
  const f = fake({ 'symbolic-ref -q HEAD': { exitCode: 1 } })
  expect(await collectLight(f.run)).toEqual({ isRepo: true, branch: null, dirtyCount: 0 })
})

test('collectLight: when status fails it is not a repository', async () => {
  for (const status of [{ exitCode: 128 }, 'reject' as const]) {
    const f = fake({ status })
    expect(await collectLight(f.run)).toEqual({ isRepo: false, branch: null, dirtyCount: null })
  }
})
