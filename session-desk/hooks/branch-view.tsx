// 「ブランチ」タブの表示。Snapshot を文字で描くだけで、git も gh も呼ばない。
import { tidyUrl } from './branch'
import { renderMore, shownCount } from './more'
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
// name と url を持つ行は名前と URL を別の Text で描き、text だけの行は一文で描く。
type RemoteLine = { name: string; url: string } | { text: string }

function remoteLines(remotes: Snapshot['remotes']): RemoteLine[] {
  if (remotes === null) {
    return [{ text: 'リモート: 不明' }]
  }
  if (remotes.length === 0) {
    return [{ text: 'リモートなし' }]
  }
  const lines: RemoteLine[] = remotes.map(r => ({ name: r.name, url: tidyUrl(r.url) }))

  return remotes.some(r => r.name === 'origin') ? lines : [...lines, { text: 'origin なし' }]
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
  const byStage: Record<number, string> = { 2: 'inactive', 3: 'warning', 4: 'suggestion', 5: 'suggestion', 6: 'suggestion', 7: 'warning', 8: 'success', 9: 'merged' }

  return byStage[row.now.id ?? 0] ?? 'inactive'
}

function isNowStage(stage: Stage, row: BranchRow): boolean {
  return stage.id === row.now.id && stage.status === 'todo'
}

// 経過の 1 行の左側: 記号、段階名、件数などの補足、「今」の文言。日時は、右端に別の Text で出す。
function stageLine(stage: Stage, row: BranchRow): string {
  const isNow = isNowStage(stage, row)
  const symbol = stage.status === 'done' ? '✓' : isNow ? '●' : stage.status === 'unknown' ? '?' : stage.status === 'skipped' ? '－' : '○'
  const parts = [`${symbol} ${stage.label}`, stage.note ?? '', isNow ? row.now.text : '']

  return parts.filter(part => part !== '').join('  ')
}

function stageDate(stage: Stage, offsetMin: number): string {
  return stage.status === 'done' ? (stage.at === null ? '—' : formatAt(stage.at, offsetMin)) : ''
}

// レールの記号。最初は ┌、最後は └、間は ├。
const railGlyph = (i: number, count: number) => (i === 0 ? '┌' : i === count - 1 ? '└' : '├')

type Ui = { Box: any; Text: any; Button: any }
type Args = {
  snapshot: Snapshot | null
  selected: string | null
  columns: number
  offsetMin: number
  onSelect(name: string): void
  // 一覧の「もっと見る」。閉じているときは、先頭から数件と、いまのブランチ・選んだブランチだけを出す。
  more: { open: boolean; onToggle(): void }
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

  // 閉じているとき: 先頭から LIST_LIMIT 件。範囲の外でも、いまのブランチと選んだブランチは出す（経過の見出しが、一覧から消えないように）。
  const limit = shownCount(snap.branches.length, a.more.open)
  const visible = snap.branches.filter((row, i) => i < limit || row === current || row === chosen)

  const list = (
    <Box flexDirection="column">
      {visible.map(row => {
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
      {renderMore({ Text, Button }, { tab: 'git', total: snap.branches.length, shown: visible.length, open: a.more.open, onToggle: () => a.more.onToggle() })}
    </Box>
  )

  const detail = (
    <Box flexDirection="column">
      {chosen === undefined ? (
        <Text dimColor>ブランチがありません</Text>
      ) : chosen.kind === 'default' ? (
        <Text dimColor>経過はありません（既定ブランチ）</Text>
      ) : (
        <Box flexDirection="column">
          <Text bold>{stripControl(chosen.name)}</Text>
          {chosen.stages.map((stage, i) => {
            const isNow = isNowStage(stage, chosen)
            const date = stageDate(stage, a.offsetMin)

            return (
              <Box justifyContent="space-between" gap={2}>
                <Box gap={1}>
                  <Text color={isNow ? 'warning' : stage.status === 'done' ? 'success' : 'inactive'}>{railGlyph(i, chosen.stages.length)}</Text>
                  <Text color={isNow ? 'warning' : STATUS_COLOR[stage.status]} bold={isNow}>
                    {stripControl(stageLine(stage, chosen))}
                  </Text>
                </Box>
                {date !== '' && <Text dimColor>{date}</Text>}
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold>{`ブランチ ${snap.branches.length}`}</Text>
        {remoteLines(snap.remotes).map(line =>
          'text' in line ? (
            <Text dimColor>{stripControl(line.text)}</Text>
          ) : (
            <Box gap={2}>
              <Text color="suggestion">{stripControl(line.name)}</Text>
              <Text>{stripControl(line.url)}</Text>
            </Box>
          ),
        )}
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
