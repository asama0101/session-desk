# 「ブランチ」タブ Implementation Plan

> **古い記録。** 作った時点の計画・設計で、その後に変わった（タブの名前は「Git」、段階は 8、ボタンや見た目など）。今の仕様は README と docs の図を見る。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session Desk に、ブランチの一覧と、選んだブランチの段階ごとの経過（済・今・次）を見せる 3 つ目のタブ「ブランチ」を足す。

**Architecture:** 判定・解析・更新の予約は、エンジンに触れない純粋な関数に置く（`hooks/branch.ts`、`hooks/refresh.ts`）。git・gh を呼ぶのは `hooks/git.ts` だけ。表示は `hooks/branch-view.tsx`。状態・配線・タブの切り替えは既存の `hooks/register.tsx` に足す。

**Tech Stack:** TypeScript / JSX（Claude Code の mod API。`claude-code`、テストは `claude-code/testing`）。外部コマンドは `git` と `gh`。

**Spec:** `docs/superpowers/specs/2026-11-07-branch-tab-design.md`（この計画では「設計書 4.3」のように章で引く）

## Global Constraints

- Claude Code 2.1.319、Windows 11。git は 2.41 以上を前提にする（`%(ahead-behind)` を使う）。
- git は必ず `["git", "--no-optional-locks", …]` の argv で呼ぶ。シェルは使わない。読み取りだけ。`git fetch` はしない。
- ref は完全修飾で渡す（`refs/heads/<名>`、`refs/remotes/origin/<名>`）。
- `$.process.run` には毎回 `{ timeoutMs: 15000, env: { LC_ALL: 'C' } }` を付ける（stderr の文言を英語に固定するため）。
- 失敗（reject、終了コードが 0 以外、時間切れ）と、`isStdoutTruncated` が真の出力は、その情報を「不明」にする（git も gh も）。
- ブランチごとに起動するプロセスは、1 回の更新で合計 30 本まで。順序は、チェックアウト中のブランチ、選択中のブランチ、残りは名前順。1 ブランチの中では、push の確認、祖先の確認の順。超えた分は「不明」。
- 更新: git 10 秒、gh は 60 秒（gh が失敗するたびに 2 倍、上限 10 分）、ツール実行後の更新は設計書 6.2 のとおり。ブランチタブが表示中（パネルが開き `isPlaced` が真、かつ tab が `branch`）のときだけ更新する。
- 外から来る文字は `stripControl`（`hooks/lib.ts`）を通して出す。`git`・`gh` の標準エラーは画面に出さない。
- 記号: 済 ✓、今 ●、未 ○、不明 ?、省略 －。
- テスト: リポジトリのルートで `claude plugin test session-desk`（現状 35 件が通る）。検査: `claude plugin validate session-desk --strict`。
- 作業は `feat/branch-tab` ブランチで行う。設計書と計画書を含む `docs/branch-tab-design` から切る（設計書の PR のマージ前のため）。PR は積み重ねになる。

## Review Focus

設計書が明示していない入力。それぞれ担当のタスクにテストを足す。

1. 同じ名前で切り直したブランチに、古い MERGED の PR が付いている → Task 3。
2. ブランチ名が日本語・`/` を多く含む。git の出力が `\r\n`。`origin/HEAD` の行が混ざる → Task 1。
3. `gh` が入っていない・未ログイン・通信失敗。git が 2.41 未満で `ahead-behind` が使えない → Task 4。
4. ブランチが 31 本以上ある。現在のブランチが名前順の後ろにある → Task 4。
5. 更新が重なる（commit の直後に前の更新が走っている）。`gh` を含む別の語（`high`、`github`）を Bash で実行する → Task 5。

---

### Task 1: 型と git 出力の解析

**Files:**
- Create: `session-desk/hooks/branch.ts`
- Test: `session-desk/hooks/branch.test.tsx`

**Interfaces（以降のタスクが使う。ここで型を全部定義する）:**
- 型
  - `Kind = 'feat' | 'fix' | 'docs' | 'chore' | 'other' | 'default'`
  - `Status = 'done' | 'todo' | 'unknown' | 'skipped'`
  - `Relation = 'same' | 'ancestor' | 'other' | 'unknown'`（ローカルの先頭と PR の `headRefOid` の関係）
  - `Pr = { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; isDraft: boolean; reviewDecision: '' | 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED'; createdAt: string; mergedAt: string | null; headRefName: string; headRefOid: string; isCrossRepository: boolean; latestReviews: { submittedAt: string }[] }`
  - `Facts = { dirty: boolean | null; ahead: number | null; pushed: boolean | null; createdAt: string | null; firstCommitAt: string | null; lastCommitAt: string | null; pushedAt: string | null; pr: Pr | null; prKnown: boolean }`（`dirty` が `null`: `status` を取れなかった。`ahead` が `null`: 比較の基準が決まらない。`pushed` が `null`: 確認できなかった。`prKnown` が偽: gh が使えない、または取りこぼしの疑い）
  - `Stage = { id: number; label: string; status: Status; at: string | null; note: string | null }`、`Now = { id: number | null; text: string }`
  - `RefRow = { ref: string; oid: string; date: string }`
- 関数
  - `kindOf(name: string, defaultName: string | null): Kind` — `name === defaultName` は `'default'`。接頭辞 `feat/` `fix/` `docs/` `chore/` はそれぞれの種類。ほかは `'other'`。
  - `parseRefs(stdout: string): RefRow[]` — 入力は `git for-each-ref --format=%(refname)%09%(objectname)%09%(committerdate:iso-strict) refs/heads refs/remotes/origin` の出力（タブ区切り、`\r\n` も受ける）。空行と `refs/remotes/origin/HEAD` の行は捨てる。
  - `parseAhead(stdout: string): Map<string, number>` — 入力は `--format=%(refname)%09%(ahead-behind:<基準>) refs/heads` の出力（行は `refs/heads/x\t2 0` の形）。ref → 進んだ数。
  - `isDirty(porcelainZ: string): boolean` — 空でなければ真（未追跡も数える）。
  - `defaultBranchOf(symbolicRef: string | null, heads: readonly string[]): string | null` — `symbolicRef` は `refs/remotes/origin/main` の形で、末尾に改行が付くことがある（trim する）。`null` のときは、`heads` に `main`、なければ `master` があればそれ。どれもなければ `null`。
  - `parseCreatedAt(stdout: string): string | null` — 入力は `git reflog show --date=iso-strict --format=%gd%x09%gs refs/heads/<名>` の出力（新しい順。`%gd` は `<名>@{日時}` の形）。件名が `branch: Created` で始まる行の日時（`@{…}` の中）。なければ `null`。
  - `parseNewestReflogDate(stdout: string): string | null` — 入力は `git reflog show --date=iso-strict --format=%gd -1 refs/remotes/origin/<名>` の出力。`@{…}` の中の日時。なければ `null`。
  - `lastLineOf(stdout: string): string | null` — 最後の空でない行（trim 済み）。

- [ ] **Step 1: 失敗するテストを書く（`import { expect, test } from 'claude-code/testing'`）**
  - `kindOf`: `'feat/x'` → `'feat'`、`'refactor/x'`・`'develop'`・`'feat'`（スラッシュなし）・`'日本語/名前'` → `'other'`、`kindOf('main','main')` → `'default'`。
  - `parseRefs`: `refs/heads/日本語/ブランチ\tabc123\t2026-11-05T10:20:00+09:00\r\nrefs/remotes/origin/HEAD\tfff\t2026-11-01T00:00:00+09:00\r\nrefs/remotes/origin/main\tfff\t2026-11-01T00:00:00+09:00\r\n\r\n` を渡すと 2 件で、1 件目は `{ ref: 'refs/heads/日本語/ブランチ', oid: 'abc123', date: '2026-11-05T10:20:00+09:00' }`。
  - `parseAhead('refs/heads/a\t2 0\r\nrefs/heads/b\t0 3\r\n')` が `a→2`、`b→0`。
  - `isDirty('')` が偽、`isDirty('?? docs/superpowers/\0')` が真。
  - `defaultBranchOf`: `('refs/remotes/origin/main\r\n', [])` → `'main'`、`(null, ['master','x'])` → `'master'`、`(null, ['x'])` → `null`。
  - `parseCreatedAt('x@{2026-11-05T10:02:00+09:00}\tcommit: a\nx@{2026-11-05T09:00:00+09:00}\tbranch: Created from main\n')` → `'2026-11-05T09:00:00+09:00'`。`parseCreatedAt('')` → `null`。
  - `parseNewestReflogDate('origin/x@{2026-11-05T11:41:00+09:00}\n')` → `'2026-11-05T11:41:00+09:00'`。`lastLineOf('a\nb\r\n\n')` → `'b'`、`lastLineOf('')` → `null`。
- [ ] **Step 2: テストを実行して失敗を確かめる**。`claude plugin test session-desk` → `branch.test.tsx` が import で失敗する。
- [ ] **Step 3: 上の型と関数を `branch.ts` に実装する**。
- [ ] **Step 4: テストを実行して通ることを確かめる**。既存 35 件と今回の分がすべて通る。
- [ ] **Step 5: Commit** — `feat: ブランチの型と git 出力の解析を追加する`

---

### Task 2: 段階の判定と「今」

**Files:**
- Modify: `session-desk/hooks/branch.ts`
- Test: `session-desk/hooks/branch.test.tsx`

**Interfaces:**
- Consumes: Task 1 の型。
- Produces:
  - `computeStages(f: Facts): Stage[]`（長さ 8。`label` は ブランチを切る・編集・commit・push・PR・レビュー・マージ・削除。`id` は 1〜8）
  - `nowOf(stages: readonly Stage[], f: Facts): Now`
  - `type BranchRow = { name: string; kind: Kind; isCurrent: boolean; facts: Facts; stages: Stage[]; now: Now }`
  - `buildRow(name: string, kind: Kind, isCurrent: boolean, facts: Facts): BranchRow` — `kind` が `'default'` のときは、`stages` を空にし、`now` を `{ id: null, text: '既定' }` にする。

- [ ] **Step 1: 失敗するテストを書く**。表の各行を `computeStages`（`status` を段階 1〜8 の順で）と `nowOf` で確かめる。「素」は `{ dirty:false, ahead:0, pushed:false, createdAt:null, firstCommitAt:null, lastCommitAt:null, pushedAt:null, pr:null, prKnown:true }`。**F0** は 素 に `ahead:2, pushed:true` を足したもの。`pr` の行は、`state` などの指定以外は `isDraft:false, reviewDecision:''`。

| # | Facts | 段階 1〜8 | now.id | now.text |
|---|---|---|---|---|
| 1 | 素 | done todo×7 | 2 | `次: 編集` |
| 2 | 素 ＋ dirty | done done todo×6 | 3 | `編集中` |
| 3 | 素 ＋ ahead:2 | done done done todo×5 | 4 | `次: push` |
| 4 | F0 | done×4 todo×4 | 5 | `次: PR を作る` |
| 5 | F0 ＋ OPEN | done×5 skipped todo todo | 7 | `マージ待ち` |
| 6 | F0 ＋ OPEN、APPROVED | done×6 todo todo | 7 | `マージ待ち` |
| 7 | F0 ＋ OPEN、REVIEW_REQUIRED | done×5 todo×3 | 6 | `次: レビューを待つ` |
| 8 | F0 ＋ OPEN、CHANGES_REQUESTED | done×5 todo×3 | 6 | `次: 指摘を直す` |
| 9 | F0 ＋ OPEN、isDraft（reviewDecision は `''`） | done×5 todo×3 | 6 | `次: 草稿を解除する` |
| 10 | F0 ＋ MERGED | done×7 todo | 8 | `次: ブランチを削除` |
| 11 | F0 ＋ MERGED ＋ dirty | done done todo done×4 todo | 3 | `編集中` |
| 12 | F0 ＋ CLOSED | done×4 todo×4 | 5 | `次: PR を作り直す` |
| 13 | F0 ＋ dirty ＋ OPEN | done done todo done done skipped todo todo | 3 | `編集中` |
| 14 | F0 ＋ prKnown:false | done×4 unknown×4 | null | `今: PR 以降は不明` |
| 15 | F0 ＋ ahead:null | done unknown×3 todo×4 | null | `今: 判定できない` |
| 16 | F0 ＋ pushed:null | done done done unknown todo×4 | 5 | `次: PR を作る` |
| 17 | F0 ＋ MERGED ＋ ahead:null | done×7 todo | 8 | `次: ブランチを削除` |
| 18 | F0 ＋ dirty:null | done unknown unknown done todo×4 | null | `今: 判定できない` |
| 19 | F0 ＋ ahead:null ＋ prKnown:false | done unknown×7 | null | `今: 判定できない` |
| 20 | F0 ＋ MERGED ＋ pushed:null ＋ ahead:0 | done×7 todo | 8 | `次: ブランチを削除` |

  - `at`: 段階 1 は `createdAt`、2 は `firstCommitAt`、3 は `lastCommitAt`、4 は `pushedAt`、5 は `pr.createdAt`、6 は `latestReviews` の `submittedAt` の最大、7 は `pr.mergedAt`、8 は `null`。`status` が `done` でない段階の `at` は `null`。行 10 の段階 4（`pushedAt` が `null`）の `at` は `null`。
  - `note`: 段階 3 が `done` で `ahead` が 1 以上のときだけ `` `${ahead} 件` ``。ほかは `null`。
  - `buildRow('main','default',true,F0)` は `stages` が空で `now.text` が `既定`。
- [ ] **Step 2: テストを実行して失敗を確かめる**。
- [ ] **Step 3: 3 つの関数を実装する**。規則（設計書 4.2・4.3・4.4 の表）の要点:
  - 「今」は、`done`・`unknown`・`skipped` のいずれでもない最初の段階。
  - PR が MERGED なら、1〜7 を `done`（`ahead`・`pushed`・`dirty` が `null` でも）。そのうえで `dirty` が真なら段階 3 を `todo` に戻す。段階 8 は、MERGED のときだけ「今」になりうる。それ以外では、`unknown` でない限り常に `todo`。5〜7 のどれかが `unknown` なら 8 も `unknown`。
  - MERGED でなく `ahead` が `null` なら、2〜4 を `unknown` にし、`now` を `{ id: null, text: '今: 判定できない' }` にする（`prKnown` が偽でも、この文言を優先する）。`dirty` が `null` なら、2 と 3 を `unknown` にし、同じく `今: 判定できない` にする。`pushed` が `null` なら段階 4 を `unknown` にする。
  - `prKnown` が偽なら 5〜7 を `unknown`。「今」にできる段階がなければ `{ id: null, text: '今: PR 以降は不明' }`。
  - 段階 6: `isDraft` が先（`reviewDecision` が `''` でも草稿を優先）、次に `CHANGES_REQUESTED`、`REVIEW_REQUIRED`、`APPROVED`、最後に `''`（`skipped`）。
- [ ] **Step 4: テストを実行して通ることを確かめる**。
- [ ] **Step 5: Commit** — `feat: 段階の判定と「今」を追加する`

---

### Task 3: PR の採用

**Files:**
- Modify: `session-desk/hooks/branch.ts`
- Test: `session-desk/hooks/branch.test.tsx`

**Interfaces:**
- Consumes: Task 1 の `Pr`、`Relation`。
- Produces:
  - `parsePrList(json: string): Pr[] | null` — `gh pr list --state all --limit 200 --json number,state,isDraft,reviewDecision,createdAt,mergedAt,headRefName,headRefOid,isCrossRepository,latestReviews` の出力。JSON でなければ `null`。
  - `adoptPr(prs: readonly Pr[], relation: (pr: Pr) => Relation): { pr: Pr | null; known: boolean }`
    - `isCrossRepository` が真のものは無視する。OPEN があればそれ（複数なら `createdAt` が最新）。なければ、`relation` が `same` か `ancestor` の MERGED・CLOSED のうち `createdAt` が最新のもの。
    - 該当なしは `{ pr: null, known: true }`。ただし、MERGED・CLOSED のうち `relation` が `unknown` のものがあり、採れるものがないときは `{ pr: null, known: false }`。

- [ ] **Step 1: 失敗するテストを書く**。
  - `parsePrList('not json')` → `null`、`parsePrList('[]')` → `[]`。
  - **Review Focus 1**: 古い MERGED の PR 1 件（`relation` が常に `other`）だけ → `{ pr: null, known: true }`。
  - OPEN と MERGED（`ancestor`）が両方 → OPEN。OPEN が 2 件 → `createdAt` が新しい方。MERGED が 2 件（どちらも `ancestor`）→ 新しい方。
  - `isCrossRepository: true` の OPEN のみ → `{ pr: null, known: true }`。
  - MERGED 1 件で `relation` が `unknown` → `{ pr: null, known: false }`。
- [ ] **Step 2: テストを実行して失敗を確かめる**。
- [ ] **Step 3: 2 つの関数を実装する**。
- [ ] **Step 4: テストを実行して通ることを確かめる**。
- [ ] **Step 5: Commit** — `feat: PR の採用規則を追加する`

---

### Task 4: git と gh からの取得

**Files:**
- Create: `session-desk/hooks/git.ts`
- Test: `session-desk/hooks/git.test.tsx`

**Interfaces:**
- Consumes: Task 1〜3 のすべて。`stripControl`（`hooks/lib.ts`）。
- Produces:
  - `type Run = (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean }>`（`register.tsx` では `argv => $.process.run(argv, { timeoutMs: 15000, env: { LC_ALL: 'C' } })` を渡す。reject は `collect` の中で捕まえる）
  - `type Problem = 'not-repo' | 'no-commit' | 'unsafe-owner' | 'timeout' | null`
  - `type Snapshot = { cwd: string; gitAt: string; ghAt: string | null; problem: Problem; ghProblem: boolean; prs: Pr[] | null; prCapped: boolean; baseRef: string | null; branches: BranchRow[]; warnings: string[] }`（`gitAt`・`ghAt` は `HH:MM:SS`）
  - `pickBudget(names: readonly string[], current: string | null, selected: string | null, limit: number): string[]` — 現在、選択中、残りの名前順に並べて、先頭 `limit` 件。
  - `collect(run: Run, prev: Snapshot | null, opts: { withGh: boolean; cwd: string; selected: string | null; now: () => Date }): Promise<Snapshot>`
  - `detailOf(run: Run, name: string, baseRef: string | null): Promise<{ createdAt: string | null; firstCommitAt: string | null; pushedAt: string | null }>`
  - `requeryPr(run: Run, name: string, tip: string): Promise<{ pr: Pr | null; known: boolean }>`
  - `applyDetail(row: BranchRow, d: { createdAt: string | null; firstCommitAt: string | null; pushedAt: string | null }): BranchRow` — `facts` に上書きして `buildRow` で作り直す。

- [ ] **Step 1: 失敗するテストを書く**。偽の `run` は、argv の `[1]` が `--no-optional-locks` でなければテストを失敗させ、argv の先頭 3 要素（`git`・`--no-optional-locks`・サブコマンド）で答えを返す。
  - 通常: `main`（既定、`refs/remotes/origin/main` あり）、`feat/a`（ahead 2、origin に同名なし）、`docs/b`（origin と先頭が一致、MERGED の PR あり、`headRefOid` がローカルの先頭と一致）。`feat/a` の `now.text` が `次: push`、`docs/b` が `次: ブランチを削除`、`main` の `kind` が `'default'`。`dirty` は現在のブランチだけに付く（現在が `feat/a` のとき、`docs/b` の `facts.dirty` は偽）。
  - **基準の決定**: `refs/remotes/origin/main` がなく `refs/heads/main` だけあるときは、`baseRef` が `refs/heads/main`。どちらもなければ `baseRef` は `null` で、`ahead-behind` の列を取る呼び出しをしない。`origin/HEAD` の行は一覧に出ない。
  - **Review Focus 3**: gh の `run` が reject する／exitCode 1／`isStdoutTruncated` 真のそれぞれで、`ghProblem` が真、5〜8 が `unknown`、git の段階は変わらない。`ahead-behind` の呼び出しが exitCode 128 のとき、ブランチごとの `rev-list --count` で代える。git の出力が `isStdoutTruncated` 真のとき、ref 一覧（`for-each-ref` の 1 本目）が切れたら `branches` を空、`problem` を `null`、`warnings` を `['ブランチ一覧が長すぎます']` にする（`no-commit` にしない）。ほかの出力が切れたら、その情報だけを `null`（不明）にする。`no-commit` は、切れていない ref 一覧が空のときに限る。
  - `withGh: false` で `prev`（同じ `cwd`）があるとき、gh を呼ばず、`prev.prs` から PR を再計算する。`prev.cwd` が違うときは引き継がない。
  - **Review Focus 4**: ブランチが 40 本、すべて origin に同名があり先頭が食い違うとき、ブランチごとの追加の `run` は 30 回まで。現在のブランチ（名前順で最後）と選択中のブランチは、その 30 本に必ず入る。残りは `pushed: null`。`pickBudget` の単体テストも足す。
  - **問題の判定**: `rev-parse --git-dir` が exitCode 128 で stderr に `not a git repository` → `'not-repo'`。`dubious ownership` → `'unsafe-owner'`。ブランチ一覧が空 → `'no-commit'`。`run` が時間切れで reject → `'timeout'`。
  - `warnings`: HEAD が分離状態（`symbolic-ref -q HEAD` が exitCode 1）→ `HEAD は分離状態`。既定ブランチ上で `dirty` → `既定ブランチ上に未 commit の変更があります`。既定ブランチが `origin` より進んでいる（`rev-list --count <origin 側>..<ローカル>` が 1 以上）→ `既定ブランチに未 push の commit があります`。
  - 名前に `\u001b[31m` を含むブランチは、`stripControl` を通した名前が `name` に入る。
  - `detailOf`: 偽の `run` が reflog の出力を返すと、`createdAt`・`pushedAt`・`firstCommitAt`（`log --format=%cI --reverse <baseRef>..refs/heads/<名>` の最初の行。`lastCommitAt` と同じ committer 日時にそろえる）が入る。reflog が空なら `null`。`baseRef` が `null` なら `firstCommitAt` は `null`。
  - `status` が失敗した（exitCode 128）とき、現在のブランチの `facts.dirty` は `null`、`now.text` は `今: 判定できない`。
  - **予算の順序**: 40 本が全部 origin と食い違い、現在のブランチが名前順の最後、PR が MERGED のとき、現在のブランチは push の確認と祖先の確認の両方が予算内に入る。
  - `requeryPr(run, name, tip)`: `gh pr list --state all --head <名> --json …` の偽の出力から、`{ pr, known }` を返す（採用規則は `adoptPr`。MERGED は `headRefOid` が `tip` と一致すれば `same`、違えば `merge-base` を 1 本）。gh が失敗したら `{ pr: null, known: false }`。
  - `applyDetail`: `firstCommitAt` を入れると、`stages[1].at` が入り、`done` の段階が変わらない。
- [ ] **Step 2: テストを実行して失敗を確かめる**。
- [ ] **Step 3: `collect` などを実装する**。`collect` の手順と呼ぶコマンド（すべて `git --no-optional-locks` で始める）:
  1. 予算なしの固定の呼び出し: `rev-parse --git-dir`、`symbolic-ref -q refs/remotes/origin/HEAD`、`symbolic-ref -q HEAD`（`refs/heads/` を切って現在のブランチ名にする。exitCode 1 は分離状態）、`status --porcelain=v1 -z`（`isDirty`。現在のブランチだけに付ける。失敗したら現在のブランチの `dirty` は `null`）。
  2. 予算なし: `for-each-ref --format=%(refname)%09%(objectname)%09%(committerdate:iso-strict) refs/heads refs/remotes/origin` → `parseRefs`。`defaultBranchOf` で既定ブランチを決め、`baseRef` を決める（`refs/remotes/origin/<既定>` があればそれ、なければ `refs/heads/<既定>`、なければ `null`）。続けて、`baseRef` があれば `for-each-ref --format=%(refname)%09%(ahead-behind:<baseRef>) refs/heads` → `parseAhead`。既定ブランチの警告用に、`rev-list --count refs/remotes/origin/<既定>..refs/heads/<既定>` を 1 回（予算なし）。
  3. 予算なし: `withGh` なら `gh pr list --state all --limit 200 --json …` を 1 回。件数がちょうど 200 なら `prCapped` を真にする。ブランチごとの PR は、`headRefName` が一致するものだけを `adoptPr` に渡す。
  4. 予算（合計 30 本、1 つのカウンタ）あり: `pickBudget` の順にブランチを回し、各ブランチで次を順に行う。
     1. `ahead-behind` が失敗していたときだけ、`rev-list --count <baseRef>..<ref>`（`ahead`）。
     2. push の確認。origin の同名がなければ呼ばずに `pushed: false`。先頭が一致すれば呼ばずに `pushed: true`。違えば `rev-list --count refs/remotes/origin/<名>..refs/heads/<名>`（0 なら `pushed: true`）。
     3. 祖先の確認。そのブランチの PR のうち、OPEN がなく、採用候補になる MERGED・CLOSED の最新の 1 件について、`headRefOid` が先頭と一致すれば呼ばずに `same`、違えば `merge-base --is-ancestor refs/heads/<名> <headRefOid>`（0 → `ancestor`、1 → `other`、それ以外 → `unknown`）を 1 本。ほかの PR の `relation` は `other`。
     予算が尽きた分は、`ahead`・`pushed`・`relation` を `null`/`unknown` にする。`relation` は先にマップにして、同期の関数として `adoptPr` に渡す。`prCapped` で PR が見つからないブランチは `prKnown` を偽にする。
  5. `withGh: false` のときは 3 を呼ばず、`prev.prs`（同じ `cwd` のとき）を使って 4 の祖先の確認から先をやり直す。`prev.prs` がなければ `prKnown` は偽、`ghAt` は `null`。`prev.prs` を使うときは `ghAt` も引き継ぐ。
  6. `buildRow` で各ブランチを組み立てる。`lastCommitAt` は 2 の `committerdate`。
- [ ] **Step 4: テストを実行して通ることを確かめる**。
- [ ] **Step 5: Commit** — `feat: git と gh からの取得を追加する`

---

### Task 5: 更新の予約（エンジンに触れない部分）

**Files:**
- Create: `session-desk/hooks/refresh.ts`
- Test: `session-desk/hooks/refresh.test.tsx`

**Interfaces:**
- Produces:
  - `createRefresher(deps: { run: (withGh: boolean) => Promise<void>; now: () => number; delay: (ms: number) => Promise<void> }): { request(withGh: boolean): void }` — 規則（1 文）: 実行中なら、終了後にすぐ（`delay` なしで）1 回だけ追加で実行する（予約中の `withGh` は論理和）。実行中でなく、前回の開始から 2000 ms 未満なら、残りの時間だけ `delay` してから 1 回にまとめて実行する。
  - `wantsGh(command: string): boolean` — コマンドに、単語としての `gh`、または単語としての `git` と `push` の両方を含むとき真（`high`・`github`・`through` は偽）。
  - `ghDelayMs(failures: number): number` — `Math.min(60000 * 2 ** failures, 600000)`。
  - `around<T>(next: () => Promise<T>, after: () => void): Promise<T>` — `try { return await next() } finally { after() }`。

- [ ] **Step 1: 失敗するテストを書く**。偽の `now`・`delay` と、手動で終わらせられる `run` を使う。
  - 単発の `request(false)` で `run(false)` が 1 回。
  - **Review Focus 5**: `run` の実行中に `request` を 3 回続けると、実行中のものが終わったあとに追加で 1 回だけ（合計 2 回）。予約中に `request(true)` が混ざると、追加の 1 回は `withGh = true`。
  - 前回の開始から 500 ms 後の `request` は、`delay(1500)` を待ってから 1 回実行される。2000 ms 以上たっていれば `delay` なしで実行される。
  - `run` が reject しても、予約は止まらず、次の `request` で動く。
  - `wantsGh`: `'gh pr create'`・`'git push -u origin x'`・`'git -C x push'`・`'cd /d/x && gh pr view'` が真、`'ls high'`・`'echo github'`・`'git status'` が偽。
  - `ghDelayMs(0)` が 60000、`ghDelayMs(1)` が 120000、`ghDelayMs(9)` が 600000。
  - `around` は、`next` が reject しても `after` を 1 回呼んでから、同じ例外を投げ直す。
- [ ] **Step 2: テストを実行して失敗を確かめる**。
- [ ] **Step 3: 4 つを実装する**。
- [ ] **Step 4: テストを実行して通ることを確かめる**。
- [ ] **Step 5: Commit** — `feat: 更新の予約を追加する`

---

### Task 6: 状態と配線（`register.tsx`）

**Files:**
- Modify: `session-desk/hooks/register.tsx`、`session-desk/types/index.d.ts`
- Test: `session-desk/hooks/branch-refresh.test.tsx`

**Interfaces:**
- Consumes: Task 4 の `collect`、`Snapshot`。Task 5 の全部。
- Produces:
  - `types/index.d.ts`: `Tab` に `'branch'` を足す。`PluginState['session-desk']` に `snapshot: Snapshot | null`、`branchSel: string | null` を足す（`Shaped` は付けない。`tab` と同じ）。
  - `register.tsx`: atom `snapshot`（初期 `null`）、`branchSel`（初期 `null`）。`TABS` に `{ id: 'branch', label: 'ブランチ' }` を足し、`current === 'branch'` のとき、いまは `snapshot` が `null` なら `読み込み中`、そうでなければ空の `Box` を描く（本体は Task 7）。
  - `$` の持ち方: `session.start` フックの `$` を、`register` のクロージャ変数に保存する。refresher の `run` とタイマーは、その `$` を使う。`tool.call` フックの `$` は使わない（`e.command` を読むだけ）。
  - トップレベルの `refreshNow($: any, withGh: boolean): Promise<void>` — タブが表示中でなければ何もしない。`$.session.cwd()` を読み、`collect` を呼び、結果の `cwd` が現在の `$.session.cwd()` と違えば捨てる。`gh` が失敗したら、その回数を数え、次の gh までの間隔を `ghDelayMs` にする。
  - `tool.call` フック: `around(next, () => void refresher.request(wantsGh(command)))`。対象は `e.tool` が `Bash`・`Edit`・`Write`。
  - タイマー: `session.start` で `$.clock.every(10_000, …)` を 1 本。値はクロージャ変数（`Timer` のハンドル、gh の次の時刻、失敗の回数）に持ち、作る前に前のハンドルを `cancel` する。gh は、次の時刻を過ぎていれば `withGh = true`。
  - 「ブランチ」タブを押した瞬間に `refresher.request(true)`。

- [ ] **Step 0: 確かめる（結果を報告に書く）**。(a) `on('process.run', …)`・`on('clock.every', …)`・`on('session.cwd', …)`・`on('ui.panes', …)` でテストが差し替えられるか。戻り値の形（`{ value }` か素の値か）は、既存テストの `store.get`（`{ value }`）、`session.start`（素の値）と見比べて決める。(b) 差し替えない `clock.every` が、テスト中に定期発火するか。(c) `session.start` の `$` が、そのあとのタイマーの中や `tool.call` の後でも使えるか。(a) ができなければ、この Task のテストは `refreshNow` の呼び出しを確かめる範囲に絞り、`refresh.test.tsx` で代える。(c) ができなければ、10 秒の周期だけに頼り、報告に書く。
- [ ] **Step 1: 失敗するテストを書く（`branch-refresh.test.tsx`）**。
  - 「ブランチ」タブ（`ui.press({ key: 'tab-branch' })`）を押すと git が呼ばれ、「定型文」のタブでは呼ばれない。
  - パネルが置かれていない（`ui.panes()` の `isPlaced` が偽）とき、タブが `branch` でも git は呼ばれない。
  - `tool.call`（Bash）が済むと git が呼ばれる。`gh pr create` を含むと gh も呼ばれ、`ls high` では呼ばれない。
  - `session.start` を 2 回発火しても、タイマーは 1 本（前のものが `cancel` される）。
  - 既存の 35 件が通る。
- [ ] **Step 2: テストを実行して失敗を確かめる**。
- [ ] **Step 3: Interfaces のとおりに実装する**。`Tab` を使う既存の分岐は、`'branch'` を足しても今までの動作が変わらないようにする。
- [ ] **Step 4: テストを実行して通ることを確かめる**。
- [ ] **Step 5: Commit** — `feat: ブランチタブの状態と更新の配線を追加する`

---

### Task 7: 表示

**Files:**
- Create: `session-desk/hooks/branch-view.tsx`
- Modify: `session-desk/hooks/register.tsx`（Task 6 の空の `Box` を `renderBranchTab` に替える）
- Test: `session-desk/hooks/branch-view.test.tsx`

**Interfaces:**
- Consumes: Task 4 の `Snapshot`、Task 2 の `BranchRow`。`ui.resolve(e)` の `Box`・`Text`・`Button`。
- Produces:
  - `formatAt(iso: string, offsetMin: number): string` — `offsetMin`（東が正）の時刻で `MM/DD HH:mm`。例: `formatAt('2026-11-05T02:40:00Z', 540)` → `'11/05 11:40'`。
  - `renderBranchTab(ui: { Box; Text; Button }, a: { snapshot: Snapshot | null; selected: string | null; columns: number; offsetMin: number; onSelect(name: string): void }): JSX.Element`（`columns` は `e.props.bodyColumns`）

- [ ] **Step 1: 失敗するテストを書く**（`quick.test.tsx` の `PANE` の流儀。`snapshot` は atom に直接入れる）。描画の期待:
  - 見出しは `Text` で `ブランチ 3`（本数）。一覧の行は `Button`（`key: 'branch-<名前>'`、`plain`）で、`label` が `` `${印}${種類} ${名前}  ${now.text}` ``。印はチェックアウト中が `＊`、それ以外は全角空白。種類は `feat`・`fix`・`docs`・`chore`・`その他`・`既定`。
  - 最初に選ばれているのは、チェックアウト中のブランチ（分離状態で現在のブランチがなければ、一覧の先頭）。別の行のボタンを押すと `onSelect` が呼ばれる。
  - 経過は段階の順に `Text`: `` `${記号} ${label}  ${formatAt(at) または —}` ``（日時を出すのは `done` だけで、`at` が `null` なら `—`。`done` でない段階は日時の欄を空にする。`note` があれば末尾に `  ${note}`）。「今」の段階は、記号が `●` で、末尾に `  ${now.text}`。`default` を選んだときは `経過はありません（既定ブランチ）`。
  - `columns` が 100 未満なら、一覧と経過を縦に並べる `Box`（`key: 'branch-narrow'`、`flexDirection: 'column'`）。100 以上なら `key: 'branch-wide'`、`flexDirection: 'row'`。
  - 最終行は `` `git ${gitAt} / gh ${ghAt ?? '不明'}` ``。`warnings` は一覧の下に 1 行ずつ。`problem` の文は `Git のリポジトリではありません`・`commit がまだありません`・`リポジトリの所有者が違います`・`取得が時間切れです`。`snapshot` が `null` なら `読み込み中`。
  - すべての文字は `stripControl` を通る（名前に `\u001b[31m` を含めたテストを 1 つ足す）。
- [ ] **Step 2: テストを実行して失敗を確かめる**。
- [ ] **Step 3: 実装して `register.tsx` につなぐ**。`offsetMin` は `-new Date().getTimezoneOffset()`。
- [ ] **Step 4: テストを実行して通ることを確かめる**。
- [ ] **Step 5: Commit** — `feat: ブランチタブの表示を追加する`

---

### Task 8: 選択と詳細の取得

**Files:**
- Modify: `session-desk/hooks/register.tsx`、`session-desk/hooks/git.ts`
- Test: `session-desk/hooks/branch-select.test.tsx`

**Interfaces:**
- Consumes: Task 4 の `detailOf`、`applyDetail`、`requeryPr`、Task 6 の `refreshNow`。
- Produces: `onSelect` の中身（`branchSel` を更新し、`detailOf` で日時を取って `snapshot` の該当ブランチに `applyDetail` する）。更新（`refreshNow`）のたびに、選択中ブランチの `detailOf` もやり直す。`prCapped` が真で、選択中ブランチの PR が見つかっていないときは、`requeryPr` で引き直し、結果で `facts.pr`・`facts.prKnown` を直して `buildRow` で作り直す。`process.run` の差し替えが Task 6 の Step 0 でできなかったときは、`Run` を直接渡せる関数を `branch-select.test.tsx` から呼んで確かめる。

- [ ] **Step 1: 失敗するテストを書く**。
  - ブランチを押すと、そのブランチの `detailOf` が呼ばれ、経過に日時が出る。別のブランチでは呼ばれない。
  - 選択中のブランチが更新でなくなったとき、`branchSel` が `null` に戻り、一覧の先頭の選択がチェックアウト中のブランチに戻る。
  - `prCapped` が真で、選択中ブランチの PR が一覧にないとき、`--head <名前>` の gh 呼び出しが 1 回行われ、見つかった PR が反映される。
- [ ] **Step 2: テストを実行して失敗を確かめる**。
- [ ] **Step 3: 実装する**。
- [ ] **Step 4: テストを実行して通ることを確かめる**。
- [ ] **Step 5: 実機で確かめる**。`claude --plugin-dir ./session-desk` で起動し、「ブランチ」タブで、このリポジトリの `main` と作業ブランチが出ること、commit・push のあとに自動で変わること、日本語名のブランチが読めること、幅を変えたときに並びが変わることを見る。見られなかったことは「未確認」と書く。
- [ ] **Step 6: Commit** — `feat: ブランチの選択と詳細の取得を追加する`

---

### Task 9: 文書

**Files:**
- Modify: `README.md`、`session-desk/.claude-plugin/plugin.json`

- [ ] **Step 1: README を直す**。「機能」の表に「ブランチ」タブの行を足す。「使い方」に節「ブランチ」を足す（一覧、経過の読み方、記号、更新のしかた、`gh` がないと PR 以降が「不明」になること、`git fetch` はしないので origin の情報は手元に取り込み済みの分であること、鮮度の行の読み方）。「前提条件」に、`git` 2.41 以上と、あれば `gh`（PR 以降の表示に使う。なくても動く）を書く。「できないこと」に、リリースの状態、CI・マージ競合の状態を出さないことを 1 行ずつ書く。画像（`docs/panel.svg`）の説明にタブが 3 つになったことを反映する。
- [ ] **Step 2: `plugin.json` の `description` を直す**。「履歴・定型文」に「ブランチ」を足す。version は上げない（リリースの段階で決める）。
- [ ] **Step 3: 検査する**。`claude plugin validate session-desk --strict` が終了コード 0。`claude plugin test session-desk` がすべて通る。
- [ ] **Step 4: Commit** — `docs: README にブランチタブの説明を追加する`

---

## 自己点検の結果

- 設計書との対応: 2・3 章 → Task 4〜8、4.1 → Task 1・4、4.2・4.3 → Task 2、4.4 → Task 3・8、5 章 → Task 7・8、6.1 → Task 4、6.2 → Task 5・6、7 章 → Task 1〜9（純粋な関数のテスト、README）。設計書 8 章の「作り手に任せること」のうち、日時の形式（`MM/DD HH:mm`）、幅の境目（100 列）、30 本の順序は、この計画で決めた。
- 計画で決めた、設計書にないこと: ref を完全修飾にすること、`LC_ALL=C` を付けること、`ahead-behind` が使えないときの代わり（`rev-list`）、MERGED のとき `ahead` が `null` でも 1〜7 を済にすること（設計書 4.3 の MERGED 優先の延長）。
- 未検証（Task 6 の Step 0 で確かめる）: `on('process.run' | 'clock.every' | …)` による差し替えの戻り値の形、差し替えない `clock.every` の挙動、`tool.call` のフックが返ったあとに `$` が使えるか。
