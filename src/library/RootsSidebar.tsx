import { useState } from 'react'
import {
  Bookmark,
  FolderPlus,
  LayoutList,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Eye,
  EyeOff,
  Trash2,
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import type { RootInfo, SmartFolder } from '../api'
import { formatBytes, formatCount } from '../lib/format'
import { EmptyState } from './EmptyState'
import { rootAccentFor } from './accents'
import { readDraggedWorkId, WORK_DRAG_TYPE } from './moveDrag'

type Props = {
  roots: RootInfo[]
  rootAccents: Map<number, string>
  selectedRootId: number | null
  onSelect: (rootId: number | null) => void
  onAddRoot: () => void
  /** #100: スマートフォルダが無いときの「条件を絞り込む」（検索欄へフォーカス）。 */
  onFocusFilters?: () => void
  /** 選択中のルートを再スキャン。 */
  onRescan?: (rootId: number) => void
  /** 有効/無効の切り替え。 */
  onToggleEnabled?: (rootId: number, enabled: boolean) => void
  /** ルート削除（確認は呼び出し側）。 */
  onDelete?: (rootId: number) => void
  /** #57: ドラッグ中の作品の移動元ルート（同じルートへは落とせない）。 */
  draggingRootId?: number | null
  /** #57: 移動の実行中はドロップを受け付けない。 */
  moveBusy?: boolean
  /** #57: 作品カードがルート行へドロップされた。 */
  onDropWork?: (workId: number, targetRootId: number) => void
  /** #63: ルート別の新着件数（`added - removed > 0` のものだけ）。 */
  pendingCounts?: Map<number, number>
  /** #69: 保存した絞り込み条件（スマートフォルダ）。 */
  smartFolders?: SmartFolder[]
  /** #69: いまの条件と一致しているスマートフォルダ。 */
  activeSmartFolderId?: number | null
  /** #69: 適用中スマートフォルダの件数（`find_works` の `total`）。 */
  activeSmartFolderCount?: number | null
  /** #69: 現在の条件を保存する（名前はサイドバーで入力）。 */
  onSaveSmartFolder?: (name: string) => void
  /** #69: 条件を適用する。 */
  onSelectSmartFolder?: (folder: SmartFolder) => void
  /** #69: 名前を変える。 */
  onRenameSmartFolder?: (id: number, name: string) => void
  /** #69: 削除する（確認は呼び出し側）。 */
  onDeleteSmartFolder?: (folder: SmartFolder) => void
}

/**
 * ルート（監視フォルダ）の一覧サイドバー（#55）。
 *
 * - クリックで本画面の一覧をそのルートだけに絞り込む
 * - 「すべて」で全件に戻す
 * - 行の「…」から再スキャン / 有効・無効 / 削除
 */
export function RootsSidebar({
  roots,
  rootAccents,
  selectedRootId,
  onSelect,
  onAddRoot,
  onFocusFilters,
  onRescan,
  onToggleEnabled,
  onDelete,
  draggingRootId = null,
  moveBusy = false,
  onDropWork,
  pendingCounts,
  smartFolders = [],
  activeSmartFolderId = null,
  activeSmartFolderCount = null,
  onSaveSmartFolder,
  onSelectSmartFolder,
  onRenameSmartFolder,
  onDeleteSmartFolder,
}: Props) {
  const totalWorks = roots.reduce((sum, info) => sum + info.works, 0)
  // #63: 「すべて」には監視で増えた合計を出す
  const totalPending = pendingCounts
    ? [...pendingCounts.values()].reduce((sum, count) => sum + count, 0)
    : 0
  const [menuFor, setMenuFor] = useState<number | null>(null)
  const [dropRootId, setDropRootId] = useState<number | null>(null)
  // #69: スマートフォルダの「…」メニューと、名前の入力欄
  const [smartMenuFor, setSmartMenuFor] = useState<number | null>(null)
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null)

  return (
    <aside
      className="flex w-[240px] flex-none flex-col gap-0.5 overflow-y-auto border-r border-[var(--line)] bg-[var(--surface)] px-3 py-4"
      aria-label="ルート一覧"
    >
      <p className="mb-1 px-2 text-xs font-semibold tracking-[0.08em] text-[var(--text-secondary)] uppercase">
        ライブラリ
      </p>

      <button
        type="button"
        aria-current={selectedRootId === null ? 'true' : undefined}
        onClick={() => onSelect(null)}
        className={cn(
          'flex h-8 items-center gap-2 rounded-[var(--radius-control)] px-2 text-left text-[13px] transition-colors duration-[var(--duration-fast)]',
          selectedRootId === null
            ? 'bg-[color-mix(in_srgb,var(--brand)_14%,transparent)] font-medium text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg)] hover:text-[var(--text-primary)]',
        )}
      >
        <LayoutList className="size-3.5 flex-none" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">すべて</span>
        {totalPending > 0 && <NewBadge count={totalPending} />}
        <span className="flex-none text-xs text-[var(--text-secondary)] tabular-nums">
          {formatCount(totalWorks)}
        </span>
      </button>

      <p className="mt-4 mb-1 px-2 text-xs font-semibold tracking-[0.08em] text-[var(--text-secondary)] uppercase">
        ルート
      </p>

      {roots.length === 0 && (
        <EmptyState
          variant="sidebar"
          icon={FolderPlus}
          title="ルートを追加して始める"
          description="フォルダを追加して始めます。"
          action={{ label: 'ルートを追加', onClick: onAddRoot }}
        />
      )}

      {roots.map(({ root, works, total_bytes, last_scan_at, exists }) => {
        const selected = selectedRootId === root.id
        const accent = rootAccentFor(rootAccents, root.id)
        const menuOpen = menuFor === root.id
        // #63: 監視で増えた件数（選択して開くと消える）
        const pending = pendingCounts?.get(root.id) ?? 0
        // #57: ドラッグ中の作品をこのルートへ落とせるか（同一ルートは何もしない）
        const droppable =
          draggingRootId !== null && draggingRootId !== root.id && !moveBusy && root.enabled
        const dropTarget = droppable && dropRootId === root.id
        return (
          <div
            key={root.id}
            className="relative"
            data-root-drop={root.id}
            data-drop-target={dropTarget ? 'true' : undefined}
            onDragEnter={(event) => {
              if (!droppable || !event.dataTransfer.types.includes(WORK_DRAG_TYPE)) return
              event.preventDefault()
              setDropRootId(root.id)
            }}
            onDragOver={(event) => {
              if (!droppable || !event.dataTransfer.types.includes(WORK_DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropRootId((current) => (current === root.id ? current : root.id))
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
              setDropRootId((current) => (current === root.id ? null : current))
            }}
            onDrop={(event) => {
              event.preventDefault()
              setDropRootId(null)
              if (!droppable) return
              const workId = readDraggedWorkId(event.dataTransfer)
              if (workId !== null) onDropWork?.(workId, root.id)
            }}
          >
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              title={`${root.path}\n${formatCount(works)} 作品 / ${formatBytes(total_bytes)}${
                last_scan_at ? `\n最終スキャン ${new Date(last_scan_at).toLocaleString()}` : ''
              }${pending > 0 ? `\n監視で +${formatCount(pending)} 件` : ''}`}
              onClick={() => {
                setMenuFor(null)
                onSelect(root.id)
              }}
              className={cn(
                'group/root flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 pr-6 text-left text-[13px] transition-colors duration-[var(--duration-fast)]',
                selected
                  ? 'bg-[color-mix(in_srgb,var(--root-accent)_14%,transparent)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg)] hover:text-[var(--text-primary)]',
                root.enabled ? '' : 'opacity-50',
                droppable && 'outline outline-1 outline-dashed outline-[var(--line-strong)]',
                dropTarget &&
                  'bg-[color-mix(in_srgb,var(--root-accent)_20%,transparent)] font-medium text-[var(--text-primary)] outline-2 outline-[var(--root-accent)]',
              )}
              style={{ '--root-accent': accent } as React.CSSProperties}
            >
              <span
                className="size-2 flex-none rounded-full bg-[var(--text-tertiary)]"
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{root.label}</span>
              {!exists && (
                <span
                  className="flex-none rounded bg-destructive/20 px-1 text-xs font-semibold text-destructive"
                  title="パスが見つかりません（ドライブ未接続・移動された可能性）"
                >
                  不在
                </span>
              )}
              {exists && works === 0 && (
                <span
                  className="flex-none rounded bg-[var(--bg)] px-1 text-xs font-medium text-[var(--text-secondary)]"
                  title="まだスキャンしていません"
                >
                  未
                </span>
              )}
              {pending > 0 && <NewBadge count={pending} />}
              <span className="flex-none text-xs text-[var(--text-secondary)] tabular-nums">
                {formatCount(works)}
              </span>
            </button>

            <button
              type="button"
              aria-label={`${root.label} の操作`}
              aria-expanded={menuOpen}
              title="ルートの操作"
              onClick={(event) => {
                event.stopPropagation()
                setMenuFor(menuOpen ? null : root.id)
              }}
              className={cn(
                'absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-black/30 focus-visible:opacity-100 group-hover/root:opacity-100',
                menuOpen && 'opacity-100',
              )}
            >
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            </button>

            {menuOpen && (
              <div
                className="absolute top-full right-1 z-20 mt-0.5 flex w-[168px] flex-col rounded-md border border-border bg-popover p-1 shadow-xl"
                role="menu"
              >
                <MenuButton
                  icon={<RefreshCw className="size-3.5" />}
                  onClick={() => {
                    setMenuFor(null)
                    onRescan?.(root.id)
                  }}
                >
                  再スキャン
                </MenuButton>
                <MenuButton
                  icon={root.enabled ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  onClick={() => {
                    setMenuFor(null)
                    onToggleEnabled?.(root.id, !root.enabled)
                  }}
                >
                  {root.enabled ? '無効にする' : '有効にする'}
                </MenuButton>
                <MenuButton
                  icon={<Trash2 className="size-3.5" />}
                  danger
                  onClick={() => {
                    setMenuFor(null)
                    onDelete?.(root.id)
                  }}
                >
                  削除
                </MenuButton>
              </div>
            )}
          </div>
        )
      })}

      {/* #69: 保存した絞り込み条件（スマートフォルダ）。クリックで適用。 */}
      {/* #108: ルートが無いときはオンボーディングだけにし、この節は出さない。 */}
      {(roots.length > 0 || smartFolders.length > 0) && (
        <>
          <p className="mt-4 mb-1 flex items-center justify-between px-2 text-xs font-semibold tracking-[0.08em] text-[var(--text-secondary)] uppercase">
            <span>スマートフォルダ</span>
            <button
              type="button"
              aria-label="現在の条件をスマートフォルダとして保存"
              title="現在の条件を保存"
              onClick={() => {
                setSmartMenuFor(null)
                setNewFolderName((current) => (current === null ? '' : null))
              }}
              className="rounded p-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg)] hover:text-[var(--text-primary)]"
            >
              <Plus className="size-3" aria-hidden="true" />
            </button>
          </p>

          {newFolderName !== null && (
            <form
              className="px-1 pb-1"
              onSubmit={(event) => {
                event.preventDefault()
                const name = newFolderName.trim()
                if (name === '') return
                onSaveSmartFolder?.(name)
                setNewFolderName(null)
              }}
            >
              <input
                autoFocus
                value={newFolderName}
                maxLength={40}
                placeholder="名前を入力（Enter で保存）"
                aria-label="スマートフォルダ名"
                spellCheck={false}
                onChange={(event) => setNewFolderName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setNewFolderName(null)
                }}
                className="h-8 w-full rounded-[var(--radius-control)] border border-[var(--line-strong)] bg-[var(--bg)] px-2 text-[13px] text-[var(--text-primary)]"
              />
            </form>
          )}

          {roots.length > 0 && smartFolders.length === 0 && newFolderName === null && (
            <EmptyState
              variant="sidebar"
              icon={Bookmark}
              title="スマートフォルダはまだありません"
              description="絞り込みを保存できます。"
              action={
                onFocusFilters
                  ? { label: '条件を絞り込む', onClick: onFocusFilters }
                  : undefined
              }
            />
          )}

          {smartFolders.map((folder) => {
        if (renaming?.id === folder.id) {
          return (
            <form
              key={folder.id}
              className="px-1 pb-1"
              onSubmit={(event) => {
                event.preventDefault()
                const name = renaming.name.trim()
                if (name === '') return
                onRenameSmartFolder?.(folder.id, name)
                setRenaming(null)
              }}
            >
              <input
                autoFocus
                value={renaming.name}
                maxLength={40}
                aria-label={`${folder.name} の新しい名前`}
                spellCheck={false}
                onChange={(event) =>
                  setRenaming((current) =>
                    current === null ? current : { ...current, name: event.target.value },
                  )
                }
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenaming(null)
                }}
                className="h-8 w-full rounded-[var(--radius-control)] border border-[var(--line-strong)] bg-[var(--bg)] px-2 text-[13px] text-[var(--text-primary)]"
              />
            </form>
          )
        }

        const active = activeSmartFolderId === folder.id
        const menuOpen = smartMenuFor === folder.id
        return (
          <div key={folder.id} className="relative">
            <button
              type="button"
              aria-current={active ? 'true' : undefined}
              title={active ? `${folder.name}（適用中）` : folder.name}
              onClick={() => {
                setSmartMenuFor(null)
                onSelectSmartFolder?.(folder)
              }}
              className={cn(
                'group/smart flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] px-2 pr-6 text-left text-[13px] transition-colors duration-[var(--duration-fast)]',
                active
                  ? 'bg-[color-mix(in_srgb,var(--brand)_14%,transparent)] font-medium text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg)] hover:text-[var(--text-primary)]',
              )}
            >
              <Bookmark
                className={cn('size-3.5 flex-none', active && 'fill-current')}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              {active && activeSmartFolderCount != null && (
                <span className="flex-none text-xs text-[var(--text-secondary)] tabular-nums">
                  {formatCount(activeSmartFolderCount)}
                </span>
              )}
            </button>

            <button
              type="button"
              aria-label={`${folder.name} の操作`}
              aria-expanded={menuOpen}
              title="スマートフォルダの操作"
              onClick={(event) => {
                event.stopPropagation()
                setSmartMenuFor(menuOpen ? null : folder.id)
              }}
              className={cn(
                'absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-black/30 focus-visible:opacity-100 group-hover/smart:opacity-100',
                menuOpen && 'opacity-100',
              )}
            >
              <MoreHorizontal className="size-3.5" aria-hidden="true" />
            </button>

            {menuOpen && (
              <div
                className="absolute top-full right-1 z-20 mt-0.5 flex w-[168px] flex-col rounded-md border border-border bg-popover p-1 shadow-xl"
                role="menu"
              >
                <MenuButton
                  icon={<Bookmark className="size-3.5" />}
                  onClick={() => {
                    setSmartMenuFor(null)
                    setRenaming({ id: folder.id, name: folder.name })
                  }}
                >
                  名前を変更
                </MenuButton>
                <MenuButton
                  icon={<Trash2 className="size-3.5" />}
                  danger
                  onClick={() => {
                    setSmartMenuFor(null)
                    onDeleteSmartFolder?.(folder)
                  }}
                >
                  削除
                </MenuButton>
              </div>
            )}
          </div>
        )
          })}
        </>
      )}

      {roots.length > 0 && (
        <div className="mt-auto pt-4">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-full justify-start rounded-[var(--radius-control)] text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            onClick={onAddRoot}
          >
            <FolderPlus data-icon="inline-start" />
            ルートを追加
          </Button>
        </div>
      )}
    </aside>
  )
}

/** #63: 監視で増えた件数（例 `+12`）。選択して開くと消える。 */
function NewBadge({ count }: { count: number }) {
  return (
    <span
      className="flex-none rounded-full bg-[color-mix(in_srgb,var(--brand)_18%,transparent)] px-1.5 text-xs font-semibold text-[var(--brand)] tabular-nums"
      title={`監視で ${formatCount(count)} 件増えました（このルートを開くと消えます）`}
      aria-label={`新着 ${formatCount(count)} 件`}
    >
      +{formatCount(count)}
    </span>
  )
}

function MenuButton({
  icon,
  children,
  onClick,
  danger,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  onClick: () => void
  danger?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-[13px] hover:bg-[var(--muted)]',
        danger ? 'text-destructive' : 'text-[var(--text-primary)]',
      )}
    >
      {icon}
      {children}
    </button>
  )
}
