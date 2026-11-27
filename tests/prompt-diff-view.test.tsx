import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GenerationMeta } from '../src/api'
import { CompareView } from '../src/library/CompareView'
import type { CompareItem } from '../src/library/compareItems'

const { getGenerationMeta } = vi.hoisted(() => ({ getGenerationMeta: vi.fn() }))

vi.mock('../src/api', () => ({
  api: { getGenerationMeta },
}))

function meta(overrides: Partial<GenerationMeta> = {}): GenerationMeta {
  return {
    prompt: 'cat, standing, red dress',
    negative_prompt: 'worst quality',
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

function item(index: number): CompareItem {
  return {
    key: `file-${index}`,
    title: `サンプル ${index}`,
    subtitle: '作品 1',
    kind: 'image',
    fileId: index,
    thumbPath:
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>',
      ),
  }
}

function openDiffTab() {
  fireEvent.click(screen.getByRole('tab', { name: '差分' }))
}

beforeEach(() => {
  getGenerationMeta.mockReset()
})

describe('比較ビューの差分タブ', () => {
  it('3 枚以上では差分タブを無効にし、2 枚で比較するよう案内する', () => {
    render(<CompareView items={[item(1), item(2), item(3)]} bench onClose={() => {}} />)

    expect(screen.getByRole('tab', { name: '差分' })).toBeDisabled()
    expect(screen.getByText('2枚で比較してください')).toBeInTheDocument()
    expect(document.querySelector('[data-compare-tab]')?.getAttribute('data-compare-tab')).toBe(
      'side',
    )
  })

  it('2 枚なら差分タブが開き、seed 違いと差分項目を表示する', async () => {
    getGenerationMeta.mockImplementation(async (id: number) =>
      id === 1 ? meta() : meta({ seed: '9999' }),
    )
    render(<CompareView items={[item(1), item(2)]} bench={false} onClose={() => {}} />)

    openDiffTab()

    expect(await screen.findByText('seed 違い')).toBeInTheDocument()
    const panel = document.querySelector('[data-meta-diff]')
    expect(panel?.getAttribute('data-meta-diff-status')).toBe('ready')
    expect(panel?.getAttribute('data-meta-diff-presence')).toBe('both')
    expect(document.querySelector('[data-meta-diff-seed-badge]')).toBeTruthy()

    // 一致した項目は 1 行にまとまる（Seed 以外は一致）
    expect(document.querySelector('[data-diff-same]')?.textContent).toContain('一致')
    expect(document.querySelector('[data-diff-field="prompt"]')).toBeNull()
    expect(document.querySelector('[data-diff-field="seed"]')).toBeTruthy()
    // 画像グリッドは隠れる（DOM には残る）
    expect((document.querySelector('[data-compare-stage]') as HTMLElement).style.display).toBe(
      'none',
    )
  })

  it('prompt の差分は単語単位の追加 / 削除として描く', async () => {
    getGenerationMeta.mockImplementation(async (id: number) =>
      id === 1 ? meta() : meta({ prompt: 'cat, standing, blue dress' }),
    )
    render(<CompareView items={[item(1), item(2)]} bench={false} onClose={() => {}} />)

    openDiffTab()

    const field = await screen.findByText('プロンプト')
    expect(field).toBeInTheDocument()
    expect(document.querySelector('[data-meta-diff-seed-badge]')).toBeNull()
    expect(document.querySelector('[data-diff-token="removed"]')?.textContent).toBe('red')
    expect(document.querySelector('[data-diff-token="added"]')?.textContent).toBe('blue')
    expect(document.querySelector('[data-diff-same]')?.textContent).toContain('Seed')
  })

  it('片方に生成情報が無いことを明示する（空欄とは別）', async () => {
    getGenerationMeta.mockImplementation(async (id: number) => (id === 1 ? meta() : null))
    render(<CompareView items={[item(1), item(2)]} bench={false} onClose={() => {}} />)

    openDiffTab()

    const missing = await screen.findByText(/生成情報なし（項目が空なのとは別です）/)
    expect(missing).toBeInTheDocument()
    expect(document.querySelector('[data-diff-missing="b"]')).toBeTruthy()
    expect(document.querySelector('[data-meta-diff-presence]')?.getAttribute('data-meta-diff-presence')).toBe(
      'onlyA',
    )
  })

  it('ベンチモードでは生成情報を読みに行かない', () => {
    render(<CompareView items={[item(1), item(2)]} bench onClose={() => {}} />)

    openDiffTab()

    expect(document.querySelector('[data-meta-diff-status="bench"]')).toBeTruthy()
    expect(getGenerationMeta).not.toHaveBeenCalled()
  })

  it('差分タブでも Esc で閉じる', () => {
    getGenerationMeta.mockResolvedValue(meta())
    const onClose = vi.fn()
    render(<CompareView items={[item(1), item(2)]} bench={false} onClose={onClose} />)

    openDiffTab()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
