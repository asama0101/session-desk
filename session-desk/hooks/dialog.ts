// 質問や許可の待ち（ダイアログ）が開いているかを調べる。状態は読み書きしない。

// 質問や許可の待ち（ダイアログ）が開いているか。空の文を下書きの後ろに足す呼び出しで調べる（下書きは変わらない）。
// ダイアログが入力を持っているあいだ、エンジンは refusal: 'dialog' で断る。ほかのプラグインのフックが断ったときは、理由が付かない。
// 理由が分からない断りは、入力欄を守る側（開いている）に倒す。入力欄がない（no_composer）とき、調べられないとき（呼び出しが失敗）は、開いていないとみなす。
async function dialogOpen($: any): Promise<boolean> {
  try {
    const result = await $.prompt.fill({ text: '', mode: 'append' })

    return result.isFilled === false && result.refusal !== 'no_composer'
  } catch {
    return false
  }
}

// ダイアログが開いているなら、依頼を送らずに知らせる（質問の答えと、ボタンの依頼が衝突するため）。送ってよければ偽。
export async function blockedByDialog($: any): Promise<boolean> {
  if (await dialogOpen($)) {
    void Promise.resolve()
      .then(() => $.ui.toast('質問や許可の待ち中です。先に答えてください'))
      .catch(() => {})

    return true
  }

  return false
}
