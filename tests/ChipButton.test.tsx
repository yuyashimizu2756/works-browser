import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChipButton } from '../src/library/ChipButton'

describe('ChipButton', () => {
  it('active のとき aria-pressed=true', () => {
    render(<ChipButton active>動画</ChipButton>)
    expect(screen.getByRole('button', { name: '動画' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('クリックで onClick を呼ぶ', () => {
    const onClick = vi.fn()
    render(<ChipButton onClick={onClick}>画像</ChipButton>)
    fireEvent.click(screen.getByRole('button', { name: '画像' }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it('active でなければ aria-pressed を付けない', () => {
    render(<ChipButton>すべて</ChipButton>)
    expect(screen.getByRole('button', { name: 'すべて' })).not.toHaveAttribute('aria-pressed')
  })
})
