/**
 * ライブラリのタグ絞り込みチップ（#6）。
 *
 * タグを 1 クリックで ON / OFF する。付与（`TagEditor`）や削除のあとは
 * `notifyTagsChanged()` 経由で件数と一覧を読み直す。
 */
import { useCallback, useEffect, useState } from 'react'
import { Tag as TagIcon } from 'lucide-react'
import type { Tag } from '../api'
import { describeError } from '../lib/format'
import { ChipButton } from './ChipButton'
import { subscribeTags, tagData } from './tagData'

type Props = {
  tagId: number | null
  onChange: (tagId: number | null) => void
  /** 一覧の再読み込み（走査後など）。 */
  refreshToken?: number
  disabled?: boolean
  /** #96: フィルタのポップオーバー内では見出しを親（FilterSection）に任せる。 */
  showLabel?: boolean
  /** #96: 適用中チップに名前を出すため、読み込んだ一覧を親へ渡す。 */
  onTagsChange?: (tags: Tag[]) => void
}

export function TagFilterChips({
  tagId,
  onChange,
  refreshToken = 0,
  disabled = false,
  showLabel = true,
  onTagsChange,
}: Props) {
  const [tags, setTags] = useState<Tag[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void tagData()
      .listTags()
      .then((next) => {
        setTags(next)
        onTagsChange?.(next)
        setError(null)
      })
      .catch((cause: unknown) => setError(describeError(cause)))
  }, [onTagsChange])

  useEffect(() => {
    load()
    return subscribeTags(load)
  }, [load, refreshToken])

  // タグが消えたら絞り込みも解除する
  useEffect(() => {
    if (tagId !== null && tags.length > 0 && !tags.some((tag) => tag.id === tagId)) {
      onChange(null)
    }
  }, [onChange, tagId, tags])

  if (error !== null) return null
  if (tags.length === 0) {
    return showLabel ? null : (
      <p className="m-0 text-xs text-[var(--text-secondary)]">タグはまだありません。</p>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="タグで絞り込み">
      {showLabel && (
        <span className="mr-px flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
          <TagIcon className="size-3" aria-hidden="true" />
          タグ
        </span>
      )}
      {tags.map((tag) => (
        <ChipButton
          key={tag.id}
          active={tag.id === tagId}
          disabled={disabled}
          data-tag-chip={tag.id}
          title={`${tag.name}（${tag.works} 作品）`}
          onClick={() => onChange(tag.id === tagId ? null : tag.id)}
        >
          <span
            className="mr-1 inline-block size-1.5 rounded-full"
            style={{ backgroundColor: tag.color }}
            aria-hidden="true"
          />
          {tag.name}
        </ChipButton>
      ))}
    </div>
  )
}
