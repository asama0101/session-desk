import { expect, test } from 'claude-code/testing'

import { around, createRefresher, ghDelayMs, wantsGh } from './refresh'

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0))

// 手動で終わらせられる run と、時刻・待ちの偽物。
function harness() {
  const runs: boolean[] = []
  const finishers: (() => void)[] = []
  const delays: { ms: number; release: () => void }[] = []
  let time = 0
  const refresher = createRefresher({
    run: withGh => {
      runs.push(withGh)

      return new Promise<void>(resolve => finishers.push(resolve))
    },
    now: () => time,
    delay: ms =>
      new Promise<void>(resolve => {
        delays.push({ ms, release: resolve })
      }),
  })

  return {
    refresher,
    runs,
    delays,
    finish: async () => {
      finishers.shift()?.()
      await flush()
    },
    at: (t: number) => {
      time = t
    },
  }
}

test('a single request runs once with the requested withGh', async () => {
  const h = harness()
  h.refresher.request(false)
  await flush()
  expect(h.runs).toEqual([false])
})

test('requests that arrive while a run is in flight collapse into one more run right after it', async () => {
  const h = harness()
  h.refresher.request(false)
  await flush()
  h.refresher.request(false)
  h.refresher.request(false)
  h.refresher.request(false)
  await flush()
  expect(h.runs).toEqual([false])
  await h.finish()
  expect(h.runs).toEqual([false, false])
  expect(h.delays).toEqual([])
  await h.finish()
  expect(h.runs.length).toBe(2)
})

test('the one extra run asks for gh when any pending request asked for it', async () => {
  const h = harness()
  h.refresher.request(false)
  await flush()
  h.refresher.request(false)
  h.refresher.request(true)
  await h.finish()
  expect(h.runs).toEqual([false, true])
})

test('a request within 2000 ms of the last start waits for the remainder, then runs once; later ones join it', async () => {
  const h = harness()
  h.at(0)
  h.refresher.request(false)
  await flush()
  await h.finish()
  h.at(500)
  h.refresher.request(false)
  h.refresher.request(true)
  await flush()
  expect(h.runs).toEqual([false])
  expect(h.delays.map(d => d.ms)).toEqual([1500])
  h.delays[0]?.release()
  await flush()
  expect(h.runs).toEqual([false, true])
  await h.finish()
})

test('a request 2000 ms or more after the last start runs without waiting', async () => {
  const h = harness()
  h.at(0)
  h.refresher.request(false)
  await flush()
  await h.finish()
  h.at(2000)
  h.refresher.request(false)
  await flush()
  expect(h.runs).toEqual([false, false])
  expect(h.delays).toEqual([])
  await h.finish()
})

test('a run that rejects does not stop the next request', async () => {
  const runs: number[] = []
  let time = 0
  const refresher = createRefresher({
    run: async () => {
      runs.push(runs.length)
      if (runs.length === 1) {
        throw new Error('boom')
      }
    },
    now: () => time,
    delay: async () => {},
  })
  refresher.request(false)
  await flush()
  time = 5000
  refresher.request(false)
  await flush()
  expect(runs.length).toBe(2)
})

test('wantsGh matches the gh command and git push as whole words only', async () => {
  expect(wantsGh('gh pr create')).toBe(true)
  expect(wantsGh('git push -u origin x')).toBe(true)
  expect(wantsGh('git -C x push')).toBe(true)
  expect(wantsGh('cd /d/x && gh pr view')).toBe(true)
  expect(wantsGh('ls high')).toBe(false)
  expect(wantsGh('echo github')).toBe(false)
  expect(wantsGh('git status')).toBe(false)
  expect(wantsGh('echo through')).toBe(false)
})

test('ghDelayMs doubles from 60 s per failure and stops at 10 minutes', async () => {
  expect(ghDelayMs(0)).toBe(60000)
  expect(ghDelayMs(1)).toBe(120000)
  expect(ghDelayMs(3)).toBe(480000)
  expect(ghDelayMs(9)).toBe(600000)
})

test('around runs after() once whether next resolves or rejects, and rethrows the same error', async () => {
  let afters = 0
  expect(await around(async () => 'ok', () => afters++)).toBe('ok')
  expect(afters).toBe(1)
  const error = new Error('denied')
  let caught: unknown
  try {
    await around(async () => {
      throw error
    }, () => afters++)
  } catch (e) {
    caught = e
  }
  expect(caught).toBe(error)
  expect(afters).toBe(2)
})

test('a delay that fails does not leave the refresher waiting forever', async () => {
  const runs: boolean[] = []
  let time = 0
  const refresher = createRefresher({
    run: async withGh => {
      runs.push(withGh)
    },
    now: () => time,
    delay: () => Promise.reject(new Error('sleep aborted')),
  })
  refresher.request(false)
  await flush()
  time = 100
  refresher.request(false)
  await flush()
  await flush()
  time = 10_000
  refresher.request(false)
  await flush()
  expect(runs.length).toBe(2)
})
