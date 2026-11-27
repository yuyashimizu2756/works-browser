/**
 * 生成情報の差分（#74）。
 *
 * 比較ビュー（#71）の「差分」タブで使う純関数だけを置く。
 * UI（`src/library/MetaDiffPanel.tsx`）はここが返すモデルを描画するだけで、
 * 比較・トークン分割・LCS のロジックは持たない。
 *
 * - prompt / negative はトークン単位の LCS 差分（追加 / 削除 / 一致）
 * - 日本語は 1 文字、英語・数字は単語、記号は 1 文字をトークンにする
 *   （外部ライブラリなし。`Intl.Segmenter` にも依存しない）
 * - LoRA は集合差（共通 / 1 枚目のみ / 2 枚目のみ）
 * - `null`（生成情報に項目が無い）と `''`（項目はあるが空）は別物として扱う
 */
import type { GenerationMeta } from '../api'

export type MetaFieldKey =
  | 'prompt'
  | 'negative_prompt'
  | 'model'
  | 'loras'
  | 'steps'
  | 'sampler'
  | 'cfg'
  | 'seed'
  | 'size'

export type MetaFieldStatus = 'same' | 'changed'

export type DiffTokenKind = 'same' | 'added' | 'removed'

export type DiffToken = {
  text: string
  kind: DiffTokenKind
}

export type TokenDiff = {
  /** 1 枚目（削除を赤で示す）。 */
  a: DiffToken[]
  /** 2 枚目（追加を緑で示す）。 */
  b: DiffToken[]
  /** トークン列として違いがあるか。 */
  changed: boolean
}

export type TextMetaFieldDiff = {
  key: Exclude<MetaFieldKey, 'loras'>
  kind: 'text'
  label: string
  status: MetaFieldStatus
  a: string | null
  b: string | null
  /** prompt / negative を差分表示するときだけ入る。 */
  tokens: TokenDiff | null
}

export type LoraMetaFieldDiff = {
  key: 'loras'
  kind: 'loras'
  label: string
  status: MetaFieldStatus
  a: string[]
  b: string[]
  /** 両方に含まれる（順序は安定ソート済み）。 */
  common: string[]
  /** 1 枚目にだけ含まれる（2 枚目では削除）。 */
  onlyA: string[]
  /** 2 枚目にだけ含まれる（2 枚目で追加）。 */
  onlyB: string[]
}

export type MetaFieldDiff = TextMetaFieldDiff | LoraMetaFieldDiff

/** 2 枚のうち生成情報を持っている側。 */
export type MetaPresence = 'both' | 'onlyA' | 'onlyB' | 'none'

export type GenerationMetaDiff = {
  presence: MetaPresence
  fields: MetaFieldDiff[]
  sameFields: MetaFieldDiff[]
  changedFields: MetaFieldDiff[]
  sameCount: number
  changedCount: number
  /** seed 以外がすべて同じで、seed が両方にあり違う。 */
  seedOnly: boolean
}

type FieldSpec = {
  key: MetaFieldKey
  label: string
  /** トークン差分を出す項目。 */
  tokens: boolean
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { key: 'prompt', label: 'プロンプト', tokens: true },
  { key: 'negative_prompt', label: 'ネガティブ', tokens: true },
  { key: 'model', label: 'モデル', tokens: false },
  { key: 'loras', label: 'LoRA', tokens: false },
  { key: 'steps', label: 'Steps', tokens: false },
  { key: 'sampler', label: 'サンプラー', tokens: false },
  { key: 'cfg', label: 'CFG', tokens: false },
  { key: 'seed', label: 'Seed', tokens: false },
  { key: 'size', label: 'サイズ', tokens: false },
]

/**
 * トークン境界。
 *
 * - 空白はまとめて 1 トークン（差分表示で空白の増減も見える）
 * - 日本語（漢字・ひらがな・カタカナ・ハングル）は 1 文字ずつ。
 *   空白の無い日本語でも語順や 1 文字違いが壊れない
 * - 英数字は単語単位（`_` を含む）
 * - 記号・句読点は 1 文字ずつ
 * - 上記以外（絵文字など）はコードポイント単位
 */
const TOKEN_PATTERN =
  /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|[\p{P}\p{S}]|[^\s]/gu

/** LCS の表が大きくなりすぎないための上限（セル数）。超えたら中央は丸ごと差分扱い。 */
const MAX_LCS_CELLS = 1_000_000

/** 文字列を差分表示用のトークンへ分ける。分割しても連結すれば元に戻る。 */
export function tokenizePrompt(text: string): string[] {
  if (!text) return []
  return text.match(TOKEN_PATTERN) ?? []
}

function lcsMatches(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const columns = b.length + 1
  const table = new Uint32Array((a.length + 1) * columns)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * columns + j] =
        a[i] === b[j]
          ? table[(i + 1) * columns + (j + 1)] + 1
          : Math.max(table[(i + 1) * columns + j], table[i * columns + j + 1])
    }
  }

  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i += 1
      j += 1
    } else if (table[(i + 1) * columns + j] >= table[i * columns + j + 1]) {
      i += 1
    } else {
      j += 1
    }
  }
  return pairs
}

/**
 * 2 つの文字列のトークン差分。
 *
 * 先頭・末尾の一致部分を外してから LCS を取る（プロンプトの大半が同じ場合に軽い）。
 * LCS が大きすぎる場合は中央を削除 + 追加として返す（表示が壊れないだけで、内容は失わない）。
 */
export function diffTokens(aText: string, bText: string): TokenDiff {
  const a = tokenizePrompt(aText)
  const b = tokenizePrompt(bText)

  let prefix = 0
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const aMiddle = a.slice(prefix, a.length - suffix)
  const bMiddle = b.slice(prefix, b.length - suffix)
  const useLcs =
    aMiddle.length > 0 &&
    bMiddle.length > 0 &&
    aMiddle.length * bMiddle.length <= MAX_LCS_CELLS
  const pairs = useLcs ? lcsMatches(aMiddle, bMiddle) : []

  const outA: DiffToken[] = []
  const outB: DiffToken[] = []
  for (let index = 0; index < prefix; index += 1) {
    outA.push({ text: a[index], kind: 'same' })
    outB.push({ text: b[index], kind: 'same' })
  }

  let ai = 0
  let bi = 0
  for (const [matchA, matchB] of pairs) {
    while (ai < matchA) {
      outA.push({ text: aMiddle[ai], kind: 'removed' })
      ai += 1
    }
    while (bi < matchB) {
      outB.push({ text: bMiddle[bi], kind: 'added' })
      bi += 1
    }
    outA.push({ text: aMiddle[matchA], kind: 'same' })
    outB.push({ text: bMiddle[matchB], kind: 'same' })
    ai += 1
    bi += 1
  }
  while (ai < aMiddle.length) {
    outA.push({ text: aMiddle[ai], kind: 'removed' })
    ai += 1
  }
  while (bi < bMiddle.length) {
    outB.push({ text: bMiddle[bi], kind: 'added' })
    bi += 1
  }

  for (let offset = 0; offset < suffix; offset += 1) {
    outA.push({ text: a[a.length - suffix + offset], kind: 'same' })
    outB.push({ text: b[b.length - suffix + offset], kind: 'same' })
  }

  return {
    a: outA,
    b: outB,
    changed: outA.some((token) => token.kind === 'removed') || outB.some((token) => token.kind === 'added'),
  }
}

/** 比較用に前後の空白を落とす。`null` はそのまま（`''` と区別する）。 */
export function normalizeMetaText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  return value.trim()
}

/** LoRA 名の配列を、空要素を除いて重複なしにする（順序はそのまま）。 */
export function normalizeLoras(values: readonly string[] | null | undefined): string[] {
  if (!values) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const name = value.trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    result.push(name)
  }
  return result
}

function sameLoraSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  return b.every((name) => set.has(name))
}

/**
 * 値の表示文字列。
 *
 * `null` は「生成情報にその項目が無い」、`''` は「項目はあるが空」。
 * 見た目で区別できるよう、別々の文言を返す。
 */
export function formatMetaValue(value: string | null): string {
  if (value === null) return '（なし）'
  if (value.trim() === '') return '（空）'
  return value
}

/**
 * 2 枚分の生成情報を、表示用の差分モデルへ変換する。
 *
 * `null` の生成情報（抽出できなかったファイル）も受け取り、`presence` で
 * 「片方に生成情報が無い」ことを示す。空欄の項目とは別物。
 */
export function diffGenerationMeta(
  a: GenerationMeta | null,
  b: GenerationMeta | null,
): GenerationMetaDiff {
  const presence: MetaPresence =
    a === null ? (b === null ? 'none' : 'onlyB') : b === null ? 'onlyA' : 'both'

  const aLoras = normalizeLoras(a?.loras)
  const bLoras = normalizeLoras(b?.loras)
  const aLoraSet = new Set(aLoras)
  const bLoraSet = new Set(bLoras)
  const onlyA = aLoras.filter((name) => !bLoraSet.has(name)).sort()
  const onlyB = bLoras.filter((name) => !aLoraSet.has(name)).sort()
  const common = aLoras.filter((name) => bLoraSet.has(name)).sort()

  const fields: MetaFieldDiff[] = FIELD_SPECS.map((spec) => {
    if (spec.key === 'loras') {
      return {
        key: 'loras' as const,
        kind: 'loras' as const,
        label: spec.label,
        status: sameLoraSet(aLoras, bLoras) ? ('same' as const) : ('changed' as const),
        a: aLoras,
        b: bLoras,
        common,
        onlyA,
        onlyB,
      }
    }

    const key = spec.key as Exclude<MetaFieldKey, 'loras'>
    const aValue = normalizeMetaText(a?.[key] ?? null)
    const bValue = normalizeMetaText(b?.[key] ?? null)
    const status: MetaFieldStatus = aValue === bValue ? 'same' : 'changed'
    return {
      key,
      kind: 'text' as const,
      label: spec.label,
      status,
      a: aValue,
      b: bValue,
      tokens:
        spec.tokens && status === 'changed'
          ? diffTokens(aValue ?? '', bValue ?? '')
          : null,
    }
  })

  const sameFields = fields.filter((field) => field.status === 'same')
  const changedFields = fields.filter((field) => field.status === 'changed')

  const seedA = normalizeMetaText(a?.seed ?? null)
  const seedB = normalizeMetaText(b?.seed ?? null)
  const seedOnly =
    presence === 'both' &&
    seedA !== null &&
    seedA !== '' &&
    seedB !== null &&
    seedB !== '' &&
    seedA !== seedB &&
    fields.every((field) => field.key === 'seed' || field.status === 'same')

  return {
    presence,
    fields,
    sameFields,
    changedFields,
    sameCount: sameFields.length,
    changedCount: changedFields.length,
    seedOnly,
  }
}
