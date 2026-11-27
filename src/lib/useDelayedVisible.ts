import { useEffect, useState } from 'react'

/**
 * #100: 読み込み表示（スケルトン）のちらつき防止。
 *
 * `active` が true になってから `delayMs` 経つまで false を返す。素早い応答
 * （200ms 未満）では一度も true にならないため、スケルトンが一瞬だけ出て
 * 消える「ちらつき」を避けられる。`active` が false に戻ったら即座に false。
 */
export function useDelayedVisible(active: boolean, delayMs = 200): boolean {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!active) {
      setVisible(false)
      return
    }
    const timer = window.setTimeout(() => setVisible(true), delayMs)
    return () => window.clearTimeout(timer)
  }, [active, delayMs])

  return visible
}
