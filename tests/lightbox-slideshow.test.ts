/**
 * #16: スライドショーの終端（純粋関数）。
 *
 * レビュー指摘: 終端（停止 / `hasMore` 中の追加読み込み）が未検証だった。
 * 画像の 3 秒送りと動画の再生完了の両方が同じ判定を使う。
 */
import { describe, expect, it } from 'vitest'
import { slideshowAction } from '../src/lib/lightbox'

describe('#16 スライドショーの遷移', () => {
  it('次のファイルがあれば送る', () => {
    expect(slideshowAction({ index: 0, count: 3, hasMore: false, loadingMore: false })).toBe(
      'next',
    )
  })

  it('末尾でまだ読めるページがあれば追加読み込みする', () => {
    expect(slideshowAction({ index: 2, count: 3, hasMore: true, loadingMore: false })).toBe(
      'load-more',
    )
  })

  it('追加読み込み中は止めず、二重に要求しない', () => {
    expect(slideshowAction({ index: 2, count: 3, hasMore: true, loadingMore: true })).toBe('wait')
  })

  it('読み込み切った終端で停止する', () => {
    expect(slideshowAction({ index: 2, count: 3, hasMore: false, loadingMore: false })).toBe(
      'stop',
    )
    // 1 件だけのときも終端
    expect(slideshowAction({ index: 0, count: 1, hasMore: false, loadingMore: false })).toBe(
      'stop',
    )
  })

  it('ファイルが 0 件なら停止する', () => {
    expect(slideshowAction({ index: 0, count: 0, hasMore: true, loadingMore: false })).toBe('stop')
  })
})
