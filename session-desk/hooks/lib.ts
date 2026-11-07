const CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

// ゼロ幅文字と双方向制御文字（U+200B〜200F、202A〜202E、2066〜2069）。見た目を偽装できるので除く。
const RANGES: readonly (readonly [number, number])[] = [
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
]
const INVISIBLE = new RegExp(`[${RANGES.map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g')

export function stripControl(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(CONTROL, '').replace(INVISIBLE, '')
}

const PREVIEW_CHARS = 60

// 一覧に出す 1 行。制御コードを除き、空白を 1 つにまとめ、60 字で切る。
export function preview(text: string): string {
  const flat = stripControl(text).replace(/\s+/g, ' ').trim()

  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS)}…`
}

// 定型文の初期値。保存した値が読めないときも、これに戻す。
export const DEFAULT_QUICK: readonly string[] = [
  '残りのタスクは？',
  '選択肢ごとにメリット・デメリットを明確にして推奨および影響をレポートして',
  'Artifact使ってデザインを見せて',
]

// ストアから読んだ値が、空でない文字列の配列のときだけ返す。外から来る値なので検証する。
export function parseQuick(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || !raw.every(item => typeof item === 'string' && item !== '')) {
    return null
  }

  return [...raw]
}

export function addQuick(list: readonly string[], text: string): string[] {
  const clean = stripControl(text).trim()

  return clean === '' || list.includes(clean) ? [...list] : [...list, clean]
}

export function removeQuick(list: readonly string[], index: number): string[] {
  return list.filter((_, i) => i !== index)
}
