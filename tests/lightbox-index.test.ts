/**
 * #16: 削除後のライトボックス index（純粋関数）。
 *
 * レビュー指摘: 表示は `Math.min` で丸めていたが、履歴（`route.fileIndex`）は
 * 古いままだった。削除後にどこを見るべきかをここで固定する。
 */
import { describe, expect, it } from 'vitest'
import {
  clampLightboxIndex,
  lightboxIndexAfterDelete,
} from '../src/lib/lightbox'

/** id だけを持つ最小の並び（`FileSummary` を持ち込まない）。 */
function ids(...values: number[]) {
  return values.map((id) => ({ id }))
}

describe('#16 削除後のライトボックス index', () => {
  it('最後の 1 枚を削除すると前のファイルへ移る', () => {
    const files = ids(11, 12, 13)
    // 13（添字 2）を表示中に 13 を削除
    expect(lightboxIndexAfterDelete({ files, index: 2, deletedIds: [13] })).toBe(1)
  })

  it('末尾を超える index は clamp する', () => {
    expect(clampLightboxIndex(5, 3)).toBe(2)
    expect(clampLightboxIndex(-4, 3)).toBe(0)
    expect(clampLightboxIndex(0, 0)).toBeNull()
    // 表示中が残る場合も、新しい並びの位置へ丸める
    expect(
      lightboxIndexAfterDelete({ files: ids(11, 12, 13), index: 9, deletedIds: [13] }),
    ).toBe(1)
  })

  it('残りが 0 件なら閉じる（null）', () => {
    expect(lightboxIndexAfterDelete({ files: ids(11), index: 0, deletedIds: [11] })).toBeNull()
    expect(
      lightboxIndexAfterDelete({ files: ids(11, 12), index: 1, deletedIds: [11, 12] }),
    ).toBeNull()
    expect(lightboxIndexAfterDelete({ files: [], index: 0, deletedIds: [] })).toBeNull()
  })

  it('表示中のファイルが残るなら、同じファイルの新しい位置を返す', () => {
    // 先頭を消しても 13 を見ていたなら、13 は 1 つ前（添字 1）へ詰まる
    expect(
      lightboxIndexAfterDelete({ files: ids(11, 12, 13), index: 2, deletedIds: [11] }),
    ).toBe(1)
    // 1 件も消えない（削除が中止された）なら index は変わらない
    expect(
      lightboxIndexAfterDelete({ files: ids(11, 12, 13), index: 1, deletedIds: [] }),
    ).toBe(1)
  })

  it('表示中より前を複数削除しても、直前の残っているファイルへ移る', () => {
    const files = ids(11, 12, 13, 14)
    // 13 を表示中に 12 と 13 を削除 → 残りは 11, 14。直前の残りは 11
    expect(
      lightboxIndexAfterDelete({ files, index: 2, deletedIds: [12, 13] }),
    ).toBe(0)
    // 先頭から表示中まで全部消えたら、残りの先頭（14）を出す
    expect(
      lightboxIndexAfterDelete({ files, index: 3, deletedIds: [11, 12, 13, 14] }),
    ).toBeNull()
    expect(
      lightboxIndexAfterDelete({ files: ids(11, 12, 13), index: 0, deletedIds: [11, 12] }),
    ).toBe(0)
  })

  it('読み込まれていない id（別ページ）は無視する', () => {
    expect(
      lightboxIndexAfterDelete({ files: ids(11, 12), index: 1, deletedIds: [999, 12] }),
    ).toBe(0)
  })
})
