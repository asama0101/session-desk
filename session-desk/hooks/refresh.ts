// 更新の予約。エンジンに触れないので、時刻と待ちを差し込んでテストできる。

const MIN_GAP_MS = 2000
const GH_BASE_MS = 60_000
const GH_MAX_MS = 600_000

// 実行中なら、終わった直後に 1 回だけ追加で実行する。実行中でなく、前回の開始から 2 秒未満なら、
// 残りの時間だけ待ってから 1 回にまとめて実行する。withGh は、まとめた要求の論理和。
export function createRefresher(deps: {
  run: (withGh: boolean) => Promise<void>
  now: () => number
  delay: (ms: number) => Promise<void>
}): { request(withGh: boolean): void } {
  let running = false
  let pending: boolean | null = null
  let waiting: boolean | null = null
  let lastStart = Number.NEGATIVE_INFINITY

  async function start(withGh: boolean): Promise<void> {
    running = true
    lastStart = deps.now()
    try {
      await deps.run(withGh)
    } catch {
      // 失敗しても、次の要求は受け付ける。
    }
    running = false
    if (pending !== null) {
      const next = pending
      pending = null
      await start(next)
    }
  }

  return {
    request(withGh) {
      if (running) {
        pending = (pending ?? false) || withGh

        return
      }
      if (waiting !== null) {
        waiting = waiting || withGh

        return
      }
      const wait = lastStart + MIN_GAP_MS - deps.now()
      if (wait > 0) {
        waiting = withGh
        // 待ちが失敗しても、予約を戻して次の要求を受け付ける（失敗したときは、実行せずに捨てる）。
        void deps.delay(wait).then(
          () => {
            const gh = waiting ?? false
            waiting = null

            return start(gh)
          },
          () => {
            waiting = null
          },
        )

        return
      }
      void start(withGh)
    },
  }
}

// 単語としての gh、または単語としての git と push の両方を含むとき真。
export function wantsGh(command: string): boolean {
  const words = command.split(/[\s;&|()]+/)

  return words.includes('gh') || (words.includes('git') && words.includes('push'))
}

export function ghDelayMs(failures: number): number {
  return Math.min(GH_BASE_MS * 2 ** failures, GH_MAX_MS)
}

export async function around<T>(next: () => Promise<T>, after: () => void): Promise<T> {
  try {
    return await next()
  } finally {
    after()
  }
}
