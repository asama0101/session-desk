// 長い一覧を、新しいほう（先頭）から LIST_LIMIT 件だけ出し、残りは「もっと見る」で開く。
export const LIST_LIMIT = 5

type Ui = { Text: any; Button: any }

// 閉じているときに出す件数。開いているとき、または LIST_LIMIT 件以下なら、全部。
export function shownCount(total: number, open: boolean): number {
  return open ? total : Math.min(total, LIST_LIMIT)
}

// 一覧の下のボタン。LIST_LIMIT 件以下なら出さない。key は `more-<タブ>`。
export function renderMore(ui: Ui, a: { tab: string; total: number; open: boolean; onToggle(): void; shown?: number }) {
  const { Text, Button } = ui
  if (a.total <= LIST_LIMIT) {
    return null
  }
  const label = a.open ? '▴ 閉じる' : `▾ もっと見る（あと ${a.total - (a.shown ?? LIST_LIMIT)} 件）`

  return (
    <Button key={`more-${a.tab}`} plain label={label} onPress={() => a.onToggle()}>
      <Text color="suggestion">{label}</Text>
    </Button>
  )
}
