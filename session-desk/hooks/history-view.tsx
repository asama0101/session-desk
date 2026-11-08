// 「履歴」タブの表示。受け取った値を描くだけで、`$` も atom も触らない。
import { renderMore, shownCount } from './more'
import { preview, stripControl } from './lib'

type Ui = { Box: any; Text: any; Button: any }

export type HistoryArgs = {
  // 送ったプロンプト（送信順）。
  sent: readonly string[]
  // 全文を開いている番号（なければ null）。
  chosen: number | null
  // 「もっと見る」を開いているか。
  open: boolean
  onToggleFull(n: number): void
  onAddQuick(text: string): void
  onToggleMore(): void
}

export function renderHistoryTab(ui: Ui, a: HistoryArgs) {
  const { Box, Text, Button } = ui

  return (
    <Box flexDirection="column" gap={1}>
      {a.sent.length === 0 && <Text dimColor>なし</Text>}
      {a.sent
        .map((text, i) => ({ text, n: i + 1 }))
        .reverse()
        .slice(0, shownCount(a.sent.length, a.open))
        .map(({ text, n }) => {
          // 開いているかの判定は 1 回にして、label と見た目で食い違わないようにする。
          const isOpen = a.chosen === n
          const mark = isOpen ? '▴' : '▾'
          const word = isOpen ? '短く' : '全文'

          return (
            <Box flexDirection="column">
              <Text>{`${n}. ${isOpen ? stripControl(text) : preview(text)}`}</Text>
              <Box gap={2}>
                <Button key={`history-${n}`} plain label={`${mark} ${word}`} onPress={() => a.onToggleFull(n)}>
                  <Text color="suggestion">{`${mark} ${word}`}</Text>
                </Button>
                <Button key={`history-add-${n}`} plain label="＋ 定型文に追加" onPress={() => a.onAddQuick(text)}>
                  <Text color="suggestion">＋ 定型文に追加</Text>
                </Button>
              </Box>
            </Box>
          )
        })}
      {renderMore({ Text, Button }, { tab: 'history', total: a.sent.length, open: a.open, onToggle: a.onToggleMore })}
    </Box>
  )
}
