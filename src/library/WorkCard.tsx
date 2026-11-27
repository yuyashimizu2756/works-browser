import { memo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { cn } from 'cn'
import { ArrowUpRight, Eye, EyeOff, Film, ImageIcon, Layers } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import type { WorkSummary } from '../api'
import { formatBytes, formatCount, formatShortDate } from '../lib/format'
import { CARD_META_HEIGHT } from './gridMetrics'
import { hueForTitle, initialsForTitle, placeholderFontSize } from './placeholder'
import { useRevealedFiles } from './revealedFiles'
import { thumbSrc } from './thumbSrc'
import { MAX_PREVIEW_THUMBS, useHoverPreview } from './useHoverPreview'
import { useHoverVideoPreview } from './useHoverVideoPreview'
import { WORK_DRAG_TYPE } from './moveDrag'

const KIND_LABEL: Record<WorkSummary['kind'], string> = {
  image: '画像',
  video: '動画',
  mixed: '混在',
}

const KIND_ICON: Record<WorkSummary['kind'], typeof ImageIcon> = {
  image: ImageIcon,
  video: Film,
  mixed: Layers,
}

export type WorkSelectModifiers = {
  ctrl: boolean
  shift: boolean
}

type Props = {
  work: WorkSummary
  rootLabel: string
  /** ルートごとのアクセント（CSS 変数）。 */
  accent: string
  selected: boolean
  /** false のときは `convertFileSrc` を呼ばない（#21 のサムネ非表示）。 */
  thumbnailVisible: boolean
  /** ベンチモードではホバー動画プレビューを無効にする（#46）。 */
  bench: boolean
  /** 4:3 のカバー高さ。グリッドの行送りと揃えるために親から渡す（#98）。 */
  coverHeight?: number
  /** 選択のトグル。修飾キーはチェックボックス上でのクリック時だけ渡る（#27）。 */
  onToggle: (work: WorkSummary, modifiers: WorkSelectModifiers) => void
  onOpen: (work: WorkSummary) => void
  /** #57: ルートへドラッグして移動する。 */
  onDragStart?: (work: WorkSummary) => void
  /** #57: ドラッグ終了（成功 / キャンセルとも）。 */
  onDragEnd?: () => void
}

/**
 * グリッド 1 マス（#98 で Gallery minimal に再設計）。仮想スクロール中の
 * 再描画を抑えるため memo 化する。
 *
 * 見た目:
 * - カバーは 4:3 固定 + `object-fit: cover` + 角丸 12
 * - 画像なしが既定なので、タイトルから生成したタイポグラフィック・カバーを敷く
 *   （色相はタイトルのハッシュ、中央に先頭 1〜2 文字）
 * - メタは 2 行（題名 15px / 補助 12px tabular）。ルート名はツールチップと
 *   `aria-label` にだけ含める（余白を優先）
 * - ホバーは背景を 1 段明るくし、開く / 選択を 160ms で出す
 * - 選択はチェックボックスに加えて、枠 + わずかな背景色でも示す
 *
 * 操作（#27）:
 * - カード本体のクリック（単クリック / ダブルクリック / Enter）→ 詳細を開く。
 *   ダブルクリックの 2 回目は `event.detail` で捨てて二重遷移しない。選択はしない
 * - 選択は右上のチェックボックスのクリック時のみ。Ctrl / Shift はチェックボックス上でのみ効く
 */
export const WorkCard = memo(function WorkCard({
  work,
  rootLabel,
  accent,
  selected,
  thumbnailVisible,
  bench,
  coverHeight,
  onToggle,
  onOpen,
  onDragStart,
  onDragEnd,
}: Props) {
  const [thumbFailed, setThumbFailed] = useState(false)
  const [mosaicFailed, setMosaicFailed] = useState(false)
  // #121: 全体非表示中でも、この作品だけ一時的にサムネイルを表示できる
  const { enabled: globalHidden, revealedWorks, toggleWork } = useRevealedFiles()
  const individuallyRevealed = globalHidden && revealedWorks.has(work.id)
  const thumbVisible = thumbnailVisible || individuallyRevealed
  /** 単クリック → ダブルクリック / Enter で同じ遷移が二重に走らないためのガード。 */
  const lastOpenRef = useRef(Number.NEGATIVE_INFINITY)
  const openCard = () => {
    const now = performance.now()
    if (now - lastOpenRef.current < 500) return
    lastOpenRef.current = now
    onOpen(work)
  }
  // 非表示モードでは asset protocol の URL すら作らない
  const coverSrc = thumbVisible && !thumbFailed ? thumbSrc(work.cover_thumb) : null
  const preview = useHoverPreview(work, thumbVisible)
  /**
   * ホバー動画プレビュー（#46）。カバーは動画優先で選ばれるので、動画を含む
   * 作品（`image` 以外）はカバーのファイルを 5 秒だけ無音再生する。
   * サムネ非表示 / シールド中 / ベンチ中は無効。
   */
  const videoPreview = useHoverVideoPreview(
    work.kind === 'image' ? null : work.cover_file_id,
    thumbVisible && !bench,
  )
  /**
   * 余力枠（#21）: 先頭 4 ファイルのサムネイルが揃っていれば 2×2 のモザイク。
   * 1 枚でも読み込みに失敗したらカバー 1 枚へ戻す。
   */
  const mosaic =
    thumbVisible && !mosaicFailed && work.preview_thumbs.length >= MAX_PREVIEW_THUMBS
      ? work.preview_thumbs
          .slice(0, MAX_PREVIEW_THUMBS)
          .map((path) => thumbSrc(path))
          .filter((src): src is string => src !== null)
      : null
  const showMosaic = mosaic !== null && mosaic.length === MAX_PREVIEW_THUMBS
  const shownSrc = preview.previewSrc ?? (showMosaic ? null : coverSrc)
  /** 写真（カバー / プレビュー / モザイク）が出ているか。バッジの見た目を切り替える。 */
  const hasPhoto = Boolean(shownSrc) || showMosaic
  /** タイトルから決まる表紙（ハッシュ色相 + 先頭文字）。同じ作品は常に同じ見た目。 */
  const hue = hueForTitle(work.title)
  const initials = initialsForTitle(work.title)
  const fontSize = placeholderFontSize(coverHeight)
  const KindIcon = KIND_ICON[work.kind]
  const date = formatShortDate(work.mtime)
  const ariaLabel = [
    work.title,
    rootLabel,
    `${formatCount(work.file_count)} ファイル`,
    formatBytes(work.total_bytes),
    date,
  ]
    .filter(Boolean)
    .join('、')

  return (
    <div
      role="option"
      aria-selected={selected}
      aria-label={ariaLabel}
      title={`${work.title} — ${rootLabel ? `${rootLabel} / ` : ''}${work.rel_path}`}
      tabIndex={0}
      draggable
      data-work-id={work.id}
      data-selected={selected ? 'true' : undefined}
      data-placeholder={hasPhoto ? undefined : 'typographic'}
      data-placeholder-hue={hasPhoto ? undefined : hue}
      data-previewing={preview.previewSrc ? 'true' : undefined}
      data-video-previewing={videoPreview.playing ? 'true' : undefined}
      className={cn(
        'group/card relative flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-card)] bg-[var(--surface)] text-left',
        'transition-[box-shadow,background-color] duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
        // フォーカスは :focus-visible の 2px リング + offset 2（index.css で統一）。
        selected
          ? 'bg-[color-mix(in_srgb,var(--root-accent)_10%,var(--surface))] shadow-[inset_0_0_0_2px_var(--root-accent)]'
          : 'shadow-[inset_0_0_0_1px_var(--line)] hover:bg-[var(--raised)] hover:shadow-[inset_0_0_0_1px_var(--line-strong)]',
      )}
      style={{ '--root-accent': accent } as CSSProperties}
      onDragStart={(event) => {
        // チェックボックスからのドラッグは選択操作なので移動しない
        if ((event.target as HTMLElement).closest('[data-work-checkbox-wrapper]')) {
          event.preventDefault()
          return
        }
        event.dataTransfer.setData(WORK_DRAG_TYPE, String(work.id))
        event.dataTransfer.effectAllowed = 'move'
        onDragStart?.(work)
      }}
      onDragEnd={() => onDragEnd?.()}
      onPointerEnter={() => {
        preview.startPreview()
        videoPreview.startPreview()
      }}
      onPointerLeave={() => {
        preview.stopPreview()
        videoPreview.stopPreview()
      }}
      onClick={(event) => {
        // 単クリックで開く。ダブルクリックの 2 回目（detail > 1）は二重遷移しないよう捨てる
        if (event.detail > 1) return
        openCard()
      }}
      onDoubleClick={openCard}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          openCard()
        }
      }}
    >
      <span
        data-work-cover
        className={cn(
          'relative flex w-full flex-none items-center justify-center overflow-hidden',
          coverHeight === undefined && 'aspect-[4/3]',
        )}
        style={coverHeight === undefined ? undefined : { height: coverHeight }}
      >
        {shownSrc ? (
          <img
            className="absolute inset-0 h-full w-full object-cover"
            src={shownSrc}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => {
              if (preview.previewSrc) preview.stopPreview()
              else setThumbFailed(true)
            }}
          />
        ) : showMosaic ? (
          <span
            className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px bg-black/40"
            aria-hidden="true"
          >
            {mosaic.map((src, index) => (
              <img
                key={`${index}:${src}`}
                className="h-full w-full object-cover"
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                onError={() => setMosaicFailed(true)}
              />
            ))}
          </span>
        ) : (
          <WorkPlaceholder initials={initials} hue={hue} fontSize={fontSize} />
        )}

        {/* ホバー動画プレビュー（#46）。再生中だけ共有 <video> が差し込まれる */}
        <span
          ref={videoPreview.videoHostRef}
          aria-hidden="true"
          data-hover-video={videoPreview.playing ? 'playing' : 'idle'}
          className="pointer-events-none absolute inset-0 overflow-hidden"
        />

        {/*
          #108: 写真の上はピルをやめ、14px のアイコンだけを 60% で置く。
          種類はツールチップ（title / aria-label）で補う。画像なしのカードは
          従来どおり 20px のアイコン表示を維持する。
        */}
        <span
          data-kind-badge
          data-overlay={hasPhoto ? 'photo' : 'plain'}
          role="img"
          title={KIND_LABEL[work.kind]}
          aria-label={KIND_LABEL[work.kind]}
          className={cn(
            'absolute top-2 left-2 z-10 inline-flex items-center justify-center whitespace-nowrap',
            hasPhoto
              ? 'size-3.5 text-white opacity-60 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]'
              : 'size-5 text-[var(--text-secondary)]',
          )}
        >
          <KindIcon className={hasPhoto ? 'size-3.5' : 'size-5'} aria-hidden="true" />
        </span>

        {/*
          #121: 全体が非表示のときだけ、この作品のサムネイルを表示するトグル。
          #112 と同じく、右上はチェックボックス専用（右端 6px / 24×24）にし、
          目アイコンはその左隣へ 8px 間隔で置く（右端から 38px = 6 + 24 + 8）。
        */}
        {globalHidden && (
          <button
            type="button"
            data-work-reveal
            aria-pressed={individuallyRevealed}
            aria-label={
              individuallyRevealed
                ? 'この作品のサムネイルを隠す'
                : 'この作品のサムネイルを表示'
            }
            title={
              individuallyRevealed
                ? 'この作品のサムネイルを隠す'
                : 'この作品のサムネイルを表示'
            }
            onClick={(event) => {
              event.stopPropagation()
              toggleWork(work.id)
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className={cn(
              'absolute top-1.5 right-[38px] z-10 flex size-6 items-center justify-center rounded-md border border-white/15 backdrop-blur-sm transition-colors',
              individuallyRevealed
                ? 'bg-[var(--root-accent)]/80 text-white'
                : 'bg-black/60 text-white/75 hover:bg-black/80',
            )}
          >
            {individuallyRevealed ? (
              <EyeOff className="size-3.5" aria-hidden="true" />
            ) : (
              <Eye className="size-3.5" aria-hidden="true" />
            )}
          </button>
        )}

        {/* 開く操作。ホバー / フォーカス内でだけ 160ms かけて出す（クリックはカード本体が受ける）。 */}
        <span
          data-card-action="open"
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute right-2 bottom-2 z-10 flex size-7 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white backdrop-blur-md',
            'opacity-0 transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-standard)]',
            'group-hover/card:opacity-100 group-focus-within/card:opacity-100',
          )}
        >
          <ArrowUpRight className="size-4" />
        </span>

        {selected && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-[color-mix(in_srgb,var(--root-accent)_10%,transparent)]"
          />
        )}
      </span>

      {/* メタは 2 行だけ。高さは gridMetrics の CARD_META_HEIGHT と一致させる。 */}
      <span
        data-card-meta
        className="flex flex-none flex-col justify-center gap-1 px-3"
        style={{ height: CARD_META_HEIGHT }}
      >
        <span
          data-card-title
          className="truncate text-[15px] leading-[20px] font-semibold text-[var(--text-primary)]"
        >
          {work.title}
        </span>
        <span
          data-card-subtitle
          className="truncate text-xs leading-[18px] whitespace-nowrap text-[var(--text-secondary)] tabular-nums"
        >
          {formatCount(work.file_count)} ファイル
          <span aria-hidden="true"> · </span>
          {formatBytes(work.total_bytes)}
          <span aria-hidden="true"> · </span>
          {date}
        </span>
      </span>

      {/*
        選択はチェックボックスだけ（#27）。見た目は size-5 のまま、当たり判定だけ
        size-6（24×24px）に広げる。本体クリックへ伝播させない。
        選択中は常時表示、未選択はホバー / フォーカス内で 160ms 表示。
      */}
      <div
        className="absolute top-1.5 right-1.5 z-10 flex size-6 cursor-pointer items-center justify-center"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          // 24×24 の余白を押したときはラッパー側でトグルする
          if (event.target === event.currentTarget) {
            onToggle(work, { ctrl: event.ctrlKey, shift: event.shiftKey })
          }
        }}
        onDoubleClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          // Space / Enter はチェックのトグルに使うので本体（開く）へ流さない。Esc などは通す。
          if (event.key === ' ' || event.key === 'Enter') event.stopPropagation()
        }}
        data-work-checkbox-wrapper
      >
        <Checkbox
          checked={selected}
          // 修飾キーはチェックボックス上でのクリックだけ有効（#27）
          onClick={(event) => {
            event.stopPropagation()
            onToggle(work, { ctrl: event.ctrlKey, shift: event.shiftKey })
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={selected ? `${work.title} の選択を解除` : `${work.title} を選択`}
          className={cn(
            'size-5 border-white/40 bg-black/55 shadow-sm backdrop-blur-sm transition-opacity duration-[var(--duration-fast)]',
            // Radix 既定の大きな擬似要素ヒットエリア（after）は 24×24 ラッパーに任せる
            'after:inset-0',
            selected
              ? 'opacity-100'
              : 'opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 focus-visible:opacity-100',
            'data-checked:border-[var(--root-accent)] data-checked:bg-[var(--root-accent)] data-checked:text-white',
            'data-[state=checked]:border-[var(--root-accent)] data-[state=checked]:bg-[var(--root-accent)] data-[state=checked]:text-white',
          )}
        />
      </div>
    </div>
  )
})

/**
 * 画像なしカードのタイポグラフィック・カバー（#98）。
 *
 * 「暗い空箱」にせず、作品タイトルの先頭文字を大きく薄く置く。色相はタイトルの
 * ハッシュから決め、彩度・明度は固定（作品の色を邪魔しない 8% の面）。
 * 面であることは 1px の内側ボーダーで示す。
 */
function WorkPlaceholder({
  initials,
  hue,
  fontSize,
}: {
  initials: string
  hue: number
  fontSize: number
}) {
  return (
    <span
      className="work-placeholder absolute inset-0"
      style={{ '--placeholder-hue': hue } as CSSProperties}
      aria-hidden="true"
    >
      <span
        data-placeholder-initials
        className="work-placeholder-initials"
        style={{ fontSize }}
      >
        {initials}
      </span>
    </span>
  )
}
