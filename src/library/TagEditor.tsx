/**
 * タグ付けダイアログ（#6）。
 *
 * - 既存タグの ON / OFF（チェックした瞬間に `set_work_tags` へ保存）
 * - 新しいタグの作成（名前 + `<input type="color">`）
 * - タグの削除（ライブラリ全体から消える。付与も `ON DELETE CASCADE`）
 *
 * 作品詳細では 1 作品、ライブラリの選択バーでは複数作品に同じタグを付ける。
 * 複数作品のときは「いずれか 1 件でも付いているタグ」をチェック済みで開く。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, Sparkles, Tag as TagIcon, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Tag, TagSuggestion } from '../api'
import { describeError } from '../lib/format'
import { notifyTagsChanged, tagData } from './tagData'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 対象の作品。詳細は 1 件、選択バーは複数件。 */
  workIds: number[]
  /** 保存・削除のあと（フィルタや一覧の読み直しに使う）。 */
  onChanged?: () => void
  disabled?: boolean
}

const DEFAULT_COLOR = '#22d3ee'

export function TagEditor({ open, onOpenChange, workIds, onChanged, disabled = false }: Props) {
  const [tags, setTags] = useState<Tag[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // #79: 生成情報の頻出語から出したタグ候補（1 作品のときだけ）
  const [suggestions, setSuggestions] = useState<TagSuggestion[]>([])
  const [suggestBusy, setSuggestBusy] = useState(false)
  const [name, setName] = useState('')
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ids = useMemo(() => [...workIds].sort((a, b) => a - b), [workIds])
  const idsKey = ids.join(',')
  const multiple = ids.length > 1
  const singleWorkId = ids.length === 1 ? ids[0] : null

  const load = useCallback(async () => {
    if (ids.length === 0) {
      setTags([])
      setSelected(new Set())
      setSuggestions([])
      return
    }
    setError(null)
    try {
      const all = await tagData().listTags()
      const perWork = await Promise.all(ids.map((workId) => tagData().getWorkTags(workId)))
      const union = new Set<number>()
      for (const workTags of perWork) {
        for (const tag of workTags) union.add(tag.id)
      }
      setTags(all)
      setSelected(union)
    } catch (cause) {
      setError(describeError(cause))
      setTags([])
      setSelected(new Set())
    }
    // ids は idsKey で同一視する
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey])

  // #79: 候補は 1 作品のときだけ取る（複数作品の一括タグ付けでは出さない）
  const loadSuggestions = useCallback(async () => {
    if (singleWorkId === null) {
      setSuggestions([])
      return
    }
    setSuggestBusy(true)
    try {
      setSuggestions(await tagData().tagSuggestions(singleWorkId))
    } catch {
      // 候補が読めなくてもタグ付けは使える
      setSuggestions([])
    } finally {
      setSuggestBusy(false)
    }
  }, [singleWorkId])

  useEffect(() => {
    if (!open) return
    setName('')
    setColor(DEFAULT_COLOR)
    setBusy(false)
    void load()
    void loadSuggestions()
  }, [open, load, loadSuggestions])

  const reload = useCallback(async () => {
    try {
      setTags(await tagData().listTags())
    } catch {
      // 件数の更新に失敗しても操作自体は成立している
    }
  }, [])

  const apply = useCallback(
    async (nextIds: number[]) => {
      if (ids.length === 0) return
      setBusy(true)
      setError(null)
      try {
        await Promise.all(ids.map((workId) => tagData().setWorkTags(workId, nextIds)))
        setSelected(new Set(nextIds))
        await reload()
        notifyTagsChanged()
        onChanged?.()
        // #79: 付けたタグは候補から外れるので取り直す
        await loadSuggestions()
      } catch (cause) {
        setError(describeError(cause))
      } finally {
        setBusy(false)
      }
    },
    [ids, loadSuggestions, onChanged, reload],
  )

  const toggle = (tagId: number) => {
    const next = new Set(selected)
    if (next.has(tagId)) next.delete(tagId)
    else next.add(tagId)
    void apply([...next])
  }

  // #79: 候補のチップを押すと、同名のタグがあれば使い、無ければ作って付与する
  const attachSuggestion = async (suggestion: TagSuggestion) => {
    if (singleWorkId === null || busy) return
    setBusy(true)
    setError(null)
    try {
      const existing = tags.find(
        (tag) => tag.name.trim().toLowerCase() === suggestion.name,
      )
      const tag = existing ?? (await tagData().createTag(suggestion.name, DEFAULT_COLOR))
      await apply([...new Set([...selected, tag.id])])
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    const trimmed = name.trim()
    if (trimmed === '') return
    setBusy(true)
    setError(null)
    try {
      const tag = await tagData().createTag(trimmed, color)
      setName('')
      await apply([...new Set([...selected, tag.id])])
      await reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (tagId: number) => {
    setBusy(true)
    setError(null)
    try {
      await tagData().deleteTag(tagId)
      const next = new Set(selected)
      next.delete(tagId)
      setSelected(next)
      await reload()
      notifyTagsChanged()
      onChanged?.()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-tag-editor>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <TagIcon className="size-4" aria-hidden="true" />
            タグ
            {multiple && (
              <Badge variant="secondary" className="tabular-nums">
                {ids.length} 件
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {multiple
              ? '選択した作品すべてに同じタグを設定します。チェックした瞬間に保存されます。'
              : 'チェックした瞬間に保存されます。タグはライブラリ全体で共有します。'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-64 flex-col gap-1 overflow-y-auto" role="list" aria-label="タグ一覧">
          {tags.length === 0 && (
            <p className="m-0 py-3 text-center text-xs text-muted-foreground">
              タグはまだありません。下の入力欄から作成できます。
            </p>
          )}
          {tags.map((tag) => {
            const checked = selected.has(tag.id)
            return (
              <div
                key={tag.id}
                role="listitem"
                data-tag-row={tag.id}
                data-tag-checked={checked ? 'true' : 'false'}
                className="flex items-center gap-2 rounded-lg px-1.5 py-1 hover:bg-muted/40"
              >
                <Checkbox
                  checked={checked}
                  disabled={disabled || busy}
                  aria-label={`${tag.name} を付ける`}
                  onClick={() => toggle(tag.id)}
                />
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  disabled={disabled || busy}
                  onClick={() => toggle(tag.id)}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate text-xs">{tag.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {tag.works}
                  </span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${tag.name} を削除`}
                  title="タグを削除（全作品から外れます）"
                  disabled={disabled || busy}
                  onClick={() => void remove(tag.id)}
                >
                  <Trash2 />
                </Button>
              </div>
            )
          })}
        </div>

        {singleWorkId !== null && (suggestBusy || suggestions.length > 0) && (
          <div className="border-t border-border pt-2" data-tag-suggestions aria-busy={suggestBusy}>
            <div className="mb-1 flex items-center gap-1.5">
              <Sparkles className="size-3 text-muted-foreground" aria-hidden="true" />
              <span className="text-xs text-muted-foreground">候補</span>
              <span className="text-xs text-muted-foreground/70">
                生成情報の頻出語（押すと付与）
              </span>
              {suggestBusy && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
            </div>
            <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion.name}
                  type="button"
                  data-tag-suggestion={suggestion.name}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs transition-colors hover:border-primary/60 hover:bg-muted/50 disabled:opacity-50"
                  aria-label={`${suggestion.name} をタグに追加`}
                  title={`「${suggestion.name}」をタグに追加（${suggestion.count} ファイル）`}
                  disabled={disabled || busy}
                  onClick={() => void attachSuggestion(suggestion)}
                >
                  <Plus className="size-3" aria-hidden="true" />
                  <span className="truncate">{suggestion.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {suggestion.count}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">新規</span>
          <Input
            value={name}
            data-tag-name
            placeholder="タグ名（40 文字まで）"
            aria-label="新しいタグ名"
            className="h-7 min-w-[140px] flex-1 text-xs"
            maxLength={40}
            disabled={disabled || busy || ids.length === 0}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void create()
              }
            }}
          />
          <input
            type="color"
            value={color}
            data-tag-color
            aria-label="タグの色"
            className="size-7 cursor-pointer rounded-md border border-input bg-transparent p-0.5"
            disabled={disabled || busy || ids.length === 0}
            onChange={(event) => setColor(event.target.value)}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-tag-add
            disabled={disabled || busy || ids.length === 0 || name.trim() === ''}
            onClick={() => void create()}
          >
            {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Plus aria-hidden="true" />}
            追加
          </Button>
        </div>

        {error && (
          <p className="m-0 text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          {busy && (
            <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              保存中…
            </span>
          )}
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            閉じる
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

