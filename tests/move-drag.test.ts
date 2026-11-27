import { describe, expect, it } from 'vitest'
import { readDraggedWorkId, WORK_DRAG_TYPE } from '../src/library/moveDrag'

function transfer(values: Record<string, string>): DataTransfer {
  return {
    getData: (type: string) => values[type] ?? '',
  } as unknown as DataTransfer
}

describe('moveDrag', () => {
  it('作品 id を dataTransfer から読む', () => {
    expect(readDraggedWorkId(transfer({ [WORK_DRAG_TYPE]: '42' }))).toBe(42)
  })

  it('別の種類・空・不正な値は受け付けない', () => {
    expect(readDraggedWorkId(transfer({ 'text/plain': '42' }))).toBeNull()
    expect(readDraggedWorkId(transfer({ [WORK_DRAG_TYPE]: '' }))).toBeNull()
    expect(readDraggedWorkId(transfer({ [WORK_DRAG_TYPE]: 'abc' }))).toBeNull()
    expect(readDraggedWorkId(transfer({ [WORK_DRAG_TYPE]: '0' }))).toBeNull()
    expect(readDraggedWorkId(transfer({ [WORK_DRAG_TYPE]: '-1' }))).toBeNull()
    expect(readDraggedWorkId(transfer({ [WORK_DRAG_TYPE]: '1.5' }))).toBeNull()
  })
})
