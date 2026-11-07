# セッション帯と停止時の選択肢 Implementation Plan

> **古い記録。** 作った時点の計画・設計で、その後に変わった（タブの名前は「Git」、段階は 8、ボタンや見た目など）。今の仕様は README と docs の図を見る。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Session Desk の全タブの最上部に、ゴール・実行状態・モデル・コンテキスト内訳・利用上限・ブランチを出す「セッション帯」と、ターン停止時に人の判断が要るときの選択肢（クリックで送信）を足す。タブ「ブランチ」を「Git」に改名する。

**Architecture:** 判定・整形・fork の返答の解析は、エンジンに触れない純粋な関数として `hooks/band.ts` に置く。表示は `hooks/band-view.tsx`。状態・イベント・タイマー・fork の配線は、既存の `hooks/register.tsx` に足す。git の軽い読み取り（今のブランチ名と未 commit の数）は `hooks/git.ts` と `hooks/branch.ts` に足す。

**Tech Stack:** TypeScript / JSX（Claude Code の mod API。`claude-code`、テストは `claude-code/testing`）。外部コマンドは `git`（既存）。

**Spec:** `docs/superpowers/specs/2026-11-07-session-band-design.md`（この計画では「設計書 4.4」のように章で引く）。画面の細部は、設計書の先頭にある Artifact を正とする。

## Global Constraints

- Claude Code 2.1.319、Windows 11。
- 取得は `$` の API だけ。通常の外部通信は `$.model.fork` だけ。例外は、既存の gh と、「正確に数える」ボタン（`breakdown: 'full'`）。
- `$.model.fork` は `effort: 'low'`、`turn.complete` の `next(e)` を先に返してから、await せずに呼ぶ。
- 選択肢は最大 4 個、1 つ 40 字以内。超えたものは切らずに捨てる。`goal` は 40 字、`reason` は 30 字以内。
- 使用率の数字: 80% 以上で黄、95% 以上で赤。バーの色はカテゴリの色（メッセージ `#61afef`、MCP ツール `#c678dd`、システムツール `#56b6c2`、システムプロンプト `#7ec699`、メモリファイル `#e5c07b`、スキル `#d19a66`、空き `#55555a`、その他 `#8b8b8b`）。色は 16 進で渡せる（型の `Color` は任意の文字列）。
- 画面に出す文字列（ゴール・理由・選択肢・ツール名・ブランチ名）は、すべて `stripControl`（`hooks/lib.ts`）を通し、空白（改行を含む）を 1 つにまとめる。`$.model.fork` の返答の全文は、ログ・トースト・画面に出さない。
- リモート URL は、必ず `tidyUrl`（`hooks/branch.ts`）を通す。
- 取れなかった値は 0 や「なし」にせず、その項目を行ごと出さない。
- 更新: `turn.start`・`turn.complete`・`tool.call` のたびと、既存の 10 秒タイマー。コンテキストの色分けのため、`breakdown: 'summary'` を毎回取る（無料）。他のタブが表示中は、git は今のブランチ名と未 commit の数だけを読む。
- 危険な語（削除、消去、push、force、reset、rm、drop、`--no-verify`）を含む選択肢は、2 回押して送る。
- テスト: リポジトリのルートで `claude plugin test session-desk`。検査: `claude plugin validate session-desk --strict`。型検査: `tsc -p session-desk --noEmit`。
- 既存のテストは、`clock.every` を拒否する。タイマーを前提にせず、イベント（`turn.*`・`tool.call`）を起こして検証する。
- 作業は `feat/session-band` ブランチで行う。設計書と計画書を含む `docs/session-band-design` から切る（設計書の PR のマージ前のため）。

## Review Focus

設計書が明示していない入力。それぞれ担当のタスクにテストを足す。

1. `$.model.fork` の返答が壊れた JSON、前後に説明文つき、空配列、改行入り、長すぎる文字列のとき → 前回のゴールを残し、選択肢は出さず、エラーを出さない（Task 4、Task 10）。
2. 選択肢・ゴールに ANSI の ESC 列や双方向制御文字（U+202E）が入っているとき → 除いて出す（Task 4、Task 6）。
3. リモート URL に `https://user:token@github.com/a/b.git` が入っているとき → `token` を画面に出さない（Task 2）。
4. `rateLimits` が空、`usage` が取れない、Git のリポジトリでないとき → 該当行だけを出さず、帯の残りは出る（Task 6、Task 8）。
5. 選択肢の二度押し、送信の失敗、古いターンの結果が遅れて返ったとき → 一度だけ送る、失敗なら戻す、古い結果は捨てる（Task 10）。

---

## File Structure

| ファイル | 役割 |
|---|---|
| `hooks/band.ts`（新規） | 純粋な関数: 整形、色の判定、バーの分割、fork の返答の解析、危険語の判定、実行状態とサブエージェントの集計 |
| `hooks/band-view.tsx`（新規） | 帯・内訳・サブエージェント一覧・選択肢の描画。git も `$` も呼ばない |
| `hooks/register.tsx`（変更） | atom、イベント、タイマー、fork、タブ名の変更 |
| `hooks/branch.ts`・`hooks/git.ts`（変更） | 未 commit の数、軽い読み取り |
| `hooks/branch-view.tsx`（変更） | リモート URL の行を目立たせる |
| `hooks/test-kit.tsx`（変更） | `labelsOf(tree)`: Button の `label` を描かれた順に集める |
| `types/index.d.ts`（変更） | `Tab` 型と新しい atom の型（自己完結。import 不可なので、型は d.ts の中に書く） |
| `hooks/band.test.tsx`・`band-view.test.tsx`・`band-wiring.test.tsx`・`band-fork.test.tsx`（新規） | テスト |

atom の名前（設計書 5 章と同じ）: `band`、`bandUi`、`agentsView`、`usageView`、`bandGit`。

---

### Task 1: 設計書 9 章の未検証項目を確かめる

**Files:**
- Create（コミットしない）: `session-desk/hooks/_probe.ts`、`session-desk/hooks/_probe.tsx`（実機で確かめる使い捨ての mod）
- Modify: `docs/superpowers/specs/2026-11-07-session-band-design.md`（9 章の表に「確認結果」の列を足す）

**Interfaces:**
- Produces: 9 章の各行が「成立 / 外れ」で埋まる。確かめられなかった行は、「外れたときの扱い」を既定として後続のタスクが従う。カテゴリ名の実際の文字列の一覧（Task 3 が使う）。テスト用の差し替え名の一覧（Task 7 以降が使う）。

- [ ] **Step 1: 型の存在を調べる。** `_probe.ts` に次を書き、`tsc -p session-desk --noEmit` を実行する。終了コード 0 なら、形は型定義と合う。
  - `$.model.fork({ prompt, effort: 'low' })` の結果の `isAnswered`・`text`
  - `$.session.usage()` の `rateLimits[0].kind`・`percentUsed`・`resetsAt`、`context.percent`・`context.tokens`・`context.window`、`usage({ breakdown: 'summary' })` の `context.breakdown` の `categories`（各行の `name`・`kind`・`tokens`）・`rawMaxTokens`・`autoCompactThreshold`・`isAutoCompactEnabled`・`mcpTools`・`memoryFiles`・`skills`、`$.session.model()`
  - `$.agent.list()` の `id`・`type`・`description`・`status`
  - `on('turn.start')`・`on('turn.complete')`・`on('agent.spawn')` の入力（`turnId`・`agentId`・`durationMs`・`usage` の項目名）と、`agent.spawn` の `await next(e)` の結果の `agentId`
- [ ] **Step 2: 実機で確かめる。** `_probe.tsx` は、次を `$.ui.log` に出すだけの mod にする。`claude --plugin-dir <probe フォルダ>` で起動し、短い会話をして、ログを読む。
  - `usage({ breakdown: 'summary' })` の `categories` の `name` の一覧（Task 3 の `classifyCategory` が使う）。
  - `turn.complete` の中で `next(e)` のあとに `$.model.fork` を呼んだとき、`turn.start`・`turn.complete`・`tool.call` が fork のために起きるか。
  - サブスクリプション外で `rateLimits` が空か。`AgentStatus` の実際の値。
  - 確かめられなかった項目は、既定に倒す。fork が起こすイベントは、**常に**無視する。名前が分からないカテゴリは `other` にする。
- [ ] **Step 3: テスト用の差し替えの書き方を調べる。** `claude-code/testing` の型を読み、`$.model.fork`・`$.session.usage`・`$.session.model`・`$.agent.list`・`$.prompt.submit`・`$.ui.toast`・`$.session.cwd` を差し替える `on('<呼び出し名>', handler)` の名前と、イベント（`turn.complete` など）を起こす関数を特定し、結果を 9 章の表の下に書く。
- [ ] **Step 4: `_probe.*` を消し、設計書だけをコミットする。**
  ```bash
  git add docs/superpowers/specs/2026-11-07-session-band-design.md
  git commit -m "docs: 設計書の未検証項目の確認結果を書く"
  ```

---

### Task 2: タブ名「Git」とリモート URL の行

**Files:**
- Modify: `session-desk/types/index.d.ts`、`session-desk/hooks/register.tsx`、`session-desk/hooks/branch-view.tsx`、および ブランチタブの id や key を使う全テスト（`grep -rnE "'branch'|tab-branch" session-desk/` で洗い出す）
- Test: `session-desk/hooks/branch-view.test.tsx`、`session-desk/hooks/toggle.test.tsx`

**Interfaces:**
- Produces: `type Tab = 'history' | 'quick' | 'git'`。タブの Button の `key` は `tab-git`。タブの表示名は「Git」。`renderBranchTab` のリモート行は、名前と URL を別の `Text` で描く。更新失敗のトーストは「Git タブを更新できませんでした」。

- [ ] **Step 1: 失敗するテストを書く。**
  - `branch-view.test.tsx` に `test('remote line shows the origin name and the URL in separate texts', …)`: `remotes: [{ name: 'origin', url: 'github.com/a/b' }]` を渡し、`textsOf` に `'origin'` と `'github.com/a/b'` が別々の要素として含まれることを検証する。
  - 同ファイルに `test('a token in a remote URL never reaches the screen', …)`: `renderBranchTab` に `url: 'https://user:tok123@github.com/a/b.git'` を直接渡し（`parseRemotes` を通さず）、描かれた全文字列に `tok123` が含まれないことを検証する。これは回帰テストで、表示側でも `tidyUrl` を通すことを守る。実装前は、このテストだけ失敗する。
  - `toggle.test.tsx` に Pane の mount 引数（`component: 'Pane'`、`requestId: 'session-desk'`、`props` に `bodyColumns` など）を足し、`test('tabs are ordered quick, history, git', …)`: タブの Button の `label` が `['▸ 定型文', '履歴', 'Git']` の順であることを検証する。
- [ ] **Step 2: テストを実行して失敗を確かめる。** `claude plugin test session-desk` → 上の 3 件が失敗する。
- [ ] **Step 3: 実装する。** `'branch'` を `'git'` に（`Tab` 型、`TABS`、`refreshNow`、`selectTab`、描画の分岐、`tab-branch` の key、既存テスト）、`TABS` の `label` を `'Git'` に置き換える（`SHAPE` は上げない）。`branch-view.tsx` の `remoteLines` を、`{ name, url }` を返す形にして、URL を `tidyUrl` に通し、名前を `color="suggestion"`、URL を本文色（`dimColor` なし）の別の `Text` で描く。リモートなし・不明・origin なしの文言は、今のまま。
- [ ] **Step 4: 全テストが通ることを確かめる。** `claude plugin test session-desk` がすべて通る。
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk
  git commit -m "feat: ブランチタブを Git に改名し、リモート URL を目立たせる"
  ```

---

### Task 3: 帯の表示用の純粋な関数

**Files:**
- Create: `session-desk/hooks/band.ts`
- Test: `session-desk/hooks/band.test.tsx`

**Interfaces:**
- Produces（すべて `band.ts` から export）:
  - `type CategoryId = 'messages' | 'mcp' | 'systemTools' | 'systemPrompt' | 'memory' | 'skills' | 'other' | 'free'`、`CATEGORY_COLORS: Record<CategoryId, string>`（Global Constraints の値）
  - `classifyCategory(c: { name: string; kind: 'used' | 'free' | 'buffer' | 'deferred' }): CategoryId`
  - `usageColor(percent: number): 'normal' | 'warning' | 'error'`
  - `formatDuration(ms: number): string`、`formatTokens(n: number): string`、`formatRemaining(resetsAtIso: string, nowMs: number): string | null`
  - `barCells(parts: { id: CategoryId; tokens: number }[], percent: number, width: number): { id: CategoryId; cells: number }[]`（`percent` は `context.percent`。使用分の長さは `round(percent / 100 × width)`、その中を `parts` の比率で分ける。残りは `free`）
  - `compactIn(tokens: number, threshold: number | undefined, enabled: boolean): number | null`
  - `type LimitRow = { label: '5時間枠' | '7日枠'; percent: number; remaining: string | null }`、`limitRows(rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[], nowMs: number): LimitRow[]`

- [ ] **Step 1: 失敗するテストを書く（`band.test.tsx`）。**
  - `usageColor`: 79→`'normal'`、80→`'warning'`、94→`'warning'`、95→`'error'`。
  - `formatDuration`: 42_000→`'0m42s'`、102_000→`'1m42s'`、3_660_000→`'1h01m'`。`formatTokens`: 999→`'999'`、18_000→`'18k'`、860_000→`'860k'`、1_200_000→`'1.2M'`。
  - `formatRemaining`: 現在から 3 時間 10 分後→`'3h 10m'`、45 分後→`'45m'`、2 日 3 時間後→`'2d 3h'`。過去・不正な日付→`null`。
  - `barCells`: 幅 16、`percent` 58、parts が messages 800k・mcp 28k・systemTools 16k・systemPrompt 8k・memory 5k・skills 4k のとき、使用分が 9 マス、各項目が 1 マス以上、`free` が 7 マス、合計 16。トークン 0 の項目は 0 マス。`percent` 0 のとき、全部 `free`。
  - `classifyCategory`: `kind: 'free'`→`'free'`。`buffer`・`deferred`・名前が未知→`'other'`。名前は Task 1 の一覧どおりに、メッセージ・MCP・システムツール・システムプロンプト・メモリ・スキルへ。
  - `compactIn`: 860_000 トークン・閾値 900_000・有効→40_000。無効・閾値なし→`null`。閾値を超えていれば 0。
  - `limitRows`: `[]`→`[]`。`five_hour` と `seven_day` だけを返し、`spend_limit` は捨てる。
- [ ] **Step 2: テストを実行して失敗を確かめる。** `claude plugin test session-desk` → `band.test.tsx` が import で失敗する。
- [ ] **Step 3: 上の署名どおりに `band.ts` を実装する。** `barCells` は、0 より大きい項目に最小 1 マスを与え、足りない分は最大の項目から引く。
- [ ] **Step 4: テストが通ることを確かめる。**
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk/hooks/band.ts session-desk/hooks/band.test.tsx
  git commit -m "feat: 帯の整形と色分けの関数を足す"
  ```

---

### Task 4: fork の返答の解析、危険語、実行状態、サブエージェントの集計

**Files:**
- Modify: `session-desk/hooks/band.ts`
- Test: `session-desk/hooks/band.test.tsx`

**Interfaces:**
- Consumes: Task 3 の `band.ts`、`stripControl`（`lib.ts`）。
- Produces（すべて `band.ts` から export）:
  - `parseForkReply(text: string, prevGoal: string | null): { goal: string | null; reason: string; steps: string[] }`（`goal` は壊れたとき・長すぎるとき `prevGoal`、`reason` は壊れたとき・長すぎるとき `'判断待ち'`）
  - `isRiskyStep(text: string): boolean`
  - `type RunState = { startedAt: number | null; tools: { id: number; name: string }[] }`、`startTurn(now: number): RunState`、`addTool(s: RunState, id: number, name: string): RunState`、`removeTool(s: RunState, id: number): RunState`、`toolLabel(s: RunState): string | null`（最も古い 1 件の名前。2 件以上なら `名前 +n`）
  - `type AgentRow = { id: string; type: string; description: string; state: 'running' | 'waiting' | 'done'; elapsedMs: number | null }`、`summarizeAgents(list: { id: string; type: string; description: string; status: string }[], startedAt: ReadonlyMap<string, number>, nowMs: number): { running: number; rows: AgentRow[] }`
  - `nextAgentsOpen(prev: { running: number; closedByUser: boolean }, running: number): { open: boolean; closedByUser: boolean }`（`closedByUser` は呼び出し側が、手で閉じたとき `true` にして渡す）

- [ ] **Step 1: 失敗するテストを書く。**
  - `parseForkReply`（Review Focus 1・2）:
    - 正しい JSON `{"goal":"A","reason":"R","steps":["x","y"]}`→`goal: 'A'`、`reason: 'R'`、`steps: ['x','y']`。
    - 前後に説明文がある `ok {"goal":"A","steps":[]} end`→`goal: 'A'`、`steps: []`。
    - 壊れた JSON、`goal` が数値→`goal` は `prevGoal`、`steps: []`、`reason: '判断待ち'`。
    - 境界: 40 字ちょうどの `goal` と選択肢は残り、41 字の選択肢は捨てる。30 字ちょうどの `reason` は残り、31 字は `'判断待ち'`。41 字の `goal` は `prevGoal` に戻るが、`steps` は残る。
    - `steps` が 5 個→先頭の 4 個。
    - `steps` の文字列に ESC 列（`'\u001b[31mx\u001b[0m'`）と U+202E を含む→除かれる。改行入り（`'a\nb'`）→空白 1 つにまとめて `'a b'`。
  - `isRiskyStep`: `'ブランチを削除する'`・`'git push する'`・`'rm -rf build'`・`'--no-verify で commit'`・`'Force push'`・全角の `'ｐｕｓｈ する'`→真。`'テストを実行する'`→偽。
  - `RunState`: `addTool`×2→`toolLabel` が `'Bash +1'`。`removeTool` で 1 件に戻ると `'Edit'`。0 件→`null`。
  - `summarizeAgents`: `running`・`pending`→`running` に数え、`waiting`・`idle`→`state: 'waiting'` で数えず、`completed`・`failed`・`killed`→`done` で数えない。`startedAt` に無い id は `elapsedMs: null`。
  - `nextAgentsOpen`: 0→1 で `open: true`、`closedByUser: false`。`closedByUser: true` で 1→2 では `open: false` のまま。1→0 で `closedByUser` が `false` に戻る。
- [ ] **Step 2: テストを実行して失敗を確かめる。**
- [ ] **Step 3: 実装する。** `parseForkReply` は、最初の `{` から最後の `}` までを `JSON.parse` し、文字列を `stripControl` に通して空白を 1 つにまとめてから長さを検査する。`isRiskyStep` は、`normalize('NFKC')` したあと `/削除|消去|push|force|reset|\brm\b|\bdrop\b|--no-verify/i`。
- [ ] **Step 4: テストが通ることを確かめる。**
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk/hooks/band.ts session-desk/hooks/band.test.tsx
  git commit -m "feat: fork の返答の解析と実行状態の集計を足す"
  ```

---

### Task 5: 今のブランチ名と未 commit の数

**Files:**
- Modify: `session-desk/hooks/branch.ts`、`session-desk/hooks/git.ts`、`session-desk/hooks/register.tsx`（`refreshNow` と `bandGit` の atom）、`session-desk/types/index.d.ts`（`bandGit` の型）
- Test: `session-desk/hooks/branch.test.tsx`、`session-desk/hooks/git.test.tsx`、`session-desk/hooks/branch-refresh.test.tsx`

**Interfaces:**
- Produces:
  - `parseDirtyCount(porcelainZ: string): number`（`branch.ts`）
  - `collectLight(run: Run): Promise<{ isRepo: boolean; branch: string | null; dirtyCount: number | null }>`（`git.ts`。呼ぶ git は `symbolic-ref -q HEAD`（`refs/heads/` を落とす）と `status --porcelain=v1 -z` の 2 本だけ。`status` が失敗したら `isRepo: false`。detached HEAD は `branch: null`、`isRepo: true`）
  - atom `bandGit: { branch: string | null; dirtyCount: number | null } | null`（`null` は Git のリポジトリでない）。`refreshNow` が書く。Task 7 が描く。

- [ ] **Step 1: 失敗するテストを書く。**
  - `branch.test.tsx`: `parseDirtyCount('')`→0、`'M  a\0?? b\0'`→2、改名 `'R  new\0old\0 M c\0'`→2（改名の旧パスは数えない）。
  - `git.test.tsx`: `collectLight` に偽の `Run` を渡す。`status` の出力が `' M a\0'` のとき `dirtyCount: 1`。`symbolic-ref` が失敗のとき `branch: null` かつ `isRepo: true`。`status` が失敗のとき `isRepo: false`。呼ばれた argv が 2 本だけで、`for-each-ref` と `gh` を含まない。
  - `branch-refresh.test.tsx`: 他のタブ（定型文）が表示中でパネルが `isPlaced` のとき、更新で `for-each-ref` が呼ばれず、`collectLight` の 2 本だけが呼ばれる。パネルが placed でないときは何も読まない（既存のテストのまま）。作業フォルダが取得中に変わったら捨てる。Git タブ表示中は、今までどおり全体を読み、加えて `collectLight` の 2 本が呼ばれる。
- [ ] **Step 2: テストを実行して失敗を確かめる。**
- [ ] **Step 3: 実装する。** `refreshNow` の先頭を、パネルが `isPlaced` かの確認が先、タブの確認がその後、の順にする。他のタブなら、`collectLight` を呼び、`$.session.cwd()` が取得前と同じときだけ `bandGit` を書いて return する。Git タブ表示中は、既存の処理のあとに `collectLight` を呼んで `bandGit` を書く（git が 2 本増える）。`session.start` で、最初の更新の `request` を 1 回出す。
- [ ] **Step 4: テストが通ることを確かめる。** `claude plugin test session-desk` がすべて通る。
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk
  git commit -m "feat: 他のタブでも今のブランチと未 commit の数を読む"
  ```

---

### Task 6: 帯の描画

**Files:**
- Create: `session-desk/hooks/band-view.tsx`
- Modify: `session-desk/hooks/test-kit.tsx`（`labelsOf` を足す）
- Test: `session-desk/hooks/band-view.test.tsx`

**Interfaces:**
- Consumes: Task 3・4 の型と関数、`stripControl`、`textsOf`・`labelsOf`（`test-kit.tsx`）。
- Produces: `renderBand(ui: { Box: any; Text: any; Button: any }, a: BandArgs): unknown`。`BandArgs` の形:
  - `goal: string | null`
  - `run: { state: 'running' | 'stopped' | null; tool: string | null; elapsedMs: number | null }`、`lastTurn: { durationMs: number; tokens: number } | null`、`stop: 'error' | 'refusal' | 'aborted' | null`
  - `agents: { running: number; rows: AgentRow[]; open: boolean }`
  - `model: string | null`、`context: { percent: number; tokens: number; window: number; parts: { id: CategoryId; tokens: number }[] } | null`
  - `breakdown: { open: boolean; rows: { id: CategoryId; name: string; tokens: number; percent: number; detail: { name: string; tokens: number }[] | null; detailOpen: boolean }[]; compactIn: number | null; threshold: number | null } | null`
  - `limits: LimitRow[]`、`git: { branch: string | null; dirtyCount: number | null } | null`
  - `steps: { items: string[]; reason: string; confirming: number | null } | null`（実行中は呼び出し側が `null` を渡す）
  - `on: { toggleBreakdown(): void; toggleAgents(): void; exact(): void; toggleDetail(id: CategoryId): void; pick(i: number): void; confirm(i: number): void; cancel(): void }`
  - 描画するボタンの `key`: `band-breakdown`・`band-agents`・`band-exact`・`band-detail-<id>`・`band-step-<i>`・`band-step-confirm-<i>`・`band-step-cancel`
  - 文字の分け方: 「実行中 Bash」と「0m42s」は、別の `Text`。「直近 1m42s」と「18k tokens」も別の `Text`。

- [ ] **Step 1: 失敗するテストを書く。** 文字は `textsOf`、Button の `label` は `labelsOf`、色は描かれた木の `Text` の `color` で検証する。
  - ゴール: `goal: 'G'` のとき `'G'` が出る。`goal: null` のとき「ゴール」が出ない。
  - 実行状態: `running`・`tool: 'Bash'`・`elapsedMs: 42000` のとき `'実行中 Bash'` と `'0m42s'`。`stopped` のとき `'停止中'`、`'直近 1m42s'`、`'18k tokens'`。`stop: 'error'` のとき `'エラーで停止'`、`'refusal'` のとき `'拒否で停止'`、`'aborted'` のとき `'中断'`。
  - サブエージェント: `running: 0` のとき「サブエージェント」が出ない。`running: 2`・`open: true` のとき件数と各行の種類・内容・状態が出て、実行中の行は青の「●」、待機は灰色の「○」。`open: false` のとき一覧が出ず、`band-agents` が `'▾ 開く'`。
  - モデルとコンテキスト: `model: 'Opus 5.5'` が出る。`context.percent: 86` のとき `'86%'` が `warning` の色、79 のとき `normal`、95 のとき `error`。`'860k / 1M'` が出る。`context: null` なら「コンテキスト」が出ない（Review Focus 4）。
  - 上限: `limits` に `{ label: '5時間枠', percent: 32, remaining: '3h 10m' }` のとき、`'5時間枠'`・`'32%'`・`'3h 10m'`。`limits: []` なら「枠」が出ない。`git: null` なら 1 行ごと出ない。`git.dirtyCount: 3` のとき `'未 commit 3'`、`null` のとき数が出ない。`git.branch: null` のとき `'(detached)'`。
  - 内訳: `open: false` のとき内訳の行が出ず、`band-breakdown` が `'▸ 内訳'`。`open: true` のとき `'▾ 内訳'`、各行の名前・トークン数・割合、「概算」、`band-exact`。`compactIn: null` のとき「自動 compact まで」が出ない。`detail` を持つ行に `band-detail-<id>` が出て、`detailOpen: true` のとき 1 件ずつの名前とトークン数が出る。
  - 選択肢: `steps.confirming: null` のとき、各選択肢が `band-step-<i>` のボタンで出て、見出しに「提案」と `reason` が含まれる。`confirming: 1` のとき、その選択肢の代わりに「本当に送りますか？」と文面、`band-step-confirm-1`、`band-step-cancel` が出る。`steps: null` のとき何も出ない。
  - `steps.items` と `goal` に ESC 列が入っていても、描かれた全文字列（`JSON.stringify(await ui.drawn())`、Button の `label` を含む）に ESC が残らない（Review Focus 2）。
- [ ] **Step 2: テストを実行して失敗を確かめる。**
- [ ] **Step 3: 実装する。** 既存の `branch-view.tsx` の作り（`Box`・`Text`・`Button`、`stripControl`、幅が狭いとき `flexWrap`）に合わせる。ボタンの `onPress` は `on.*` を呼ぶだけ。`labelsOf(tree)` は `textsOf` と同じ走査で、`type === 'Button'` の `props.label` を集める。
- [ ] **Step 4: テストが通ることを確かめる。**
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk/hooks/band-view.tsx session-desk/hooks/band-view.test.tsx session-desk/hooks/test-kit.tsx
  git commit -m "feat: セッション帯の描画を足す"
  ```

---

### Task 7: 実行状態の配線

**Files:**
- Modify: `session-desk/hooks/register.tsx`、`session-desk/types/index.d.ts`
- Test: `session-desk/hooks/band-wiring.test.tsx`

**Interfaces:**
- Consumes: Task 3〜6、Task 5 の `bandGit`（宣言済み）、Task 1 で特定した差し替え名。
- Produces: atom `band: { run: { startedAt: number | null; tools: { id: number; name: string }[] }; state: 'running' | 'stopped' | null; lastTurn: { durationMs: number; tokens: number } | null; stop: 'error' | 'refusal' | 'aborted' | null; goal: string | null; reason: string; steps: string[]; confirming: number | null; turnId: string | null }`（`types/index.d.ts` には、型を d.ts の中に直接書く。`import` しない）。ツールの `id` は `register.tsx` のモジュール内の連番。Pane の描画が、タブの本体の上に `renderBand` を描く（まだ `usage` などは `null`）。`lastTurn.tokens` は、`turn.complete` の `usage` の入力トークンと出力トークンの合計（項目名は Task 1 で確定）。

- [ ] **Step 1: 失敗するテストを書く（`band-wiring.test.tsx`）。**
  - `turn.start`（`agentId` なし）のあと、Pane に `'実行中'` が出る。`agentId` ありの `turn.start`・`turn.complete`・`tool.call` では、状態が変わらない。
  - `tool.call`（`tool: 'Bash'`）が走っている間 `'実行中 Bash'` が出て、完了後はツール名が消える。既存の Bash の更新要求（`wantsGh`）は今までどおり出る。`Bash`・`Edit`・`Write` 以外のツールでも名前が出る。
  - `turn.complete`（`reason: 'answer'`、`durationMs: 102000`）のあと `'停止中'` と `'直近 1m42s'`。`reason: 'error'` のとき `'エラーで停止'`、`'aborted'` のとき `'中断'`。
  - `bandGit` が書かれているとき、Pane にブランチ名と `'未 commit 3'` が出る。`bandGit` が `null` のとき、その行が出ず、帯の他の行は出る（Review Focus 4）。
  - タブを定型文・履歴・Git に切り替えても、帯が同じように出る。
- [ ] **Step 2: テストを実行して失敗を確かめる。**
- [ ] **Step 3: 実装する。** `turn.start`・`turn.complete`・`tool.call` のフックを足す。既存の `tool.call` フックは、`Bash`・`Edit`・`Write` 以外を素通りさせる前に、ツール名の登録と、`around` での解除を入れる。
- [ ] **Step 4: テストが通ることを確かめる。** `claude plugin test session-desk` と `tsc -p session-desk --noEmit` がともに通る。
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk
  git commit -m "feat: セッション帯に実行状態を出す"
  ```

---

### Task 8: モデル・コンテキスト・上限・サブエージェントの取得

**Files:**
- Modify: `session-desk/hooks/register.tsx`、`session-desk/types/index.d.ts`
- Test: `session-desk/hooks/band-wiring.test.tsx`

**Interfaces:**
- Consumes: Task 7。
- Produces: atom `usageView: { model: string | null; context: { percent: number; tokens: number; window: number } | null; rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]; breakdown: { categories: { name: string; kind: string; tokens: number }[]; rawMaxTokens: number; autoCompactThreshold?: number; isAutoCompactEnabled: boolean } | null }`、`agentsView: { running: number; rows: AgentRow[]; startedAt: Record<string, number> }`、`bandUi: { breakdown: boolean; exact: boolean; agentsClosedByUser: boolean; detail: string[] }`。トップレベルの `fetchBandData($: any, exact: boolean): Promise<void>`（`usage`・`model`・`agent.list` を取って atom に書く。個々の失敗は握りつぶし、その項目を `null` にする）。`fetchBandData` は、`turn.start`・`turn.complete`・`tool.call` のフックと、10 秒タイマーの両方から呼ぶ。

- [ ] **Step 1: 失敗するテストを書く。** タイマーに頼らず、イベントを起こして検証する。
  - `turn.complete` のあと、`usage` の差し替えが返した使用率（`context.percent: 58`）とモデル名が Pane に出る（10 秒待たずに）。
  - `usage` が `rateLimits: []` を返すとき「枠」が出ず、コンテキストは出る。`usage` が例外を投げるとき、帯の他の行は出る（Review Focus 4）。
  - `usage` が `five_hour` と `seven_day` を返すとき、2 つの枠が出る。
  - `$.agent.list()` が running を 1 件返し、`agent.spawn` を起こしたあと、サブエージェントの一覧が自動で開く。「閉じる」を押すと閉じ、次の更新でも閉じたまま。0 件に戻るとき、一覧も件数も消える。
  - 取得の呼び出しが、`usage({ breakdown: 'summary' })` であること（`'full'` ではない）。
  - コンテキストのバーが、`breakdown` のカテゴリの色（`CATEGORY_COLORS`）で分かれて描かれる。
- [ ] **Step 2: テストを実行して失敗を確かめる。**
- [ ] **Step 3: 実装する。** `agent.spawn` のフックで `await next(e)` の結果の `agentId` と現在時刻を `agentsView.startedAt` に書く。`summarizeAgents` に渡すときに `Map` に変換する。
- [ ] **Step 4: テストが通ることを確かめる。**
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk
  git commit -m "feat: セッション帯にモデル・コンテキスト・上限・サブエージェントを出す"
  ```

---

### Task 9: コンテキストの内訳と「正確に数える」

**Files:**
- Modify: `session-desk/hooks/register.tsx`
- Test: `session-desk/hooks/band-wiring.test.tsx`

**Interfaces:**
- Consumes: Task 3 の `compactIn`・`classifyCategory`、Task 8 の `usageView`・`bandUi`。

- [ ] **Step 1: 失敗するテストを書く。**
  - 「▸ 内訳」を押すと、`bandUi.breakdown` が真になり、内訳の各行（名前・トークン数・割合）と「概算」が出る。もう一度押すと閉じる。
  - 内訳の行は、トークン数の多い順に並ぶ。`kind` が `free`・`buffer`・`deferred` の行や、名前が未知の行は「その他」にまとまる。
  - `autoCompactThreshold` が 900_000、使用が 860_000 のとき `'あと 40k'` が出る。`isAutoCompactEnabled: false` のとき出ない。
  - 「正確に数える」を押すと、`usage({ breakdown: 'full' })` が 1 回呼ばれ、結果が出る。次の更新は `'summary'` に戻る。
  - MCP ツール・メモリファイル・スキルの行の「▸」を押すと、1 件ずつの名前とトークン数が出る。もう一度押すと閉じる。
- [ ] **Step 2: テストを実行して失敗を確かめる。**
- [ ] **Step 3: 実装する。** `usage().context.breakdown` の `categories`・`mcpTools`・`memoryFiles`・`skills` から、`BandArgs.breakdown` を作る。割合は `tokens / rawMaxTokens`。
- [ ] **Step 4: テストが通ることを確かめる。**
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk
  git commit -m "feat: コンテキストの内訳を開閉できるようにする"
  ```

---

### Task 10: ゴールと停止時の選択肢（fork）

**Files:**
- Modify: `session-desk/hooks/register.tsx`、`session-desk/hooks/band.ts`（`forkPrompt`）
- Test: `session-desk/hooks/band-fork.test.tsx`

**Interfaces:**
- Consumes: Task 4 の `parseForkReply`・`isRiskyStep`、Task 7 の `band`。
- Produces: `forkPrompt(prevGoal: string | null): string`（`band.ts`）。`register.tsx` のトップレベル関数 `askFork($: any, turnId: string): Promise<void>`。

- [ ] **Step 1: 失敗するテストを書く（`band-fork.test.tsx`）。**
  - `forkPrompt('A')` が、前回のゴール `A`、JSON だけを返すこと、`goal` 40 字・`reason` 30 字・`steps` 最大 4 個・各 40 字、判断が要らなければ空配列、返答にない作業を足さないこと、を含む。
  - `turn.complete`（`reason: 'answer'`）で `fork` が 1 回呼ばれ、`effort: 'low'` が渡る。`fork` を未解決のままにしても、`turn.complete` の await が返る。`agentId` つきの `turn.complete` では `fork` が 0 回。`reason: 'error'`・`'refusal'`・`'aborted'` でも 0 回。
  - `fork` が正しい JSON を返す→ゴールと選択肢と見出しの理由が出る。
  - `fork` が壊れた JSON を返す、`isAnswered: false`、例外を投げる→選択肢は出ず、前回のゴールが残り、トーストは出ない（Review Focus 1）。`goal` が数値→選択肢は出ない。41 字の `goal`→前回のゴールのまま、選択肢は出る。
  - 実行中（`turn.start` のあと）は選択肢が描かれない。
  - 選択肢を押す→`$.prompt.submit` がその文面ちょうどで 1 回呼ばれ、選択肢が消える。二度押しでも 1 回（Review Focus 5）。`submit` が reject→トーストが出て、選択肢が戻る。
  - 危険語を含む選択肢（`'ブランチを削除する'`）は、1 回目の押下で `submit` が呼ばれず確認が出て、確認の「送る」で 1 回呼ばれる。「やめる」で確認が消え、`submit` は 0 回。
  - 古い `turnId` の `fork` 結果は捨てる（`fork` を未解決にして次の `turn.start` を起こし、あとで解決する）。
  - 自分の `fork` が走っている間に来た `turn.start`・`turn.complete`・`tool.call` は、帯の状態を変えない。
  - 次の `turn.start` または `prompt.submit` で選択肢が消える。クリックで送った文が履歴に載る。
- [ ] **Step 2: テストを実行して失敗を確かめる。**
- [ ] **Step 3: 実装する。** `turn.complete` のフックで `const out = await next(e)` を先に取り、`void askFork($, e.turnId)` を呼んで `out` を返す。`askFork` は `fork` を呼び、`parseForkReply` の結果を、`turnId` が今のターンと同じときだけ `band` に書く。ゴールの更新と選択肢は同じ結果から決める。fork の最中は「自分の fork 中」の印を立て、その間の 3 つのイベントを無視する。
- [ ] **Step 4: テストが通ることを確かめる。** `claude plugin test session-desk` と `claude plugin validate session-desk --strict` が通る。
- [ ] **Step 5: コミットする。**
  ```bash
  git add session-desk
  git commit -m "feat: ゴールと停止時の選択肢を fork で作り、クリックで送る"
  ```

---

### Task 11: README・版・画面イメージ

**Files:**
- Modify: `README.md`、`session-desk/.claude-plugin/plugin.json`、`docs/panel.svg`、`docs/branch.svg`
- Create: `docs/band.svg`

- [ ] **Step 1: README を `~/.claude/rules/readme-rules.md` に従って更新する。** 機能の表にタブ名「Git」と順番、セッション帯、停止時の選択肢を足す。「使い方」に帯の読み方（色・内訳・サブエージェント）と選択肢の押し方（危険な語は 2 回押す）を足す。前提条件に、`$.model.fork` が返答ごとに 1 回かかることを書く。
- [ ] **Step 2: `plugin.json` の `version` を `1.1.0` にする**（`git-flow.md` の規則。機能追加は minor）。`description` を「サイド UI パネル（定型文・履歴・Git）と、全タブ共通のセッション帯、入力欄の上のパネル開閉ボタンを出す mod。」に直す。
- [ ] **Step 3: 画面イメージを直す。** `docs/panel.svg`・`docs/branch.svg` のタブ名と順番を直し、`docs/band.svg`（帯と選択肢）を描いて README に貼る。`writing.md` の図の規則（文字 12px 以上、代替テキスト、PNG にして目で確認）に従う。
- [ ] **Step 4: 全体を確かめる。** `claude plugin test session-desk`、`claude plugin validate session-desk --strict`、`tsc -p session-desk --noEmit` がすべて通る。README の見出しの順（`grep '^#' README.md`）を `readme-rules.md` に照らす。
- [ ] **Step 5: コミットする。**
  ```bash
  git add README.md session-desk/.claude-plugin/plugin.json docs
  git commit -m "docs: README と画面イメージを更新し、version を 1.1.0 にする"
  ```
