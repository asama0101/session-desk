// 「定型文」タブの表示。受け取った値を描くだけで、`$` も atom も触らない。
import { OFF_COLOR } from './band'
import { stripControl } from './lib'
import { renderMore, shownCount } from './more'

type Ui = { Box: any; Text: any; Button: any; Input: any }

export type QuickArgs = {
  phrases: readonly string[]
  // 「もっと見る」を開いているか。
  open: boolean
  onAdd(text: string): void
  onSend(text: string): void
  // 位置ではなく文で指す。
  onRemove(text: string): void
  onMove(text: string, delta: number): void
  onToggleMore(): void
}

export function renderQuickTab(ui: Ui, a: QuickArgs) {
  const { Box, Text, Button, Input } = ui
  const { phrases } = a

  return (
    <Box flexDirection="column" gap={1}>
      {/* 文を足すと key が変わって作り直され、入力欄が空になる。足せなかったとき（空・重複）は、入力した文が残る。 */}
      <Input key={`quick-new-${phrases.length}`} placeholder="新しい定型文を入力して Enter" submitLabel="追加" onSubmit={(value: string) => a.onAdd(value)} />
      {phrases.length === 0 && <Text dimColor>なし</Text>}
      {phrases.slice(0, shownCount(phrases.length, a.open)).map((text, i) => (
        <Box flexDirection="column">
          <Text>{stripControl(text)}</Text>
          <Box gap={2}>
            <Button key={`quick-${i}`} plain label="▶ 送信" onPress={() => a.onSend(text)}>
              <Text color="suggestion">▶ 送信</Text>
            </Button>
            <Button key={`quick-del-${i}`} plain label="× 削除" onPress={() => a.onRemove(text)}>
              <Text color="error">× 削除</Text>
            </Button>
            {/* 順は 送信・削除・上へ・下へ。先頭の「上へ」と末尾の「下へ」は、押せない薄い字で位置を保つ。 */}
            {i > 0 ? (
              <Button key={`quick-up-${i}`} plain label="▲ 上へ" onPress={() => a.onMove(text, -1)}>
                <Text dimColor>▲ 上へ</Text>
              </Button>
            ) : (
              <Text color={OFF_COLOR}>▲ 上へ</Text>
            )}
            {i < phrases.length - 1 ? (
              <Button key={`quick-down-${i}`} plain label="▼ 下へ" onPress={() => a.onMove(text, 1)}>
                <Text dimColor>▼ 下へ</Text>
              </Button>
            ) : (
              <Text color={OFF_COLOR}>▼ 下へ</Text>
            )}
          </Box>
        </Box>
      ))}
      {renderMore({ Text, Button }, { tab: 'quick', total: phrases.length, open: a.open, onToggle: a.onToggleMore })}
    </Box>
  )
}
