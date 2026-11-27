import { describe, expect, it } from 'vitest'
import type { GenerationMeta } from '../src/api'
import {
  diffGenerationMeta,
  diffTokens,
  formatMetaValue,
  normalizeLoras,
  tokenizePrompt,
} from '../src/lib/promptDiff'

/** すべての項目が揃った生成情報。差分を 1 項目だけにするための土台。 */
function meta(overrides: Partial<GenerationMeta> = {}): GenerationMeta {
  return {
    prompt: 'cat, standing, red dress',
    negative_prompt: 'worst quality, low quality',
    model: 'sdxl_base',
    loras: ['style_a'],
    steps: '30',
    sampler: 'DPM++ 2M',
    cfg: '7',
    seed: '1234',
    size: '832x1216',
    raw: 'raw',
    source: 'parameters',
    ...overrides,
  }
}

function joinTokens(tokens: Array<{ text: string }>): string {
  return tokens.map((token) => token.text).join('')
}

describe('tokenizePrompt', () => {
  it('日本語・英語・記号混在でも連結すると元の文字列に戻る', () => {
    const text = '猫が "寝て" いる, 1girl, smile😊 (best quality:1.2)'
    const tokens = tokenizePrompt(text)
    expect(tokens.join('')).toBe(text)
    expect(tokens.length).toBeGreaterThan(1)
  })

  it('英語は単語、日本語は 1 文字、記号は 1 文字に分ける', () => {
    expect(tokenizePrompt('1girl, 猫')).toEqual(['1girl', ',', ' ', '猫'])
  })

  it('空文字は 0 トークン', () => {
    expect(tokenizePrompt('')).toEqual([])
  })
})

describe('diffTokens', () => {
  it('完全一致はすべて same', () => {
    const diff = diffTokens('cat, smile', 'cat, smile')
    expect(diff.changed).toBe(false)
    expect(diff.a.every((token) => token.kind === 'same')).toBe(true)
    expect(diff.b.every((token) => token.kind === 'same')).toBe(true)
  })

  it('追加と削除を分け、両側とも元の文字列を復元できる', () => {
    const a = 'cat, standing, red dress'
    const b = 'cat, standing, blue dress'
    const diff = diffTokens(a, b)

    expect(diff.changed).toBe(true)
    expect(joinTokens(diff.a)).toBe(a)
    expect(joinTokens(diff.b)).toBe(b)
    expect(diff.a.some((token) => token.text === 'red' && token.kind === 'removed')).toBe(true)
    expect(diff.b.some((token) => token.text === 'blue' && token.kind === 'added')).toBe(true)
    // 共通部分は same のまま
    expect(diff.a.filter((token) => token.text === 'dress').every((token) => token.kind === 'same')).toBe(
      true,
    )
  })

  it('語順が違っても全削除 + 全追加にせず、共通語を same に残す', () => {
    const a = 'red dress, cat, standing'
    const b = 'cat, standing, red dress'
    const diff = diffTokens(a, b)

    expect(diff.changed).toBe(true)
    expect(joinTokens(diff.a)).toBe(a)
    expect(joinTokens(diff.b)).toBe(b)
    const same = diff.a.filter((token) => token.kind === 'same').map((token) => token.text)
    expect(same.join('')).toContain('cat')
    expect(same.join('')).toContain('standing')
    // 語順が変わった部分は削除 + 追加として出る
    expect(diff.a.some((token) => token.kind === 'removed')).toBe(true)
    expect(diff.b.some((token) => token.kind === 'added')).toBe(true)
  })

  it('日本語でも 1 文字違いとして差分を出す', () => {
    const a = '猫が寝ている'
    const b = '猫が走っている'
    const diff = diffTokens(a, b)

    expect(joinTokens(diff.a)).toBe(a)
    expect(joinTokens(diff.b)).toBe(b)
    expect(diff.a.some((token) => token.text === '寝' && token.kind === 'removed')).toBe(true)
    expect(diff.b.some((token) => token.text === '走' && token.kind === 'added')).toBe(true)
  })

  it('空白だけの違いも差分として扱う', () => {
    const diff = diffTokens('a  b', 'a b')
    expect(diff.changed).toBe(true)
    expect(joinTokens(diff.a)).toBe('a  b')
  })
})

describe('diffGenerationMeta', () => {
  it('完全一致は差分 0・一致 9 項目で seed 違いではない', () => {
    const diff = diffGenerationMeta(meta(), meta())

    expect(diff.presence).toBe('both')
    expect(diff.changedCount).toBe(0)
    expect(diff.sameCount).toBe(9)
    expect(diff.changedFields).toEqual([])
    expect(diff.seedOnly).toBe(false)
  })

  it('seed だけが違うと seed 違いバッジの条件になる', () => {
    const diff = diffGenerationMeta(meta(), meta({ seed: '9999' }))

    expect(diff.changedFields.map((field) => field.key)).toEqual(['seed'])
    expect(diff.seedOnly).toBe(true)
  })

  it('seed 以外も違えば seed 違いではない', () => {
    const diff = diffGenerationMeta(meta(), meta({ seed: '9999', steps: '40' }))

    expect(diff.changedFields.map((field) => field.key).sort()).toEqual(['seed', 'steps'])
    expect(diff.seedOnly).toBe(false)
  })

  it('seed が片方に無ければ seed 違いではない', () => {
    const diff = diffGenerationMeta(meta(), meta({ seed: null }))
    expect(diff.seedOnly).toBe(false)
    expect(diff.changedFields.map((field) => field.key)).toEqual(['seed'])
  })

  it('prompt の語順違いは 1 項目の差分になり、トークン差分を持つ', () => {
    const diff = diffGenerationMeta(
      meta(),
      meta({ prompt: 'red dress, cat, standing' }),
    )
    const prompt = diff.changedFields.find((field) => field.key === 'prompt')

    expect(diff.changedFields.map((field) => field.key)).toEqual(['prompt'])
    expect(prompt?.kind).toBe('text')
    if (prompt?.kind !== 'text') throw new Error('prompt は text のはず')
    expect(prompt.tokens).not.toBeNull()
    expect(prompt.tokens?.changed).toBe(true)
    expect(prompt.tokens?.a.map((token) => token.text).join('')).toBe('cat, standing, red dress')
    expect(prompt.tokens?.b.map((token) => token.text).join('')).toBe('red dress, cat, standing')
  })

  it('片方の生成情報が null なら presence で示し、空欄とは区別する', () => {
    const diff = diffGenerationMeta(null, meta())

    expect(diff.presence).toBe('onlyB')
    expect(diff.seedOnly).toBe(false)
    // 相手側に値がある項目はすべて「差分」として並ぶ（空欄と同じ扱いにしない）
    expect(diff.changedFields.length).toBeGreaterThan(0)
    const prompt = diff.changedFields.find((field) => field.key === 'prompt')
    expect(prompt?.kind === 'text' ? prompt.a : 'x').toBeNull()

    const reverse = diffGenerationMeta(meta(), null)
    expect(reverse.presence).toBe('onlyA')
  })

  it('両方 null なら presence は none', () => {
    const diff = diffGenerationMeta(null, null)
    expect(diff.presence).toBe('none')
    expect(diff.changedCount).toBe(0)
    expect(diff.seedOnly).toBe(false)
  })

  it('LoRA の追加と削除をセット差で返す', () => {
    const diff = diffGenerationMeta(
      meta({ loras: ['style_a', 'char_x'] }),
      meta({ loras: ['style_a', 'char_y'] }),
    )
    const loras = diff.changedFields.find((field) => field.key === 'loras')

    expect(loras?.kind).toBe('loras')
    if (loras?.kind !== 'loras') throw new Error('loras は loras のはず')
    expect(loras.common).toEqual(['style_a'])
    expect(loras.onlyA).toEqual(['char_x'])
    expect(loras.onlyB).toEqual(['char_y'])
    expect(loras.status).toBe('changed')
  })

  it('LoRA は順序と重複を無視して一致とみなす', () => {
    const diff = diffGenerationMeta(
      meta({ loras: ['a', 'b'] }),
      meta({ loras: ['b', 'a', 'a'] }),
    )
    expect(diff.changedFields).toEqual([])
  })

  it('空文字と null は別の値として差分にする', () => {
    const diff = diffGenerationMeta(meta({ prompt: null }), meta({ prompt: '' }))
    const prompt = diff.changedFields.find((field) => field.key === 'prompt')

    expect(prompt?.status).toBe('changed')
    expect(prompt?.kind === 'text' ? prompt.a : 'x').toBeNull()
    expect(prompt?.kind === 'text' ? prompt.b : 'x').toBe('')
  })

  it('両方空文字なら一致（null とは区別したまま）', () => {
    const diff = diffGenerationMeta(
      meta({ prompt: '', negative_prompt: null }),
      meta({ prompt: '', negative_prompt: null }),
    )
    expect(diff.changedCount).toBe(0)
    expect(formatMetaValue(null)).toBe('（なし）')
    expect(formatMetaValue('')).toBe('（空）')
  })

  it('前後の空白だけの違いは一致とみなす', () => {
    const diff = diffGenerationMeta(
      meta({ prompt: '  cat, smile  ' }),
      meta({ prompt: 'cat, smile' }),
    )
    expect(diff.changedCount).toBe(0)
  })

  it('各項目のラベルと並び順を固定する', () => {
    const diff = diffGenerationMeta(meta(), meta({ model: 'other' }))
    expect(diff.fields.map((field) => field.label)).toEqual([
      'プロンプト',
      'ネガティブ',
      'モデル',
      'LoRA',
      'Steps',
      'サンプラー',
      'CFG',
      'Seed',
      'サイズ',
    ])
  })
})

describe('normalizeLoras', () => {
  it('空白除去・空要素除外・重複除去を行う', () => {
    expect(normalizeLoras([' a ', '', 'a', 'b'])).toEqual(['a', 'b'])
    expect(normalizeLoras(null)).toEqual([])
  })
})
