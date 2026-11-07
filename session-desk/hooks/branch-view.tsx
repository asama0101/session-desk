// 「ブランチ」タブの表示。Snapshot を文字で描くだけで、git も gh も呼ばない。
import { actionOf } from './branch'
import type { Action, BranchRow, Kind, Stage } from './branch'
import type { Problem, Snapshot } from './git'
import { stripControl } from './lib'

const KIND_LABEL: Record<Kind, string> = {
  feat: 'feat',
  fix: 'fix',
  docs: 'docs',
  chore: 'chore',
  other: 'その他',
  default: '既定',
}

const PROBLEM_TEXT: Record<Exclude<Problem, null>, string> = {
  'not-repo': 'Git のリポジトリではありません',
  'no-commit': 'commit がまだありません',
  'unsafe-owner': 'リポジトリの所有者が違います',
  timeout: '取得が時間切れか、git を実行できません',
  'git-failed': 'git の実行に失敗しました',
}

// この幅（列）以上なら、一覧と経過を左右に並べる。
const WIDE_COLUMNS = 100

const pad = (n: number) => String(n).padStart(2, '0')

// offsetMin（東が正）の時刻で `MM/DD HH:mm`。読めない日時は `—`。
export function formatAt(iso: string, offsetMin: number): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    return '—'
  }
  const d = new Date(ms + offsetMin * 60_000)

  return `${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// origin の同名ブランチとの差。差があるときだけ、`↑2 ↓1  ` の形（末尾に空白 2 つ）で返す。
function diffText(diff: BranchRow['facts']['originDiff']): string {
  if (diff === null || diff === undefined) {
    return ''
  }
  const parts = [diff.ahead > 0 ? `↑${diff.ahead}` : '', diff.behind > 0 ? `↓${diff.behind}` : ''].filter(part => part !== '')

  return parts.length === 0 ? '' : `${parts.join(' ')}  `
}

// 見出しの下に出すリモートの行。取れなかったとき・ないとき・origin だけがないときも、言葉にする。
function remoteLines(remotes: Snapshot['remotes']): string[] {
  if (remotes === null) {
    return ['リモート: 不明']
  }
  if (remotes.length === 0) {
    return ['リモートなし']
  }
  const lines = remotes.map(r => `${r.name}  ${r.url}`)

  return remotes.some(r => r.name === 'origin') ? lines : [...lines, 'origin なし']
}

// テーマの色名。明るい端末でも暗い端末でも読める。
const STATUS_COLOR = { done: 'success', todo: 'inactive', unknown: 'error', skipped: 'inactive' } as const

// 一覧の行の色。右端の「今」で決める。
function rowColor(row: BranchRow): string {
  if (row.kind === 'default') {
    return 'inactive'
  }
  if (row.now.text.startsWith('今:')) {
    return 'error'
  }
  if (row.now.text.startsWith('commit 済み')) {
    return 'success'
  }
  const byStage: Record<number, string> = { 2: 'inactive', 3: 'warning', 4: 'suggestion', 5: 'suggestion', 6: 'warning', 7: 'success', 8: 'merged' }

  return byStage[row.now.id ?? 0] ?? 'inactive'
}

function isNowStage(stage: Stage, row: BranchRow): boolean {
  return stage.id === row.now.id && stage.status === 'todo'
}

function stageLine(stage: Stage, row: BranchRow, offsetMin: number): string {
  const isNow = isNowStage(stage, row)
  const symbol = stage.status === 'done' ? '✓' : isNow ? '●' : stage.status === 'unknown' ? '?' : stage.status === 'skipped' ? '－' : '○'
  const date = stage.status === 'done' ? (stage.at === null ? '—' : formatAt(stage.at, offsetMin)) : ''
  const parts = [`${symbol} ${stage.label}`, date, stage.note ?? '', isNow ? row.now.text : '']

  return parts.filter(part => part !== '').join('  ')
}

type Ui = { Box: any; Text: any; Button: any }
type Args = {
  snapshot: Snapshot | null
  selected: string | null
  columns: number
  offsetMin: number
  onSelect(name: string): void
  // yes/no。dismissed は「いいえ」や「はい」を押した質問の key、confirm は 2 段目の確認中の key。
  act: {
    dismissed: readonly string[]
    confirm: string | null
    onYes(action: Action): void
    onNo(action: Action): void
    onConfirm(action: Action): void
  }
}

export function renderBranchTab(ui: Ui, a: Args) {
  const { Box, Text, Button } = ui
  const snap = a.snapshot
  if (snap === null) {
    return <Text dimColor>読み込み中</Text>
  }
  const noOrigin = snap.remotes !== null && !snap.remotes.some(r => r.name === 'origin')
  const footer = `git ${snap.gitAt} / gh ${noOrigin ? '対象外' : (snap.ghAt ?? '不明')}`
  if (snap.problem !== null) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">{PROBLEM_TEXT[snap.problem]}</Text>
        <Text dimColor>{footer}</Text>
      </Box>
    )
  }

  const current = snap.branches.find(b => b.isCurrent)
  const chosen = snap.branches.find(b => b.name === a.selected) ?? current ?? snap.branches[0]
  const wide = a.columns >= WIDE_COLUMNS

  const list = (
    <Box flexDirection="column">
      {snap.branches.map(row => {
        const diff = diffText(row.facts.originDiff)
        const label = stripControl(`${row.isCurrent ? '＊' : '　'}${KIND_LABEL[row.kind]} ${row.name}  ${diff}${row.now.text}`)
        const key = `branch-${row.name}`

        return (
          <Button key={key} plain label={label} onPress={() => a.onSelect(row.name)}>
            <Text color={rowColor(row)} bold={row === chosen}>
              {label}
            </Text>
          </Button>
        )
      })}
    </Box>
  )

  const defaultName = snap.branches.find(b => b.kind === 'default')?.name ?? null
  const action = chosen === undefined ? null : actionOf(chosen, defaultName)
  const asking = action !== null && chosen !== undefined && !a.act.dismissed.includes(action.key)

  const detail = (
    <Box flexDirection="column">
      {chosen === undefined ? (
        <Text dimColor>ブランチがありません</Text>
      ) : chosen.kind === 'default' ? (
        <Text dimColor>経過はありません（既定ブランチ）</Text>
      ) : (
        chosen.stages.map(stage => {
          const isNow = isNowStage(stage, chosen)

          return (
            <Text color={isNow ? 'warning' : STATUS_COLOR[stage.status]} bold={isNow}>
              {stripControl(stageLine(stage, chosen, a.offsetMin))}
            </Text>
          )
        })
      )}
      {asking && chosen !== undefined && action !== null && a.act.confirm === action.key && (
        <Box gap={2} flexWrap="wrap">
          <Text color="error">{stripControl(`本当に ${chosen.name} を削除しますか？`)}</Text>
          <Button key={`act-confirm:${action.key}`} plain label="削除する" onPress={() => a.act.onConfirm(action)}>
            <Text color="error">削除する</Text>
          </Button>
          <Button key={`act-cancel:${action.key}`} plain label="やめる" onPress={() => a.act.onNo(action)}>
            <Text>やめる</Text>
          </Button>
        </Box>
      )}
      {asking && action !== null && a.act.confirm !== action.key && (
        <Box gap={2}>
          <Text color="warning">{action.question}</Text>
          <Button key={`act-yes:${action.key}`} plain label="はい" onPress={() => a.act.onYes(action)}>
            <Text color="success">はい</Text>
          </Button>
          <Button key={`act-no:${action.key}`} plain label="いいえ" onPress={() => a.act.onNo(action)}>
            <Text color="error">いいえ</Text>
          </Button>
        </Box>
      )}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{`ブランチ ${snap.branches.length}`}</Text>
        {remoteLines(snap.remotes).map(line => (
          <Text dimColor>{stripControl(line)}</Text>
        ))}
      </Box>
      <Box key={wide ? 'branch-wide' : 'branch-narrow'} flexDirection={wide ? 'row' : 'column'} gap={wide ? 3 : 1}>
        {list}
        {detail}
      </Box>
      {snap.warnings.map(warning => (
        <Text color="warning">{stripControl(warning)}</Text>
      ))}
      <Text dimColor>{footer}</Text>
    </Box>
  )
}
