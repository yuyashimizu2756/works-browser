/**
 * 画像なしカードのタイポグラフィック・カバー（#98）。
 *
 * サムネイル非表示が既定なので、プレースホルダは「暗い空箱」ではなく作品の
 * タイトルから決まる表紙にする。色相はタイトルのハッシュ、中央の文字は
 * タイトルの先頭（日本語は 1 文字、英数字は 2 文字）。同じ作品は常に同じ
 * 見た目になるよう、乱数ではなく決定的なハッシュを使う。
 */

/** 日本語（漢字・ひらがな・カタカナ）だけを 1 文字扱いにするための判定。 */
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u
/** 文字として数えるもの（記号・空白は読み飛ばす）。 */
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u

const FNV_OFFSET = 2166136261
const FNV_PRIME = 16777619

/** タイトル文字列の FNV-1a ハッシュ（符号なし 32bit）。 */
export function titleHash(title: string): number {
  let hash = FNV_OFFSET
  for (const char of title) {
    hash ^= char.codePointAt(0) ?? 0
    hash = Math.imul(hash, FNV_PRIME)
  }
  return hash >>> 0
}

/** タイトルから 0〜359 の色相。彩度・明度は CSS 側で固定する。 */
export function hueForTitle(title: string): number {
  return titleHash(title) % 360
}

/**
 * カバー中央に置く文字。
 * - 日本語で始まるタイトル → 1 文字
 * - 英数字で始まるタイトル → 2 文字（大文字化）
 * - 記号・空白は読み飛ばし、文字が無ければ `·`
 */
export function initialsForTitle(title: string): string {
  const chars = Array.from(title.trim())
  if (chars.length === 0) return '·'

  const first = chars.find((char) => LETTER_OR_NUMBER.test(char)) ?? chars[0]
  if (!first) return '·'
  if (JAPANESE.test(first)) return first

  const letters = chars.filter((char) => LETTER_OR_NUMBER.test(char)).slice(0, 2)
  if (letters.length === 0) return first
  if (JAPANESE.test(letters[0])) return letters[0]
  return letters.join('').toUpperCase()
}

/** カバー高さに合わせた文字サイズ（56〜72px）。 */
export function placeholderFontSize(coverHeight: number | undefined): number {
  if (coverHeight === undefined || coverHeight <= 0) return 64
  return Math.round(Math.min(72, Math.max(56, coverHeight * 0.36)))
}
