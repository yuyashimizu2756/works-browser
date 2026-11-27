/**
 * 比較ビュー（#71）。
 *
 * 2〜4 枚を 1 画面に並べ、**ズームとパンを 1 つの状態で共有**する
 * （どれか 1 枚を拡大すると全部が同じ倍率・同じ相対位置になる）。
 *
 * - 2 枚: 左右、3 枚: 左 1 + 右 2、4 枚: 2×2（`src/lib/compare.ts`）
 * - ホイールでズーム、拡大中はドラッグで移動、ダブルクリックで 1↔2、`0` で原寸
 * - 動画は先頭フレーム（サムネイル）で静止表示し、各セルの「再生」で個別に再生する
 * - `Esc` で閉じる。シールド中は中身を DOM に残さない（画像 0 件）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Film, ImageIcon, Pause, Play, X, ZoomIn, ZoomOut } from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { canPan, clampCompareZoom, compareLayout, zoomAfterWheel } from '../lib/compare'
import { isActivatableTarget, isEditableTarget } from '../lib/shortcuts'
import type { CompareItem } from './compareItems'
import { mediaSrc } from './mediaSrc'
import { MetaDiffPanel } from './MetaDiffPanel'
import { thumbSrc } from './thumbSrc'

type Props = {
  items: CompareItem[]
  onClose: () => void
  /** ベンチ / headless では実メディアが無いのでサムネイルだけを出す。 */
  bench: boolean
  /** #22: シールド中は画像・動画を描画しない。 */
  shielded?: boolean
}

type Pan = { x: number; y: number }
type Drag = { pointerId: number; x: number; y: number; originX: number; originY: number }
type Tab = 'side' | 'diff'

export function CompareView({ items, onClose, bench, shielded = false }: Props) {
  // 2〜4 枚に丸める（呼び出し側でも保証しているが、DOM 側でも崩れないように）
  const visible = items.slice(0, 4)
  const layout = compareLayout(visible.length)
  const diffEnabled = visible.length === 2

  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const videoRefs = useRef(new Map<string, HTMLVideoElement>())

  const [tab, setTab] = useState<Tab>('side')
  // 3〜4 枚に増えたら差分タブは使えないので「並べて」に戻す
  useEffect(() => {
    if (!diffEnabled) setTab('side')
  }, [diffEnabled])
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState<Pan>({ x: 0, y: 0 })
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [playing, setPlaying] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [activeKey, setActiveKey] = useState<string | null>(
    () => visible.find((item) => item.kind === 'video')?.key ?? null,
  )

  const markFailed = useCallback((key: string) => {
    setFailed((current) => (current.has(key) ? current : new Set(current).add(key)))
  }, [])

  const setPlayingFor = useCallback((key: string, value: boolean) => {
    setPlaying((current) => {
      if (current.has(key) === value) return current
      const next = new Set(current)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])

  const resetZoom = useCallback(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }, [])

  const nudgeZoom = useCallback((factor: number) => {
    setZoom((value) => clampCompareZoom(value * factor))
  }, [])

  const toggleVideo = useCallback((key: string) => {
    const video = videoRefs.current.get(key)
    if (!video) return
    setActiveKey(key)
    if (video.paused) {
      void video.play().catch(() => undefined)
    } else {
      video.pause()
    }
  }, [])

  const toggleActiveVideo = useCallback(() => {
    const fallback = visible.find((item) => item.kind === 'video')?.key ?? null
    const key = activeKey ?? fallback
    if (key) toggleVideo(key)
  }, [activeKey, toggleVideo, visible])

  // ホイールズーム（passive: false でページスクロールを止める）
  useEffect(() => {
    const element = stageRef.current
    if (!element || shielded || tab !== 'side') return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      setZoom((value) => zoomAfterWheel(value, event.deltaY))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [shielded, tab])

  // キーボード（capture で詳細画面の Esc = 戻るより先に処理する）
  useEffect(() => {
    if (shielded) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
        return
      }
      if (event.ctrlKey || event.altKey || event.metaKey) return
      if (isActivatableTarget(event.target)) return
      // 差分タブでは画像のズーム / 動画再生のキーは効かせない
      if (tab !== 'side') return
      if (event.key === '0' || event.code === 'Numpad0') {
        event.preventDefault()
        resetZoom()
        return
      }
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        toggleActiveVideo()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, resetZoom, shielded, tab, toggleActiveVideo])

  if (shielded) return null

  const dragPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canPan(zoom)) return
    if ((event.target as HTMLElement).closest('button')) return
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: pan.x,
      originY: pan.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="比較ビュー"
      data-compare-view
      data-compare-count={visible.length}
      data-compare-tab={tab}
      data-compare-zoom={zoom}
      data-compare-pan={`${pan.x},${pan.y}`}
      className="fixed inset-0 z-[85] flex select-none flex-col bg-black/95 text-white backdrop-blur-sm"
    >
      {/* 上部バー（#100: ダイアログと同じ 56px / 24px 余白 / 15px 題名） */}
      <div className="flex h-14 flex-none items-center gap-3 border-b border-white/10 bg-black/40 px-6">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-white hover:bg-white/10"
          aria-label="閉じる（Esc）"
          title="閉じる（Esc）"
          onClick={onClose}
        >
          <X />
        </Button>
        <span className="flex items-baseline gap-2">
          <span className="text-[15px] font-semibold">比較</span>
          <span className="text-xs font-normal text-white/60 tabular-nums">
            {visible.length} 枚
          </span>
        </span>

        {/* #74: 並べて / 差分。差分は 2 枚のときだけ */}
        <div role="tablist" aria-label="比較の表示" className="ml-1 flex items-center gap-1">
          <Button
            role="tab"
            aria-selected={tab === 'side'}
            variant="ghost"
            size="xs"
            data-compare-tab-button="side"
            className={cn(
              'rounded-full',
              tab === 'side'
                ? 'bg-white/15 text-white hover:bg-white/20 hover:text-white'
                : 'text-white/60 hover:bg-white/10 hover:text-white',
            )}
            onClick={() => setTab('side')}
          >
            並べて
          </Button>
          <Button
            role="tab"
            aria-selected={tab === 'diff'}
            variant="ghost"
            size="xs"
            data-compare-tab-button="diff"
            disabled={!diffEnabled}
            title={diffEnabled ? '生成設定の差分（2 枚）' : '2枚で比較してください'}
            className={cn(
              'rounded-full',
              tab === 'diff'
                ? 'bg-white/15 text-white hover:bg-white/20 hover:text-white'
                : 'text-white/60 hover:bg-white/10 hover:text-white',
            )}
            onClick={() => {
              if (diffEnabled) setTab('diff')
            }}
          >
            差分
          </Button>
          {!diffEnabled && (
            <span data-compare-diff-hint className="text-xs text-white/45">
              2枚で比較してください
            </span>
          )}
        </div>

        <span className="ml-auto flex flex-none items-center gap-1.5 text-xs text-white/65 tabular-nums">
          <span className="mr-1" data-compare-zoom-label>
            ズーム {Math.round(zoom * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white hover:bg-white/10"
            aria-label="縮小"
            title="縮小"
            onClick={() => nudgeZoom(1 / 1.25)}
          >
            <ZoomOut />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-white hover:bg-white/10"
            aria-label="拡大"
            title="拡大"
            onClick={() => nudgeZoom(1.25)}
          >
            <ZoomIn />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-white hover:bg-white/10"
            onClick={resetZoom}
            title="原寸（0）"
          >
            原寸
          </Button>
        </span>
      </div>

      {/* #74: 差分タブ（2 枚のときだけ）。画像グリッドは状態を保ったまま隠す */}
      {tab === 'diff' && diffEnabled && visible[0] && visible[1] && (
        <MetaDiffPanel itemA={visible[0]} itemB={visible[1]} bench={bench} />
      )}

      {/* 2 / 3 / 4 枚のグリッド（すべて同じ transform を共有） */}
      <div
        ref={stageRef}
        data-compare-stage
        className={cn(
          'grid min-h-0 flex-1 gap-2 overflow-hidden p-2',
          canPan(zoom) ? 'cursor-grab active:cursor-grabbing' : 'cursor-default',
        )}
        style={{
          ...layout.style,
          display: tab === 'diff' && diffEnabled ? 'none' : undefined,
        }}
        onPointerDown={dragPan}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          event.preventDefault()
          setPan({
            x: drag.originX + (event.clientX - drag.x),
            y: drag.originY + (event.clientY - drag.y),
          })
        }}
        onPointerUp={() => {
          dragRef.current = null
        }}
        onPointerCancel={() => {
          dragRef.current = null
        }}
        onDoubleClick={() => {
          if (zoom > 1) resetZoom()
          else setZoom(2)
        }}
      >
        {visible.map((item, index) => {
          const placement = layout.cells[index]
          const direct = mediaSrc(item.fileId)
          const thumb = thumbSrc(item.thumbPath)
          const isVideo = item.kind === 'video'
          const isPlaying = playing.has(item.key)
          const isFailed = failed.has(item.key)

          return (
            <section
              key={item.key}
              data-compare-cell
              data-compare-key={item.key}
              data-compare-kind={item.kind}
              aria-label={`${item.title}（${index + 1} / ${visible.length}）`}
              className="relative flex min-h-0 min-w-0 items-center justify-center overflow-hidden rounded-xl border border-white/12 bg-black/60"
              style={{ gridColumn: placement.gridColumn, gridRow: placement.gridRow }}
              onPointerEnter={() => {
                if (isVideo) setActiveKey(item.key)
              }}
            >
              <div
                data-compare-media
                className="absolute inset-0 flex items-center justify-center"
                style={{ transform, transition: 'transform 90ms ease-out' }}
              >
                {isVideo ? (
                  direct && !isFailed ? (
                    <video
                      ref={(node) => {
                        if (node) videoRefs.current.set(item.key, node)
                        else videoRefs.current.delete(item.key)
                      }}
                      data-compare-video
                      className="max-h-full max-w-full bg-black object-contain"
                      src={direct}
                      poster={thumb ?? undefined}
                      preload="metadata"
                      muted
                      playsInline
                      onClick={() => toggleVideo(item.key)}
                      onLoadedMetadata={(event) => {
                        // 先頭フレームで静止（再生は個別ボタンから）
                        if (event.currentTarget.duration > 0) event.currentTarget.currentTime = 0
                      }}
                      onPlay={() => setPlayingFor(item.key, true)}
                      onPause={() => setPlayingFor(item.key, false)}
                      onEnded={() => setPlayingFor(item.key, false)}
                      onError={() => markFailed(item.key)}
                    />
                  ) : (
                    <div className="flex max-h-full max-w-full flex-col items-center gap-2 px-4 text-center">
                      {thumb ? (
                        <img
                          className="max-h-full max-w-full object-contain"
                          src={thumb}
                          alt=""
                          draggable={false}
                          onError={() => markFailed(item.key)}
                        />
                      ) : (
                        <Film className="size-10 text-white/35" aria-hidden="true" />
                      )}
                      {bench && <span className="text-xs text-white/50">先頭フレーム</span>}
                    </div>
                  )
                ) : thumb || direct ? (
                  <img
                    className="max-h-full max-w-full object-contain"
                    src={isFailed ? (thumb ?? undefined) : (direct ?? thumb ?? undefined)}
                    alt=""
                    draggable={false}
                    onError={() => {
                      if (direct && !isFailed) markFailed(item.key)
                    }}
                  />
                ) : (
                  <div className="flex flex-col items-center gap-2 text-sm text-white/55">
                    <ImageIcon className="size-10" aria-hidden="true" />
                    プレビューを表示できません
                  </div>
                )}
              </div>

              {/* ラベル */}
              <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start gap-2 bg-gradient-to-b from-black/70 to-transparent px-2.5 pt-2 pb-6">
                <span className="rounded border border-white/15 bg-black/65 px-1.5 py-0.5 text-xs font-semibold tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-semibold">{item.title}</span>
                  {item.subtitle && (
                    <span className="block truncate text-xs text-white/55">
                      {item.subtitle}
                    </span>
                  )}
                </span>
                <span className="ml-auto flex flex-none items-center gap-1 text-xs text-white/55">
                  {isVideo ? (
                    <Film className="size-3" aria-hidden="true" />
                  ) : (
                    <ImageIcon className="size-3" aria-hidden="true" />
                  )}
                  {isVideo ? '動画' : '画像'}
                </span>
              </div>

              {/* 動画は個別に再生 / 停止できる */}
              {isVideo && (
                <Button
                  variant="secondary"
                  size="xs"
                  className="absolute right-2 bottom-2 gap-1"
                  aria-label={isPlaying ? `${item.title} を停止` : `${item.title} を再生`}
                  title={isPlaying ? '停止' : '個別に再生（先頭フレームから）'}
                  disabled={!direct}
                  onClick={(event) => {
                    event.stopPropagation()
                    toggleVideo(item.key)
                  }}
                >
                  {isPlaying ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
                  {isPlaying ? '停止' : '再生'}
                </Button>
              )}
            </section>
          )
        })}
      </div>

      {/* 下部バー */}
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-1 border-t border-white/10 bg-black/45 px-6 py-3 text-xs text-white/60 tabular-nums">
        {tab === 'diff' ? (
          <span>1 と 2 の生成設定の違い（一致した項目はまとめて表示）</span>
        ) : (
          <span>ホイールでズーム / 拡大中はドラッグで移動 / ダブルクリックで 1↔2</span>
        )}
        <span className="ml-auto flex items-center gap-3">
          <span>
            <kbd className="rounded border border-white/25 px-1 font-sans">0</kbd> 原寸
          </span>
          <span>
            <kbd className="rounded border border-white/25 px-1 font-sans">Space</kbd> 動画
          </span>
          <span>
            <kbd className="rounded border border-white/25 px-1 font-sans">Esc</kbd> 閉じる
          </span>
        </span>
      </div>
    </div>
  )
}
