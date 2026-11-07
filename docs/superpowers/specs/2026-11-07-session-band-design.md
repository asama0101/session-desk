# セッション帯と停止時の選択肢の設計

Session Desk の全タブの最上部に「セッション帯」を足す。帯は、Claude のセッションのゴール・実行状態・モデル・コンテキストの使い方・利用上限・ブランチを見せる。Claude のターンが止まって人の判断が要るときは、帯の直下に選択肢を出し、クリックだけで次のターンを始められるようにする。あわせて、タブの順番と名前、リモート URL の見せ方を変える。

画面イメージ（Artifact、作者だけが開ける）: https://claude.ai/artifact/FfJj2fZBLjnnCcDmHhFFkq

## 1. 目的と理由

**作る理由**: Claude のターンが止まるたびに、作者は次の指示を自分で入力している。止まった理由は、案の選択、確認待ち、エラーなど、数個の選択肢で済むことが多い。選択肢をクリックするだけで進められれば、入力の手間が省ける。あわせて、いまのセッションが何を目指し、何を使い、どこまで来たかを、パネルを見るだけで分かるようにしたい。

**使う人**: 作者本人（Claude Code を、端末幅 144 列以上のパネル付きで使う人）。

**使う場面**: Claude が作業している最中と、止まった直後に、サイドパネルを横目で見る。

**既存の機能との関係**: 「ブランチ」タブには、commit・push などを yes/no で Claude に頼める仕組みがすでにある（`session-desk/hooks/register.tsx` の `answerAction`）。今回の選択肢は、ブランチの状態ではなく、返答の内容から作る点が違う。両方を残す。

## 2. 決まったこと（作者が決めた）

| 項目 | 決定 |
|---|---|
| 帯の置き場所 | 全タブの最上部。タブを替えても同じ位置に出る |
| タブの順番 | 定型文・履歴・Git（順番は今のまま。名前だけを「ブランチ」から「Git」に変える） |
| タブ名 | 「ブランチ」を「Git」に変える |
| 帯の項目 | ゴール／実行状態と所要時間／モデルとコンテキスト（内訳ボタン付き）／5 時間枠と 7 日枠／今のブランチと未 commit の数。cost は出さない |
| 実行状態の行 | 実行中か停止中か、実行中のツール名、経過時間、直近ターンの所要時間とトークン数 |
| サブエージェント | 動いていないときは何も出さない。動き出すと件数を出し、一覧を自動で開く |
| コンテキストの内訳 | カテゴリごとに色を固定し、開閉できる。閉じていても、コンテキストのバーが同じ色で分かれる |
| ゴール | 会話から Claude が、ターンの終わりごとに更新する。人は入力しない |
| 停止時の選択肢 | 人の判断が要るときだけ出す。最大 4 個。クリックしたら、その文面をそのまま送る |
| 選択肢の作り方 | `$.model.fork` で別に Claude を呼び、返答から作らせる（Next Steps と同じ方式） |
| リモート URL | Git タブで、一覧の上に明るい色で 1 行出す |

## 3. ゴール・ノンゴール・アンチゴール

**ゴール**
- 帯だけを見て、ゴール・実行状態・モデル・コンテキスト使用率・利用上限・ブランチが分かる。
- 止まった返答に判断の分かれ目があるとき、クリック 1 回で次のターンを始められる。
- コンテキストの何が大きいかを、内訳を開かなくても色で見分けられる。

**ノンゴール**
- 別のセッションの一覧や、他のセッションの状態を出さない（この mod の API は、いまのセッションしか見えない）。
- cost を出さない（作者が不要とした）。
- Next Steps のような、固定のチップ（「yes, proceed」など）を足さない。
- 選択肢の文面を、人が編集する画面を作らない。
- 既存のブランチタブの「はい／いいえ」を変えない。

**アンチゴール（動いても失敗とみなすもの）**
- 選択肢の問い合わせが、メインの会話に混ざる、またはメインの返答を書き換える。
- 取れなかった値を、0 や「なし」のように見せる。取れなかった項目は、行ごと出さない。
- 選択肢が、毎ターン出て、画面を占める。判断が要らない返答には出さない。
- 選択肢のクリックが、人の意図しない作業（削除、push など）をすぐ始める。文面は、返答に書かれた選択肢から作り、返答にない新しい作業を足さない。
- 認証情報つきのリモート URL（`https://user:token@host/...`）を、そのまま表示する。

## 4. 画面

### 4.1 全体

```
 定型文   履歴   ▸ Git                        ← タブ（順番は定型文・履歴・Git）
┌────────────────────────────────────────────────┐
│ ゴール  Session Desk に帯と停止時の選択肢を足す         │ ← 帯の 1 行目
│ 停止中  直近 1m42s・18k tokens                         │ ← 実行状態（実行中は「実行中 Bash 0m42s」。
│                                                        │    サブエージェントが動くと件数を足す）
│ Opus 5.5  コンテキスト ■■■■■■■■■□□□□□□□ 58%  ▸ 内訳    │
│ 5時間枠 ███░░░░░░░ 32% 残り 3h 10m   7日枠 █░░░░░░░░░ 11%  │
│ feat/session-band   未 commit 3                        │
└────────────────────────────────────────────────┘
┌ 停止中: 実装方針の確認待ち ─────────────────────┐   ← 判断が要るときだけ
│ [A案で進める] [B案で進める] [別の案を相談]           │
└────────────────────────────────────────────────┘
（以降はタブの内容）
```

細部（色・開いた状態・サブエージェントの一覧）は、上の Artifact を正とする。

### 4.2 帯の項目

| 項目 | 表示 | 取得元 | 取れないとき |
|---|---|---|---|
| ゴール | 1 行。全角 40 字まで | 4.4 の `$.model.fork` | 前回のゴールを残す。一度も作れていなければ行を出さない |
| 実行状態 | 「実行中 <ツール名> <経過>」または「停止中」 | メインのやり取りの `turn.start`・`turn.complete`・`tool.call` を聞いて自分で持つ。`agentId` があるもの（サブエージェント）は、3 つとも除く。実行中のツールは集合で持ち、表示は最も古い 1 件の名前にして、2 件以上なら「+n」を足す。経過秒は 10 秒刻みで更新する | 行を出さない |
| 直近ターン | 所要時間とトークン数 | `turn.complete` の `durationMs` と `usage` | その部分を出さない |
| サブエージェント | 件数と一覧（種類・内容・状態・経過時間） | `$.agent.list()` の `type`・`description`・`status`。`status` が `running`・`pending` のものを「実行中」として数える。`waiting`・`idle` は灰色の「待機」で一覧に出し、件数には数えない。`completed`・`failed`・`killed` は件数に数えない。経過時間は、`agent.spawn` の `next(e)` が返す `agentId` と、そのときの時刻を持って自分で計る（`AgentInfo` に開始時刻はない） | 0 件のときは何も出さない |
| モデル | モデル名 | `$.session.model()` | 出さない |
| コンテキスト | カテゴリ別に色分けしたバー、使用率、トークン数 | `$.session.usage()` の `context` | 出さない |
| 内訳 | 4.3 | `$.session.usage({ breakdown: 'summary' })` | 出さない |
| 5 時間枠・7 日枠 | バー、使用率、残り時間 | `$.session.usage()` の `rateLimits` | 取れた枠だけ出す。サブスクリプション外（`rateLimits` が空）なら行ごと出さない |
| ブランチ | 今のブランチ名と未 commit の数 | 今のブランチ名は既存の取得結果（`Snapshot`）。未 commit の数は `Snapshot` に無い（`dirty` は真偽だけ）ので、`git status --porcelain` の行数を数える処理を `git.ts` に足す | Git のリポジトリでなければ行を出さない。数が取れなければ、数を除いてブランチ名だけ出す |

使用率の数字は、80% 以上で黄、95% 以上で赤にする。バーの色は、カテゴリの色（4.3）に使うので、警告の色にしない。

バーの長さと使用率は `context.percent` で出し、バーの色分けの比率は内訳（`breakdown: 'summary'`）の比率で決める。内訳（4.3）は、自動 compact の窓に対する概算で、分母が違うため、合計が `context.percent` と一致しないことがある。内訳には「概算」と書く。

### 4.3 コンテキストの内訳

- 「▸ 内訳」を押すと開き、「▾ 内訳」に変わる。初期は閉じる。
- カテゴリと色は次のとおり。色は固定する。色だけに頼らず、行に名前とトークン数も出す。

| カテゴリ | 色（画面イメージの値） |
|---|---|
| メッセージ | 青 `#61afef` |
| MCP ツール | 紫 `#c678dd` |
| システムツール | 水色 `#56b6c2` |
| システムプロンプト | 緑 `#7ec699` |
| メモリファイル | 黄 `#e5c07b` |
| スキル | オレンジ `#d19a66` |
| 空き | 灰色 `#55555a` |

- 開いたとき、先頭に全体の積み上げ棒を出し、各行に「■」・名前・トークン数・割合を出す。末尾に「自動 compact まで あと <n>k（閾値 <n>k）」と「概算」を出す。自動 compact が無効、または閾値が取れないときは、「自動 compact まで」の部分を出さない。
- 小さい項目も最小 1 マスで描く。マスの数は正確な比率ではない。
- 内訳の行は、名前ではなく `kind`（`used`・`free`・`buffer`・`deferred`）と、カテゴリの名前で分ける。上の表の 7 つに当たらない行（自動 compact のバッファ、遅延ツール、カスタムエージェント、スラッシュコマンド）は、「その他」にまとめて灰色の別色で出す。
- MCP ツール・メモリファイル・スキルは、件数の横の「▸」で 1 件ずつの内訳を開ける。
- 内訳は、通常は手元の見積もり（`breakdown: 'summary'`、無料）にする。「正確に数える」ボタンを足し、押したときだけ `'full'`（トークン数の API を呼ぶ）にする。このボタンは作者の指定ではなく、設計者の判断（8 章）。

### 4.4 ゴールと停止時の選択肢

ターンが終わるたびに、1 回だけ `$.model.fork` を呼び、ゴールと選択肢を一緒に返してもらう。

1. `turn.complete` を受ける。`e.agentId` があるとき（サブエージェント）は何もしない。
2. 止まった理由（`e.reason`）で分ける。

| 理由 | ゴール | 選択肢 | 帯の表示 |
|---|---|---|---|
| `answer` | 更新する | 作る（下記） | 判断が要るときは選択肢を出す |
| `error`・`refusal` | 更新しない | 出さない | 赤で「エラーで停止」または「拒否で停止」 |
| `aborted` | 更新しない | 出さない | 灰色で「中断」 |

3. `answer` のとき、`turn.complete` の `next(e)` を先に返してターンの完了を遅らせず、そのあとで `$.model.fork`（`effort: 'low'`）を await せずに呼び、次を渡す。
   - 前回のゴール（あれば）。直前の返答は、`$.model.fork` がセッションの会話ごと引き継ぐので、渡さない
   - 指示: 「JSON だけを返す。`{"goal": "<1 行、40 字以内>", "reason": "<止まった理由、30 字以内>", "steps": [...]}`。ゴールは、会話の目的が大きく変わったときだけ書き換え、そうでなければ前回のゴールをそのまま返す。`steps` は、返答が人の判断を求めているとき（質問、案の選択、確認待ち、エラーの対処）だけ、次に頼みそうな行動を最大 4 個、1 つ 40 字以内の具体的な命令文で返す。判断が要らなければ空配列を返す。返答にない新しい作業を足さない。」
4. 返ってきた JSON から `{...}` を取り出して解く。`steps` の文字列だけを残し、前後の空白を除き、制御文字と不可視文字を除き（既存の `stripControl`）、最大 4 個にする。40 字を超えた選択肢は、切らずに捨てる（切ると意味が変わるため）。`goal` と `reason` にも同じ処理をかけ、長さの上限を超えたら捨てる（`goal` は前回の値を残し、`reason` は固定の見出し「判断待ち」にする）。
5. `fork` の結果の `isAnswered` が偽（`nothing-to-fork`・`api-error`・`empty-reply`・`aborted`）、JSON が解けない、`goal` が文字列でない、`fork` が例外を投げた、のどれかのとき、選択肢は出さず、ゴールは前回の値を残す。失敗のたびのトーストは出さない。
6. 選択肢を押したら、その文面を `$.prompt.submit` で送り、選択肢を消す。送れなかったときは、トーストで知らせ、選択肢を戻す。
   - 文面に危険な語（削除、消去、push、force、reset、rm、drop、`--no-verify`）を含む選択肢は、1 回目の押下で「本当に送りますか？」と文面を出し、2 回目の押下で送る。既存のブランチタブの削除の 2 段確認と同じ流儀にする。
   - 選択肢の見出しに「提案」と出し、Claude が作った案であることが分かるようにする。ボタンの表示文と送る文は、同じにする。
   - クリックで送った文は、履歴に載せる（`prompt.submit` の既存の仕組みのまま）。
7. 次のターンが始まったとき（`turn.start`）、または次のプロンプトが送られたとき（`prompt.submit`）に、選択肢を消す。
8. 遅れて返った結果は、`turnId` が今のターンと違えば捨てる。

選択肢は、実行中は描かない。実行中かどうかは、自分で持つ実行状態（4.2）で決める。Pane の props には `isWorking` も `hasSurvey` もないため、アンケート表示中の判定はしない。

### 4.5 サブエージェント

- 0 件のときは、一覧も件数も出さない。
- 0 件から 1 件以上になったとき、一覧を自動で開く。
- 手で閉じたときは、次に 0 件から 1 件以上になるまで、閉じたままにする。
- 一覧の 1 行は、状態の記号（実行中は青の「●」、完了は灰色の「○」）・種類・内容・状態・経過時間。

### 4.6 Git タブ（旧ブランチ）

- タブ名を「Git」にする。内容は、リモート URL の見せ方を除き、今のままにする。
- リモート URL の行は、今は暗い色の小さい文字。一覧の上に、明るい色（名前は青、URL は本文色）で出す。
- URL は、既存の `tidyUrl`（`branch.ts`）を通して出す。`tidyUrl` は、すでに認証情報と `?`・`#` 以降を除いている。リモート URL を出す場所では必ず `tidyUrl` を通し、認証情報つきの URL を渡す回帰テストを足す。

## 5. 状態とデータ

- 新しい atom（`plugin: 'session-desk'`）を足す。型は `types/index.d.ts` に宣言する。

| key | 中身 |
|---|---|
| `band` | 実行状態、直近ターン、ゴール、選択肢（`steps`）、止まった理由、`turnId` |
| `bandUi` | 内訳が開いているか、「正確に数える」を押したか、サブエージェントの一覧を手で閉じたか、1 件ずつの内訳が開いているカテゴリ |
| `agentsView` | `$.agent.list()` の結果の集計と、各エージェントの開始時刻 |
| `usageView` | `$.session.usage()` と `$.session.model()` の結果。`breakdown` も含む |
| `bandGit` | 今のブランチ名と未 commit の数（他のタブが表示中でも更新する） |

- `Tab` 型は `'quick' | 'history' | 'git'` にする。`tab` の atom は保存されない（`shape` を持たない）ので、保存値の移行は要らない。`'branch'` を使っている箇所（`types/index.d.ts`、`TABS`、`refreshNow`、`selectTab`、描画の分岐、`branch-*.test.tsx` などのテスト）を `'git'` に置き換える。`SHAPE` のタグは、`history`・`quick` の形を変えないので上げない。
- 帯のために、ブランチ情報の更新を、Git タブが表示中でなくても行う。`refreshNow` の先頭にある `tab !== 'branch'` での早期 return を外す。ただし、他のタブが表示中は「今のブランチ名と未 commit の数」だけを読む軽い更新にして、全ブランチ分の `enrich` と gh は呼ばない。Git タブが表示中のときの動きは、今のままにする。

## 6. 制約

- Claude Code 2.1.319、Windows 11（作者の環境。README の前提条件と同じ）。
- 取得は、`$` の API だけを使う。通常の外部通信は、`$.model.fork` だけにする。例外は、既存の gh と、「正確に数える」ボタンを押したときのトークン数の API。
- 帯の更新は、`turn.start`・`turn.complete`・`tool.call` のたびと、10 秒ごと（既存のタイマーに相乗り）。コンテキストのバーを閉じたままカテゴリ別に色分けするため、内訳は `breakdown: 'summary'`（無料の手元の見積もり）で、帯の更新のたびに取る。`'full'`（トークン数の API を呼ぶ）は、「正確に数える」を押したときだけ。
- 返答ごとの追加のモデル呼び出しは 1 回まで（ゴールと選択肢を同じ呼び出しで返してもらう）。
- 費用: `$.model.fork` は会話全体を引き継ぐ。プロンプトのキャッシュが切れていると、全文が再び課金される。`effort` は `'low'` にする。費用が大きいと分かったときの間引き（数ターンに 1 回にする、など）は、実装後に作者と決める。
- ログ・トースト・画面に、返答の全文や認証情報を出さない。`$.model.fork` の返答（`text`）も同じ。画面に出す文字列（ゴール・理由・選択肢）には、必ず `stripControl` をかける。

## 7. 作らないもの・あとでよいもの

- README の更新（機能の表、タブ名、前提条件の「ブランチ」の記述）と、`docs/panel.svg`・`docs/branch.svg` の描き直しは、実装の計画に含める。
- 版は、機能追加なので 1.1.0 にする（git-flow.md の規則に従う。実際の付け方は計画で確認する）。

## 8. 設計者（私）の判断

作者が決めていない点を、次のとおり決めた。差し戻してよい。

| 判断 | 内容 |
|---|---|
| 内訳の「正確に数える」ボタン | 通常は無料の見積もり。ボタンを押したときだけ API で数える |
| 中断・エラー時 | 選択肢を出さず、止まった理由だけを帯に出す |
| 選択肢の上限 | 4 個、1 つ 40 字 |
| 使用率の警告色 | 80% で黄、95% で赤（調べた他の mod と同じ基準） |
| 内訳の初期状態 | 閉じる |
| サブエージェントを手で閉じたあと | 次に 0 件から動き出すまで閉じたまま |
| 失敗時のトースト | 選択肢の取得に失敗してもトーストを出さない（毎ターン鳴るため） |
| ブランチ情報の更新 | Git タブ以外でも、今のブランチ名と未 commit の数だけ読む。gh と全ブランチの読み込みは Git タブ表示中だけ |
| 危険な語を含む選択肢 | 1 回目の押下で確認を出し、2 回目で送る（作者の「すぐ送る」の例外。誤送信で削除や push が走るのを防ぐ） |
| 選択肢の長さ | 40 字を超えたものは切らずに捨てる |
| クリックで送った文 | 履歴に載せる |
| 選択肢の見出し | 「提案」と出す。理由は `reason`（30 字以内）を Claude に返してもらい、取れなければ「判断待ち」 |
| fork の呼び方 | `effort: 'low'`、ターン完了を待たずに後から呼ぶ |
| 未 commit の数 | `git status --porcelain` の行数を数える処理を足す |
| 経過秒の更新 | 10 秒刻み |
| fork が使えなかったとき | ゴールと選択肢を除いて、帯だけを作る（帯は fork に依存しない） |


## 9. 未検証のこと（ビルダーが最初に確かめる）

確認日: 2026-11-07。環境は Claude Code 2.1.319・Windows 11。「型」は `.claude-plugin/types` に対する `tsc --noEmit`、「実機」は `claude -p --plugin-dir <probe> --debug-file <log>`（ヘッドレス）で `$.ui.log(…, { to: 'debug' })` に出して読んだ結果。ヘッドレスは REPL を持たないため、確かめられない項目がある。それらは「未確認」とし、「外れたときの扱い」を既定として後続のタスクが従う。

| 確かめること | 外れたときの扱い | 確認結果 |
|---|---|---|
| `$.model.fork` の呼び方と、返り値の形。`turn.complete` の `next(e)` を返したあとに、await せずに呼べること | 4.4 の方式が成立しない。ゴールと選択肢を除いて帯だけを作り、作者に報告する | **成立**（型・実機）。`$.model.fork({ prompt })` は型に通る。`ModelForkRequest` は `prompt` だけを宣言し、`effort` は型に無い（リテラルで `effort` を書くと TS2353。変数に入れて渡すと通る）。実機は `effort: 'low'` を渡して `{ isAnswered: true, text: 'OK', usage, effort: 'low' }` を返したが、`effort` が効いているかは未確認。`next(e)` のあと `void (async () => { await $.model.fork(…) })()` で呼べた。`isAnswered: false` の `reason` は `api-error`・`empty-reply`・`aborted`・`nothing-to-fork` |
| `$.model.fork` 自身が `turn.start`・`turn.complete`・`tool.call` を起こして、帯が連鎖して更新されたり、偽のターンが記録されたりしないこと | 起きるなら、自分の fork が走っている間は、この 3 つのイベントを無視する | **起きなかった**（実機、ヘッドレス。fork の約 1.3 秒の間に 3 つとも 0 回）。ただし REPL では未確認のため、既定どおり**自分の fork が走っている間（フラグを立てている間）は 3 つとも無視**する実装にする。無視しても害はない |
| `agent.spawn` の `next(e)` の結果から `agentId` が取れること | 経過時間を出さず、種類・内容・状態だけにする | **成立**（実機）。`{"model":"claude-sonnet-5-5","agentId":"a3fad9f3dfb285104"}`。型は `agentId?: string`（`deny` の腕では無い）なので、未定義なら経過時間を出さない。サブエージェント自身の `turn.start` は `agent.spawn` の `next(e)` が返る前に起き、`agentId` を持つ（同じ値）。サブエージェントの最後の `tool.call` は `tool: 'SubagentHandback'`（`agentId` つき）。サブエージェントの `turn.complete` も `agentId` つき |
| `stripControl` が ESC の列（ANSI・OSC）と双方向制御文字（U+202E など）を落とすこと | 足りなければ `stripControl` を直す | **成立**（node で実行）。CSI（`ESC[31m`）、OSC の BEL 終端・ST（`ESC\`）終端、U+202E・U+202A・U+2066・U+2069・U+200F・U+200B は消える。**消えないもの**: U+FEFF（BOM）、U+2028/2029、U+00AD、U+061C。C1 の U+009B は消えるが、後ろの `31m` は文字として残る。画面に出す文字列としては、帯の用途（ゴール・理由・選択肢）では致命的ではないので、直すかは Task 3 以降の判断（直すなら `RANGES` に `[0xfeff, 0xfeff]`・`[0x2028, 0x2029]` を足す） |
| `$.session.usage()` の `rateLimits` の形と、サブスクリプション外での値 | 取れた枠だけ出す | **形は成立**（型・実機）。`rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]`。実機（サブスクリプションあり）は `[{"kind":"five_hour","percentUsed":36,"resetsAt":"2026-11-07T11:00:00.000Z"},{"kind":"seven_day","percentUsed":38,"resetsAt":"2026-11-09T17:00:00.000Z"}]`。`kind` は `five_hour`・`seven_day`、ゲートウェイでは `spend_limit` もある。**サブスクリプション外の値は未確認**（既定: 空配列なら行ごと出さない。`kind` が 2 つ以外のものは出さない）。`context` はヘッドレスでは `{ window: 1000000 }` だけで、`tokens`・`percent`・`breakdown` が無かった。型は 3 つとも省略可（`tokens?`・`percent?`・`breakdown?`）なので、取れなければ出さない |
| `$.agent.list()` が、動いているサブエージェントを返すこと。`status` の値 | サブエージェントの表示を外す | **未確認**。ヘッドレスでは `$.agent.list is not available in this mode: no session is bound in this process` で例外になる（REPL 専用）。型は `AgentInfo`（`id`・`type`・`description`・`status`・`parentId?`・`name?` ほか）、`AgentStatus = 'pending' \| 'running' \| 'waiting' \| 'idle' \| 'completed' \| 'failed' \| 'killed'`（4.2 の分類と合う）。既定: 呼び出しを try/catch で包み、例外なら「取れなかった」として一覧を出さない |
| `turn.start`・`agent.spawn` のイベントの形 | 実行状態・経過時間の取り方を決め直す | **成立**（型・実機）。`turn.start`: 入力 `{ text, turnId, agentId? }`、`next(e)` は `{ turnId }`。`turn.complete`: 入力 `{ answer, durationMs, isAborted, turnId, agentId?, usage?, reason }`（`reason`: `answer`・`aborted`・`refusal`・`error`。`refusal` のときは `refusal: { category, explanation }` も付く）、`usage` は `{ input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, model }` で省略可。`agent.spawn`: 結果は上の行 |
| 実行中のツール名を `tool.call` から取れること | 「実行中」だけにする | **成立**（実機）。`tool.call` の入力に `tool`（`Bash`・`Agent`・`SubagentHandback`）と、サブエージェントのものには `agentId` がある。**ツール完了のイベントは無い**ため、集合から外す契機は `turn.complete` と `turn.start` に頼る |
| ゴールの揺れ（同じ目的で毎ターン書き換わらないか） | 指示の書き方を直す。直らなければ、ゴールの行だけを外し、作者に報告する | **未確認**（実装後に実機で見る。Task 11 の手動確認で扱う） |

### 9.1 確かめた結果として、後続のタスクが従うこと

- **fork のイベントは常に無視する**。実機では起きなかったが、REPL では未確認のため、既定に倒す。`turn.start`・`turn.complete`・`tool.call` のフックは、自分の fork が走っている間はフラグを見て素通し（`next(e)` だけ）にする。
- **`$` を別の関数に渡すには、その関数がファイルの先頭の `function` 宣言（または関数に束縛した `const`）であること**。実機の読み込みで、`const L = ($: any, s: string) => …`（フックの内側の定義）は `$ is passed to "L", which is not a function declared at the top of this file` で**モジュールごと読み込み失敗**した。ファイルの先頭に `function L($: any, …) { … }` と書くと通った。引数に `$` を取る補助関数はすべて先頭の関数宣言にする。
- **`effort` は型に無い**。`ModelForkRequest` は `{ prompt: string }` だけで、`{ prompt, effort: 'low' }` はオブジェクトリテラルの余剰プロパティとして型エラーになる。実機の `fork` は `effort` を受け取り、結果に `effort: 'low'` を返した。実装では、`const req = { prompt, effort: 'low' as const }` と変数に入れてから `$.model.fork(req)` と渡す（変数なら型に通る）。`effort` が効かなくても動作は変わらず、費用が少し増えるだけ。
- **`context.breakdown` と `context.percent`・`context.tokens` は取れないことがある**（ヘッドレスでは無かった）。4.2 のとおり、取れなければその部分を出さない。
- **サブエージェントの判定**: `agentId` が定義されていればサブエージェント。ツール完了のイベントが無いので、「実行中のツール」は `tool.call` で足し、`turn.complete`（主ループ、`agentId` 無し）で空にする。

### 9.2 カテゴリ名の実際の文字列（`classifyCategory` が使う）

`$.session.usage({ breakdown: 'summary' })` の `context.breakdown.categories[].name` は、ヘッドレスでは `breakdown` が返らず、実機ログでは読めなかった。そこで、同梱の `claude.exe`（2.1.319）の中のソースから、`categories` を組み立てる箇所を読んだ。次の文字列が、そのままの綴り・大文字小文字で入る（前後の空白なし）。`kind` は `Free space` が `free`、`Autocompact buffer`・`Compact buffer` が `buffer`、`isDeferred` が真のものが `deferred`、それ以外は `used`。

| `name`（完全一致） | `kind` | 4.3 の分類 |
|---|---|---|
| `System prompt` | `used` | システムプロンプト |
| `System tools` | `used` | システムツール |
| `MCP tools` | `used` | MCP ツール |
| `MCP server instructions` | `used` | その他（MCP ツールに入れてもよい。既定は「その他」） |
| `MCP tools (deferred)` | `deferred` | その他 |
| `System tools (deferred)` | `deferred` | その他 |
| `Custom agents` | `used` | その他 |
| `Memory files` | `used` | メモリファイル |
| `Skills` | `used` | スキル |
| `Messages` | `used` | メッセージ |
| `Autocompact buffer` | `buffer` | その他 |
| `Compact buffer` | `buffer` | その他（自動 compact が無効のとき） |
| `Free space` | `free` | 空き |

- 分類は、`kind` が `free` なら「空き」、`buffer`・`deferred` なら「その他」、`used` のときだけ上の `name` の完全一致で 6 つのカテゴリ（メッセージ・MCP ツール・システムツール・システムプロンプト・メモリファイル・スキル）に振り、一致しなければ「その他」にする（名前が変わっても落ちない）。
- `Slash commands` という行は、2.1.319 のソースには `categories` に無い（`ContextSlashCommands` として別の項目）。4.3 の「スラッシュコマンド」は、`categories` には出ない。
- 実機（REPL）で `categories` を読んで、この一覧と合うかの確認は未実施。合わなければ「その他」に落ちるだけなので、既定のままで動く。

### 9.3 テストでの差し替えの書き方（`claude-code/testing`）

テストは `test(name, async ($, on) => { … })`。`claude plugin test session-desk` で走る（環境の都合で `tsc` は `setTimeout` 等の既存の型エラーを出すが、実行には影響しない）。

**API の呼び出し（`$.model.fork` など）は `on('<名前>', handler)` で差し替える。ハンドラは `{ value }` を返す。** 名前は呼び出しの名前そのまま（`$.model.fork` なら `'model.fork'`）。ハンドラの第 2 引数 `e` は呼び出しの引数。実行して動作を確認した。

| 呼び出し | `on` の名前 | `e` | 返すもの |
|---|---|---|---|
| `$.model.fork(req)` | `'model.fork'` | `{ prompt }` | `{ value: { isAnswered: true, text, usage } }` ／ `{ value: { isAnswered: false, reason: 'nothing-to-fork' } }` |
| `$.session.usage(args)` | `'session.usage'` | `{ breakdown?, columns? }` | `{ value: { startedAt: 0, context: { window, tokens?, percent?, breakdown? }, rateLimits: [] } }` |
| `$.session.model()` | `'session.model'` | `{}` | `{ value: 'claude-x' }` |
| `$.agent.list()` | `'agent.list'` | `{}` | `{ value: [] }`（`AgentInfo[]`） |
| `$.ui.toast(text)` | `'ui.toast'` | `{ text, timeoutMs? }` | `{ value: undefined }` |
| `$.session.cwd()` | `'session.cwd'` | `{}` | `{ value: 'D:/p' }`（既存テストと同じ） |
| `$.prompt.submit(input)` | `'prompt.submit'` | `{ text, origin, … }` | **`{ value }` ではなく、イベントの結果そのもの**: `{ text: e.text }`（拒否は `{ drop: '理由' }`）。`prompt.submit` は呼び出しではなくフックのイベントなので、テストの `on` は一番下のフックになる |

```ts
const seen: string[] = []
on('model.fork', (_$, e) => { seen.push(e.prompt); return { value: { isAnswered: true, text: '{"goal":"g","reason":"r","steps":[]}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } } })
on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
on('prompt.submit', (_$, e) => { seen.push('submit:' + e.text); return { text: e.text } })
```

**イベント（`turn.start`・`turn.complete` など）は、テストの `$` から `await $.turn.complete({ … })` のように起こす。** mod のフックが上に乗って走り、一番下はテストの `on` が受ける。一番下のフックは、イベントの結果を返す（`{ value }` ではない）。

| 起こすもの | 呼び方 | 一番下のフックが返すもの |
|---|---|---|
| `turn.complete` | `await $.turn.complete({ answer: 'a', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })`（`agentId` を足すとサブエージェント） | `on('turn.complete', (_$, e) => ({ text: e.answer }))`。実行して確認した |
| `turn.start` | `await $.turn.start({ text: 'hi', turnId: 't1' })` | `on('turn.start', (_$, e) => ({ turnId: e.turnId }))`（型のみ確認） |
| `agent.spawn` | `await $.agent.spawn({ … })`（引数は `AgentSpawnArgs`） | `on('agent.spawn', () => ({ model: 'm', agentId: 'a1' }))`（型のみ確認） |
| `tool.call` | `await $.tool.call({ tool: 'Bash', command: 'ls' })`（サブエージェントは `agentId` を足す） | 型のみ確認 |

- mod のフックが `void` で await せずに呼ぶ `$.model.fork` などは、起こしたあとに 1 回待ってから検査する: `await new Promise<void>(r => setTimeout(r, 50))`（既存の `flush` と同じ形）。この形で、`turn.complete` → fork → usage → model → agent.list → cwd → `prompt.submit` → `ui.toast` の順に、差し替えがすべて呼ばれることを確認した。
- 実機（`claude -p`）で確かめたこと以外は、REPL を要する項目（`agent.list`、`breakdown`、サブスクリプション外の `rateLimits`）として、テストでは差し替えで再現する。
