// 今の effort を探す（/config の行、環境変数、設定ファイルの順）。状態は読み書きしない。

// 今の effort を、読めるところから順に探す。どれも読めなければ null（見出しに effort を出さない）。
//   1. /config の行（名前に effort を含む行）
//   2. 環境変数 CLAUDE_EFFORT
//   3. 設定ファイルの effortLevel（プロジェクトの settings.local.json、settings.json、ユーザーの settings.json の順）。起動後に /effort で変えた値は、ここには載らない。
async function readEffort($: any, cwd: string | null): Promise<string | null> {
  const level = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
  try {
    const rows: { key: string; label: string; value: unknown }[] = await $.config.list()
    const row = rows.find(r => /effort/i.test(r.key) || /effort/i.test(r.label))
    const found = level(row?.value)
    if (found !== null) {
      return found
    }
  } catch {
    // 次の手段へ。
  }
  try {
    const found = level(await $.env.get('CLAUDE_EFFORT'))
    if (found !== null) {
      return found
    }
  } catch {
    // 次の手段へ。
  }
  const files: string[] = []
  const slash = (path: string) => path.split(String.fromCharCode(92)).join('/')
  if (cwd !== null) {
    files.push(`${slash(cwd)}/.claude/settings.local.json`, `${slash(cwd)}/.claude/settings.json`)
  }
  try {
    const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? null
    const home = config === null ? ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? null) : null
    const user = config !== null ? slash(config) : home !== null ? `${slash(home)}/.claude` : null
    if (user !== null) {
      files.push(`${user}/settings.json`)
    }
  } catch {
    // ユーザーの設定は探さない。
  }
  for (const file of files) {
    try {
      const found = level(JSON.parse(await $.fs.read(file)).effortLevel)
      if (found !== null) {
        return found
      }
    } catch {
      // ファイルがない・読めない・JSON でないときは、次へ。
    }
  }

  return null
}

// effort の読み取りの結果。取得のたびに設定ファイルまで読み直さないように、ターンの始まりとセッションの始まりまで使い回す。
let effortCache: { cwd: string | null; value: string | null } | null = null

// 今の effort。同じ作業フォルダのあいだは、前に読んだ値を使い回す。
export async function cachedEffort($: any, cwd: string | null): Promise<string | null> {
  if (effortCache === null || effortCache.cwd !== cwd) {
    effortCache = { cwd, value: await readEffort($, cwd) }
  }

  return effortCache.value
}

// 使い回しをやめる（ターンの始まりと、セッションの始まりで呼ぶ）。
export function forgetEffort(): void {
  effortCache = null
}
