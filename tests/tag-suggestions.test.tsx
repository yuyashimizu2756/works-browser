/**
 * #79: 生成情報の頻出語から出すタグ候補（TagEditor の「候補」チップ）。
 *
 * Rust 側の集計（`tag_suggestions`）は `cargo test` で確認する。
 * ここでは候補の表示・クリックで付与・生成情報が無いときに出さないこと・
 * 複数作品では出さないことを確認する。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tag, TagSuggestion } from '../src/api'
import { TagEditor } from '../src/library/TagEditor'
import { emptyMark, setTagData, type TagData } from '../src/library/tagData'

function tag(id: number, name: string): Tag {
  return { id, name, color: '#22d3ee', created_at: 0, works: 0 }
}

function createData(options: { suggestions: TagSuggestion[]; tags?: Tag[] }) {
  const tags = [...(options.tags ?? [])]
  let callCount = 0
  const setWorkTags = vi.fn(async (workId: number, tagIds: number[]) => {
    void workId
    return tags.filter((item) => tagIds.includes(item.id))
  })
  const createTag = vi.fn(async (name: string, color: string) => {
    const created = tag(tags.length + 100, name)
    created.color = color
    tags.push(created)
    return created
  })
  const tagSuggestions = vi.fn(async () => {
    callCount += 1
    // 2 回目以降（付与後）は、付けた語が外れた結果を返す
    return callCount === 1 ? options.suggestions : []
  })

  const data: TagData = {
    listTags: async () => tags.map((item) => ({ ...item })),
    createTag,
    deleteTag: async () => {},
    getWorkTags: async () => [],
    setWorkTags,
    tagSuggestions,
    getWorkMark: async (workId) => emptyMark(workId),
    setWorkMark: async (workId) => emptyMark(workId),
    recordOpen: async (workId) => emptyMark(workId),
  }
  return { data, tags, setWorkTags, createTag, tagSuggestions }
}

beforeEach(() => {
  setTagData(null)
})

describe('タグ候補（#79）', () => {
  it('候補を頻度付きで表示し、クリックでタグを付与する', async () => {
    const fake = createData({
      suggestions: [
        { name: 'dress', count: 4 },
        { name: 'sunset', count: 2 },
      ],
    })
    setTagData(fake.data)

    render(<TagEditor open onOpenChange={() => {}} workIds={[7]} />)

    // 生成情報の頻出語が「候補」として出る
    expect(await screen.findByText('候補')).toBeInTheDocument()
    const chip = await screen.findByRole('button', { name: 'dress をタグに追加' })
    expect(chip.textContent).toContain('dress')
    expect(chip.textContent).toContain('4')

    fireEvent.click(chip)

    // 既存タグに無ければ作って、既存の付与 API で付ける
    await waitFor(() => expect(fake.setWorkTags).toHaveBeenCalledTimes(1))
    expect(fake.createTag).toHaveBeenCalledWith('dress', '#22d3ee')
    expect(fake.setWorkTags.mock.calls[0][1]).toEqual([100])

    // 付与後は候補を取り直し、チップは消える
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'dress をタグに追加' })).toBeNull(),
    )
    expect(fake.tagSuggestions).toHaveBeenCalledTimes(2)
  })

  it('同じ名前のタグが既にあれば作らずにそのタグを付ける', async () => {
    const fake = createData({
      suggestions: [{ name: 'dress', count: 3 }],
      tags: [tag(5, 'Dress')],
    })
    setTagData(fake.data)

    render(<TagEditor open onOpenChange={() => {}} workIds={[7]} />)
    fireEvent.click(await screen.findByRole('button', { name: 'dress をタグに追加' }))

    await waitFor(() => expect(fake.setWorkTags).toHaveBeenCalledTimes(1))
    expect(fake.createTag).not.toHaveBeenCalled()
    expect(fake.setWorkTags.mock.calls[0][1]).toEqual([5])
  })

  it('候補が空なら「候補」の欄を出さない（生成情報なし）', async () => {
    const fake = createData({ suggestions: [] })
    setTagData(fake.data)

    render(<TagEditor open onOpenChange={() => {}} workIds={[7]} />)

    await waitFor(() => expect(fake.tagSuggestions).toHaveBeenCalledTimes(1))
    expect(document.querySelector('[data-tag-suggestions]')).toBeNull()
    expect(screen.queryByText('候補')).toBeNull()
  })

  it('複数作品の一括タグ付けでは候補を取らない', async () => {
    const fake = createData({ suggestions: [{ name: 'dress', count: 3 }] })
    setTagData(fake.data)

    render(<TagEditor open onOpenChange={() => {}} workIds={[1, 2]} />)

    await waitFor(() => expect(fake.setWorkTags).not.toHaveBeenCalled())
    expect(fake.tagSuggestions).not.toHaveBeenCalled()
    expect(document.querySelector('[data-tag-suggestions]')).toBeNull()
  })
})
