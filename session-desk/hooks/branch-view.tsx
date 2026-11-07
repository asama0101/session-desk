// 「ブランチ」タブの表示。Snapshot を文字で描くだけで、git も gh も呼ばない。
import type { BranchRow, Kind, Stage } from './branch'
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
  timeout: '取得が時間切れです',
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

function stageLine(stage: Stage, row: BranchRow, offsetMin: number): string {
  const isNow = stage.id === row.now.id && stage.status === 'todo'
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
        <Text>{PROBLEM_TEXT[snap.problem]}</Text>
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

        return row === chosen ? (
          <Button key={key} plain label={label} onPress={() => a.onSelect(row.name)}>
            <Text bold>{label}</Text>
          </Button>
        ) : (
          <Button key={key} plain dimColor label={label} onPress={() => a.onSelect(row.name)} />
        )
      })}
    </Box>
  )

  const detail = (
    <Box flexDirection="column">
      {chosen === undefined || chosen.kind === 'default' ? (
        <Text dimColor>経過はありません（既定ブランチ）</Text>
      ) : (
        chosen.stages.map(stage => <Text>{stripControl(stageLine(stage, chosen, a.offsetMin))}</Text>)
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
        <Text>{stripControl(warning)}</Text>
      ))}
      <Text dimColor>{footer}</Text>
    </Box>
  )
}
