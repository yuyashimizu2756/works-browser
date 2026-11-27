import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Film,
  ImageIcon,
  Info,
  Maximize,
  Minimize,
  Pause,
  Play,
  RefreshCw,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { api } from '../api'
import type { FileSummary } from '../api'
import type { GenerationMeta } from '../api'
import { formatBytes, formatDuration, formatShortDate, describeError } from '../lib/format'
import { volumeAfterMuteToggle, volumeAfterSlider } from '../lib/volume'
import { readPlaybackPreference, rememberPlayback } from '../settings/playback'
import { canQueuePrompt, comfyActionFor } from './comfy'
import { imageSrc, mediaSrc } from './mediaSrc'
import { useScrubPreview } from './useScrubPreview'

type Props = {
  /** 読み込み済みのファイル（並び順はグリッドと同じ）。 */
  files: FileSummary[]
  /** 表示中の位置（`files` の添字）。 */
  index: number
  hasMore: boolean
  loadingMore: boolean
  /** 末尾に近づいたら次のページを要求する。 */
  onRequestMore: () => void
  onIndexChange: (index: number) => void
  onClose: () => void
  /** ベンチ / headless（再生位置の保存と実メディアを使わない）。 */
  bench: boolean
  /**
   * #22: シールド中。`<img>` は描画せず、`<video>` は DOM に残したまま
   * `pause()` + `muted = true` にする（再生位置と再生状態を復帰できるように）。
   */
  shielded?: boolean
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SEEK_STEP = 5
const PRELOAD_RADIUS = 3
/** これ未満の位置は「最初から」とみなして保存しない。 */
const MIN_RESUME_MS = 3_000
/** 終端からこの距離まで来たら「見終わった」として位置を消す。 */
const END_GUARD_MS = 2_000
const SAVE_INTERVAL_MS = 5_000

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function secondsText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  return formatDuration(Math.round(value * 1000))
}

/**
 * ライトボックス / プレイヤー（#5）。
 *
 * - 画像: `←` / `→` で移動、ホイールでズーム、`0` で原寸、`F` で全画面、`Esc` で閉じる
 * - 動画: `Space` 再生 / 停止、`←` / `→` ±5 秒、`Shift+←` / `→` 前後ファイル
 * - 動画の再生位置は 5 秒ごと・一時停止 / シーク / 閉じる時に保存し、次回は続きから
 * - 動画のシークバー上では、カーソル地点のフレームを 150ms 後に小さくプレビュー（#47）
 * - 画像は現在 ±3 枚を先読み
 *
 * メディアは `wbm:` スキーム（Rust 側で Range 配信）から読むので、10GB の動画でも
 * メモリに載らない。ベンチではサムネイルの data URL にフォールバックする。
 */
export function Lightbox({
  files,
  index,
  hasMore,
  loadingMore,
  onRequestMore,
  onIndexChange,
  onClose,
  bench,
  shielded = false,
}: Props) {
  const file: FileSummary | undefined = files[index]
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [imageFailed, setImageFailed] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [videoError, setVideoError] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [current, setCurrent] = useState(0)
  const [rate, setRate] = useState(1)
  // 既定は起動時ミュート・音量0（#5）。設定画面で「音量を保存する」を有効にした
  // ときだけ前回の音量を復元する（#8）。
  const initialPlayback = useRef(readPlaybackPreference())
  const [volume, setVolume] = useState(initialPlayback.current.volume)
  const [muted, setMuted] = useState(initialPlayback.current.muted)
  const [resumeMs, setResumeMs] = useState<number | null>(null)
  // #60: 生成メタデータ（プロンプト・モデル等）の表示
  const [metaOpen, setMetaOpen] = useState(false)
  const [meta, setMeta] = useState<GenerationMeta | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  // #73: ComfyUI 連携（workflow を開く / API 形式をコピー / この設定で再実行）
  const [comfyBusy, setComfyBusy] = useState(false)
  const [comfyNotice, setComfyNotice] = useState<string | null>(null)
  const [comfyError, setComfyError] = useState<string | null>(null)
  const [comfyJson, setComfyJson] = useState<string | null>(null)
  const [confirmQueue, setConfirmQueue] = useState(false)

  /** 保存用のスナップショット（アンマウント時に video 要素が無くても保存できる）。 */
  const snapshot = useRef<{ fileId: number | null; positionMs: number; durationMs: number | null }>(
    { fileId: null, positionMs: 0, durationMs: null },
  )
  const lastSavedAt = useRef(0)
  const pendingSeekMs = useRef<number | null>(null)
  const panDrag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null)
  /** #22: シールド前の再生状態（復帰時に戻す）。 */
  const shieldWasPlaying = useRef(false)

  const fileKind = file?.kind
  const fileId = file?.id ?? null
  const direct = file ? mediaSrc(file.id) : null

  // #47: プレビュー専用の `<video>`（本体とは別要素・ミュート固定）。
  // ベンチ / シールド / 再生エラー中は出さない。ファイルが変われば破棄される。
  const scrubEnabled = fileKind === 'video' && !bench && !shielded && !videoError
  const scrub = useScrubPreview({ enabled: scrubEnabled, duration, fileKey: fileId })

  const saveSnapshot = useCallback(() => {
    const state = snapshot.current
    if (state.fileId === null || bench) return
    // 開いた直後（メタデータ未読込）に 0ms で上書きしない
    if (state.positionMs < 1_000 && state.durationMs === null) return
    const durationMs = state.durationMs
    const nearEnd =
      durationMs !== null && durationMs > 0 && state.positionMs > durationMs - END_GUARD_MS
    const positionMs = nearEnd || state.positionMs < 1_000 ? 0 : Math.round(state.positionMs)
    void api.saveFilePosition(state.fileId, positionMs, durationMs).catch(() => {
      // 保存できなくても閲覧は続けられる
    })
    lastSavedAt.current = performance.now()
  }, [bench])

  // ファイルが変わったらズーム・再生状態をリセットし、保存済みの位置を読む
  useEffect(() => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setImageFailed(false)
    setVideoError(false)
    setPlaying(false)
    setRate(1)
    setCurrent(0)
    setDuration(0)
    setResumeMs(null)
    setComfyBusy(false)
    setComfyNotice(null)
    setComfyError(null)
    setComfyJson(null)
    setConfirmQueue(false)
    pendingSeekMs.current = null
    snapshot.current = {
      fileId: fileKind === 'video' ? fileId : null,
      positionMs: 0,
      durationMs: file?.duration_ms ?? null,
    }

    if (fileKind !== 'video' || fileId === null || bench) return
    let alive = true
    void api
      .getFilePosition(fileId)
      .then((position) => {
        if (!alive || !position) return
        const knownDuration = position.duration_ms ?? file?.duration_ms ?? 0
        if (
          position.position_ms < MIN_RESUME_MS ||
          (knownDuration > 0 && position.position_ms > knownDuration - END_GUARD_MS)
        ) {
          return
        }
        pendingSeekMs.current = position.position_ms
        setResumeMs(position.position_ms)
        const video = videoRef.current
        if (video && video.readyState >= 1) {
          video.currentTime = position.position_ms / 1000
          pendingSeekMs.current = null
          setCurrent(position.position_ms / 1000)
        }
      })
      .catch(() => {
        // 位置が読めなくても最初から再生する
      })
    return () => {
      alive = false
    }
  }, [fileKind, fileId, file?.duration_ms, bench])

  // #22: シールド中は音を止め、解除時に再生状態（位置・ミュート）へ戻す。
  // `<video>` は DOM に残すので currentTime はそのまま。`silenceVideos` が
  // 付けた dataset から「シールド前に再生中だったか」を読む。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (shielded) {
      shieldWasPlaying.current = video.dataset.shieldWasPlaying === '1'
      video.pause()
      video.muted = true
      return
    }
    if (shieldWasPlaying.current) {
      video.muted = video.dataset.shieldWasMuted === '1'
      void video.play().catch(() => undefined)
      shieldWasPlaying.current = false
    }
  }, [shielded])

  // #60: パネルを開いたときにだけ生成情報を抽出する（走査時には読まない）
  useEffect(() => {
    if (!metaOpen || !file) return
    let alive = true
    setMetaLoading(true)
    setMeta(null)
    void api
      .getGenerationMeta(file.id)
      .then((value) => {
        if (alive) setMeta(value)
      })
      .catch(() => {
        if (alive) setMeta(null)
      })
      .finally(() => {
        if (alive) setMetaLoading(false)
      })
    return () => {
      alive = false
    }
  }, [metaOpen, file])

  // #73: 「ComfyUI へ」。workflow は保存してブラウザで開き、API 形式はコピーする。
  const openInComfy = useCallback(async () => {
    if (!file) return
    setComfyBusy(true)
    setComfyError(null)
    setComfyNotice(null)
    setComfyJson(null)
    try {
      const result = await api.comfyOpen(file.id)
      if (result.mode === 'api' && result.api_prompt) {
        try {
          await navigator.clipboard.writeText(result.api_prompt)
          setComfyNotice(result.message)
        } catch {
          setComfyJson(result.api_prompt)
          setComfyNotice(
            'クリップボードにコピーできませんでした。下の JSON を選択してコピーし、ComfyUI に貼り付けてください',
          )
        }
      } else {
        setComfyNotice(result.message)
      }
    } catch (cause) {
      setComfyError(describeError(cause))
    } finally {
      setComfyBusy(false)
    }
  }, [file])

  // #73: 「この設定で再実行」。確認ダイアログのあと `POST /prompt` に送る。
  const queuePrompt = useCallback(async () => {
    if (!file) return
    setConfirmQueue(false)
    setComfyBusy(true)
    setComfyError(null)
    setComfyNotice(null)
    setComfyJson(null)
    try {
      const result = await api.comfyQueuePrompt(file.id)
      setComfyNotice(`ComfyUI のキューに追加しました（prompt_id: ${result.prompt_id}）`)
    } catch (cause) {
      setComfyError(describeError(cause))
    } finally {
      setComfyBusy(false)
    }
  }, [file])

  const comfyAction = comfyActionFor(meta)
  const comfyQueueable = canQueuePrompt(meta)

  // 閉じる / 別ファイルへ移動する前に位置を保存する
  const persistBefore = useCallback(() => {
    saveSnapshot()
  }, [saveSnapshot])

  // アンマウント（ライトボックスを閉じる）時に最後の位置を保存する
  useEffect(() => {
    return () => {
      saveSnapshot()
    }
  }, [saveSnapshot])

  const close = useCallback(() => {
    persistBefore()
    onClose()
  }, [persistBefore, onClose])

  const goTo = useCallback(
    (next: number) => {
      if (next < 0 || next === index) return
      if (next >= files.length) {
        if (hasMore && !loadingMore) onRequestMore()
        return
      }
      persistBefore()
      onIndexChange(next)
    },
    [files.length, hasMore, index, loadingMore, onIndexChange, onRequestMore, persistBefore],
  )

  const goPrev = useCallback(() => goTo(index - 1), [goTo, index])
  const goNext = useCallback(() => goTo(index + 1), [goTo, index])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video || bench) return
    if (video.paused) void video.play().catch(() => setVideoError(true))
    else video.pause()
  }, [bench])

  const seekBy = useCallback(
    (seconds: number) => {
      const video = videoRef.current
      if (!video) return
      const max = Number.isFinite(video.duration) ? video.duration : 0
      video.currentTime = clamp(video.currentTime + seconds, 0, Math.max(0, max))
    },
    [],
  )

  const toggleFullscreen = useCallback(() => {
    const element = containerRef.current
    if (!element) return
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
    } else {
      void element.requestFullscreen().catch(() => undefined)
    }
  }, [])

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // キーボード（capture で作品詳細の Esc = 戻るより先に処理する）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // #22: シールド中は下の画面を動かさない（解除後に元の状態へ戻す）
      if (shielded) return
      // #73: 再実行の確認中は Esc でダイアログだけを閉じる
      if (confirmQueue) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setConfirmQueue(false)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        Boolean(target?.isContentEditable)
      ) {
        return
      }

      if (fileKind === 'video') {
        if (event.code === 'Space') {
          event.preventDefault()
          togglePlay()
          return
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          if (event.shiftKey) goNext()
          else seekBy(SEEK_STEP)
          return
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          if (event.shiftKey) goPrev()
          else seekBy(-SEEK_STEP)
          return
        }
        if (event.code === 'KeyF') {
          event.preventDefault()
          toggleFullscreen()
          return
        }
        if (event.key === '0' || event.code === 'Numpad0') {
          event.preventDefault()
          seekBy(-Number.MAX_SAFE_INTEGER)
        }
        return
      }

      if (event.key === 'ArrowRight') goNext()
      else if (event.key === 'ArrowLeft') goPrev()
      else if (event.key === '0' || event.code === 'Numpad0') {
        event.preventDefault()
        setZoom(1)
        setPan({ x: 0, y: 0 })
      } else if (event.code === 'KeyF') {
        event.preventDefault()
        toggleFullscreen()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [close, fileKind, goNext, goPrev, seekBy, shielded, toggleFullscreen, togglePlay, confirmQueue])

  // 画像のホイールズーム（passive: false でページスクロールを止める）
  useEffect(() => {
    const element = containerRef.current
    if (!element || fileKind !== 'image') return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = Math.exp(-event.deltaY * 0.0015)
      setZoom((value) => clamp(value * factor, 0.2, 8))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [fileKind, fileId])

  // 画像は現在 ±3 枚を先読みする（実メディアのみ。ベンチは data URL なので不要）
  useEffect(() => {
    if (bench) return
    for (let offset = -PRELOAD_RADIUS; offset <= PRELOAD_RADIUS; offset += 1) {
      if (offset === 0) continue
      const neighbor = files[index + offset]
      if (neighbor?.kind !== 'image') continue
      const src = imageSrc(neighbor.id, neighbor.thumb_path)
      if (!src) continue
      const image = new Image()
      image.decoding = 'async'
      image.src = src
    }
  }, [bench, files, index])

  // 末尾に近づいたら次のページを読む（ライトボックスで送り続けても止まらない）
  const requestedFor = useRef(0)
  useEffect(() => {
    if (!hasMore || loadingMore) return
    if (index < files.length - 2) return
    if (requestedFor.current === files.length) return
    requestedFor.current = files.length
    onRequestMore()
  }, [files.length, hasMore, index, loadingMore, onRequestMore])

  if (!file) {
    return (
      <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/90 text-sm text-white">
        読み込み中…
        <Button variant="ghost" size="sm" className="ml-3 text-white" onClick={close}>
          閉じる
        </Button>
      </div>
    )
  }

  const image = fileKind === 'image'
  const fallbackImage = file.thumb_path
  const imageUrl = image ? (imageFailed ? fallbackImage : (direct ?? fallbackImage)) : null
  const total = files.length

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${file.name} のプレビュー`}
      data-lightbox
      data-file-id={file.id}
      data-shielded={shielded ? 'true' : undefined}
      className={cn(
        'fixed inset-0 z-[80] flex select-none flex-col bg-black/92 text-white backdrop-blur-sm',
        shielded && 'hidden',
      )}
    >
      {/* 上部バー */}
      <div className="flex h-12 flex-none items-center gap-2 border-b border-white/10 bg-black/40 px-4 py-2">
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-white hover:bg-white/10"
          aria-label="閉じる（Esc）"
          title="閉じる（Esc）"
          onClick={close}
        >
          <X />
        </Button>
        <span className="flex min-w-0 items-center gap-2">
          {image ? (
            <ImageIcon className="size-4 text-[var(--brand)]" aria-hidden="true" />
          ) : (
            <Film className="size-4 text-[var(--brand)]" aria-hidden="true" />
          )}
          <span className="truncate text-sm font-semibold">{file.name}</span>
        </span>
        <span className="ml-auto flex flex-none items-center gap-2 text-xs text-white/65 tabular-nums">
          <span>
            {index + 1} / {hasMore ? `${total}+` : total}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatBytes(file.bytes)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatShortDate(file.mtime)}</span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-white hover:bg-white/10"
          aria-label="生成情報"
          aria-pressed={metaOpen}
          title="生成情報（プロンプト・モデル・シード）"
          onClick={() => setMetaOpen((open) => !open)}
        >
          <Info />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-white hover:bg-white/10"
          aria-label={isFullscreen ? '全画面を解除（F）' : '全画面（F）'}
          title={isFullscreen ? '全画面を解除（F）' : '全画面（F）'}
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <Minimize /> : <Maximize />}
        </Button>
      </div>

      {/* #60: 生成情報パネル（プロンプト・モデル・シード等） */}
      {metaOpen && (
        <div className="max-h-[42vh] flex-none overflow-y-auto border-b border-white/10 bg-black/70 px-4 py-3 text-xs">
          {metaLoading ? (
            <p className="m-0 text-white/60">読み込み中…</p>
          ) : !meta ? (
            <p className="m-0 text-white/60">このファイルに生成情報は見つかりませんでした。</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <MetaRow label="プロンプト" value={meta.prompt} multiline />
              <MetaRow label="ネガティブ" value={meta.negative_prompt} multiline />
              <MetaRow label="モデル" value={meta.model} />
              {meta.loras.length > 0 && <MetaRow label="LoRA" value={meta.loras.join(', ')} />}
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-white/75 tabular-nums">
                {meta.steps && <span>Steps {meta.steps}</span>}
                {meta.sampler && <span>{meta.sampler}</span>}
                {meta.cfg && <span>CFG {meta.cfg}</span>}
                {meta.seed && <span>Seed {meta.seed}</span>}
                {meta.size && <span>{meta.size}</span>}
                <span className="text-white/60">({meta.source})</span>
              </div>

              {/* #73: 画像の生成情報から ComfyUI へ（workflow を開く / API をコピー / 再実行） */}
              {image && (
                <div className="mt-1 flex flex-col gap-1.5 border-t border-white/10 pt-2">
                  <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="ComfyUI へ">
                    {comfyAction !== 'none' && (
                      <Button
                        variant="outline"
                        size="xs"
                        className="h-6 text-xs text-white"
                        title={
                          comfyAction === 'workflow'
                            ? 'workflow を設定の workflows フォルダへ保存し、ComfyUI をブラウザで開きます'
                            : 'API 形式のプロンプトをクリップボードへコピーします'
                        }
                        onClick={() => void openInComfy()}
                        disabled={comfyBusy}
                      >
                        <Wand2 data-icon="inline-start" />
                        {comfyBusy ? '準備しています…' : 'ComfyUI へ'}
                      </Button>
                    )}
                    {comfyQueueable && (
                      <Button
                        variant="outline"
                        size="xs"
                        className="h-6 text-xs text-white"
                        title="この画像の API 形式プロンプトを ComfyUI のキューへ送ります"
                        onClick={() => {
                          setComfyError(null)
                          setComfyNotice(null)
                          setComfyJson(null)
                          setConfirmQueue(true)
                        }}
                        disabled={comfyBusy}
                      >
                        <RefreshCw data-icon="inline-start" />
                        この設定で再実行
                      </Button>
                    )}
                    {comfyAction === 'none' && (
                      <span className="text-xs text-white/60">
                        この画像には ComfyUI の workflow / API プロンプトがありません
                      </span>
                    )}
                  </div>
                  {comfyNotice && (
                    <p className="m-0 text-xs text-[var(--success)]" role="status">
                      {comfyNotice}
                    </p>
                  )}
                  {comfyError && (
                    <p className="m-0 text-xs whitespace-pre-wrap text-[var(--destructive)]" role="alert">
                      {comfyError}
                    </p>
                  )}
                  {comfyJson && (
                    <textarea
                      readOnly
                      aria-label="ComfyUI に貼り付ける API 形式の JSON"
                      className="h-24 w-full resize-y rounded bg-black/50 p-2 font-mono text-xs text-white/75"
                      value={comfyJson}
                      onFocus={(event) => event.currentTarget.select()}
                    />
                  )}
                </div>
              )}
              {meta.raw && (
                <details className="text-white/60">
                  <summary className="cursor-pointer select-none">生データ</summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-black/50 p-2 text-xs whitespace-pre-wrap">
                    {meta.raw}
                  </pre>
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {/* メディア本体 */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {image ? (
          <div
            className="flex h-full w-full items-center justify-center overflow-hidden"
            onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
              if (zoom <= 1) return
              panDrag.current = {
                x: event.clientX,
                y: event.clientY,
                originX: pan.x,
                originY: pan.y,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const drag = panDrag.current
              if (!drag) return
              setPan({
                x: drag.originX + (event.clientX - drag.x),
                y: drag.originY + (event.clientY - drag.y),
              })
            }}
            onPointerUp={() => {
              panDrag.current = null
            }}
            onPointerCancel={() => {
              panDrag.current = null
            }}
            onDoubleClick={() => {
              setZoom((value) => (value > 1 ? 1 : 2))
              setPan({ x: 0, y: 0 })
            }}
          >
            {shielded ? null : imageUrl ? (
              <img
                src={imageUrl}
                alt={file.name}
                draggable={false}
                className="max-h-full max-w-full object-contain"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  cursor: zoom > 1 ? 'grab' : 'zoom-in',
                  transition: panDrag.current ? 'none' : 'transform 120ms ease-out',
                }}
                onError={() => {
                  if (!imageFailed && fallbackImage) setImageFailed(true)
                }}
              />
            ) : (
              <div className="flex flex-col items-center gap-2 text-sm text-white/60">
                <ImageIcon className="size-10" aria-hidden="true" />
                プレビューを表示できません
              </div>
            )}
          </div>
        ) : bench ? (
          <div className="flex max-w-[520px] flex-col items-center gap-2 px-6 text-center text-sm text-white/70">
            <Film className="size-10 text-white/40" aria-hidden="true" />
            <p className="m-0 font-semibold text-white/85">ベンチモード</p>
            <p className="m-0 text-xs">
              合成データには実ファイルが無いため動画は再生できません。実アプリではこの場で
              Range 配信のプレイヤーが開きます。
            </p>
          </div>
        ) : (
          <video
            ref={videoRef}
            className="max-h-full max-w-full bg-black"
            src={direct ?? undefined}
            preload="metadata"
            playsInline
            onClick={togglePlay}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget
              const nextDuration = Number.isFinite(video.duration) ? video.duration : 0
              setDuration(nextDuration)
              video.volume = volume
              video.muted = muted
              video.playbackRate = rate
              snapshot.current = {
                fileId: file.id,
                positionMs: Math.round(video.currentTime * 1000),
                durationMs: nextDuration > 0 ? Math.round(nextDuration * 1000) : null,
              }
              if (pendingSeekMs.current !== null) {
                const target = pendingSeekMs.current / 1000
                if (nextDuration === 0 || target < nextDuration - END_GUARD_MS / 1000) {
                  video.currentTime = target
                  setCurrent(target)
                }
                pendingSeekMs.current = null
              }
              // クリックで開いたら自動再生（音はミュートのまま）
              if (!shielded) void video.play().catch(() => undefined)
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget
              setCurrent(video.currentTime)
              snapshot.current = {
                fileId: file.id,
                positionMs: video.currentTime * 1000,
                durationMs: Number.isFinite(video.duration)
                  ? Math.round(video.duration * 1000)
                  : null,
              }
              if (performance.now() - lastSavedAt.current > SAVE_INTERVAL_MS) saveSnapshot()
            }}
            onPlay={() => {
              setPlaying(true)
              // #47: 再生が始まったらプレビューは破棄する
              scrub.cancel()
            }}
            onPause={() => {
              setPlaying(false)
              saveSnapshot()
            }}
            onSeeked={saveSnapshot}
            onError={() => setVideoError(true)}
            onEnded={() => {
              saveSnapshot()
            }}
          />
        )}

        {/* 前後のファイルへ */}
        {index > 0 && (
          <button
            type="button"
            aria-label="前のファイル（← / Shift+←）"
            title="前のファイル（← / Shift+←）"
            className="absolute top-1/2 left-2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white/80 backdrop-blur-sm hover:bg-black/75 hover:text-white"
            onClick={goPrev}
          >
            <ChevronLeft />
          </button>
        )}
        {(index + 1 < total || hasMore) && (
          <button
            type="button"
            aria-label="次のファイル（→ / Shift+→）"
            title="次のファイル（→ / Shift+→）"
            className="absolute top-1/2 right-2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full border border-white/15 bg-black/55 text-white/80 backdrop-blur-sm hover:bg-black/75 hover:text-white"
            onClick={goNext}
          >
            {index + 1 < total || !loadingMore ? (
              <ChevronRight />
            ) : (
              <span className="size-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
            )}
          </button>
        )}

        {resumeMs !== null && !videoError && !bench && (
          <span className="absolute top-2 left-1/2 -translate-x-1/2 rounded-full border border-white/15 bg-black/70 px-3 py-1 text-xs text-white/85 tabular-nums backdrop-blur-sm">
            続きから {formatDuration(resumeMs)}
          </span>
        )}

        {videoError && !bench && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/75 px-6 text-center">
            <Film className="size-10 text-white/40" aria-hidden="true" />
            <p className="m-0 text-sm font-semibold">この動画を再生できません</p>
            <p className="m-0 max-w-[420px] text-xs text-white/60">
              mp4（H.264 / AAC）または webm に変換すると再生できます。ファイル自体は
              「エクスプローラで開く」から確認できます。
            </p>
          </div>
        )}
      </div>

      {/* #47: プレビュー専用の `<video>`（非表示・ミュート固定・本体とは別要素） */}
      {scrubEnabled && (
        <video
          ref={scrub.previewVideoRef}
          data-scrub-preview-video="true"
          aria-hidden="true"
          tabIndex={-1}
          className="hidden"
          src={direct ?? undefined}
          preload="metadata"
          muted
          playsInline
          onSeeked={scrub.handleSeeked}
          onError={scrub.handleError}
        />
      )}

      {/* #47: カーソル付近のフレームプレビュー（右端・上端では反転して出す） */}
      {scrub.preview && (
        <div
          data-scrub-preview="true"
          className="pointer-events-none fixed z-[90] w-40 overflow-hidden rounded-lg border border-white/15 bg-black/85 shadow-[0_10px_30px_rgba(0,0,0,0.55)]"
          style={{ left: scrub.preview.left, top: scrub.preview.top }}
        >
          <img
            data-scrub-preview-image="true"
            src={scrub.preview.src}
            alt=""
            draggable={false}
            className="block w-full"
          />
          <span className="block bg-black/70 px-2 py-1 text-center text-xs text-white/90 tabular-nums">
            {secondsText(scrub.preview.seconds)}
          </span>
        </div>
      )}

      {/* 下部バー（動画はプレイヤー、画像はズーム情報） */}
      {image ? (
        <div className="flex flex-none items-center gap-3 border-t border-white/10 bg-black/45 px-4 py-3 text-xs text-white/65 tabular-nums">
          <span>ズーム {Math.round(zoom * 100)}%</span>
          <span className="text-white/60">ホイールでズーム / 0 で原寸 / F で全画面</span>
          <span className="ml-auto">
            ← → で移動（{index + 1} / {hasMore ? `${total}+` : total}）
          </span>
        </div>
      ) : (
        <div className="flex flex-none flex-col gap-2 border-t border-white/10 bg-black/55 px-4 py-3 text-white/85">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-white hover:bg-white/10"
              aria-label={playing ? '一時停止（Space）' : '再生（Space）'}
              title={playing ? '一時停止（Space）' : '再生（Space）'}
              onClick={togglePlay}
              disabled={bench || videoError}
            >
              {playing ? <Pause /> : <Play />}
            </Button>
            <span className="w-[86px] text-right text-xs tabular-nums">
              {secondsText(current)} / {secondsText(duration)}
            </span>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.1}
              value={clamp(current, 0, Math.max(duration, 0.1))}
              aria-label="再生位置"
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-[var(--brand)]"
              disabled={bench || videoError}
              onPointerMove={scrub.handlePointerMove}
              onPointerLeave={scrub.handlePointerLeave}
              onPointerCancel={scrub.handlePointerLeave}
              onChange={(event) => {
                const video = videoRef.current
                const value = Number(event.target.value)
                setCurrent(value)
                if (video) video.currentTime = value
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-white hover:bg-white/10"
              aria-label={muted ? 'ミュート解除' : 'ミュート'}
              title={muted ? 'ミュート解除' : 'ミュート'}
              onClick={() => {
                const video = videoRef.current
                const next = volumeAfterMuteToggle({ volume, muted })
                setMuted(next.muted)
                setVolume(next.volume)
                if (video) {
                  video.muted = next.muted
                  video.volume = next.volume
                }
                rememberPlayback(next.volume, next.muted)
              }}
            >
              {muted || volume === 0 ? <VolumeX /> : <Volume2 />}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              aria-label="音量"
              className="h-1.5 w-20 accent-[var(--brand)]"
              onChange={(event) => {
                const next = volumeAfterSlider(Number(event.target.value))
                setVolume(next.volume)
                setMuted(next.muted)
                const video = videoRef.current
                if (video) {
                  video.volume = next.volume
                  video.muted = next.muted
                }
                rememberPlayback(next.volume, next.muted)
              }}
            />
            <label className="flex items-center gap-1 text-xs">
              <span className="text-white/65">速度</span>
              <select
                className="h-7 rounded-md border border-white/20 bg-black/60 px-1 text-xs text-white"
                value={rate}
                aria-label="再生速度"
                onChange={(event) => {
                  const next = Number(event.target.value)
                  setRate(next)
                  const video = videoRef.current
                  if (video) video.playbackRate = next
                }}
              >
                {SPEEDS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}x
                  </option>
                ))}
              </select>
            </label>
            <span className="ml-auto text-xs text-white/60">
              Space 再生/停止 · ←→ ±5秒 · Shift+←→ 前後 · Esc 閉じる
            </span>
          </div>
        </div>
      )}

      {/* #73: 「この設定で再実行」の確認（ComfyUI のキューに入る） */}
      {confirmQueue && (
        <div
          className="fixed inset-0 z-[95] flex items-center justify-center bg-black/70 p-6"
          onClick={() => setConfirmQueue(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="comfy-confirm-title"
            className="w-full max-w-md rounded-[var(--radius-panel)] border border-white/15 bg-[var(--raised)] p-6 text-white shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="comfy-confirm-title" className="m-0 text-sm font-semibold">
              この設定で再実行しますか？
            </h2>
            <p className="mt-2 mb-0 text-xs leading-relaxed text-white/70">
              この画像の生成設定（API 形式のプロンプト）を{' '}
              <strong className="text-white">ComfyUI のキューに追加</strong>します。
              設定の URL（既定 http://127.0.0.1:8188）に接続できる必要があります。
            </p>
            <p className="mt-1 mb-0 text-xs leading-relaxed text-white/60">
              実行すると ComfyUI 側で生成が始まります。モデルや解像度によっては時間と負荷がかかります。
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setConfirmQueue(false)}>
                キャンセル
              </Button>
              <Button size="sm" onClick={() => void queuePrompt()} disabled={comfyBusy}>
                キューに追加
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** #60: 生成情報の1行。値をクリックするとコピーできる。 */
function MetaRow({
  label,
  value,
  multiline,
}: {
  label: string
  value: string | null
  multiline?: boolean
}) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <span className="w-16 flex-none text-white/60">{label}</span>
      <button
        type="button"
        title="クリックでコピー"
        onClick={() => void navigator.clipboard.writeText(value)}
        className={cn(
          'min-w-0 text-left text-white/85 hover:text-white',
          multiline ? 'line-clamp-3 whitespace-pre-wrap' : 'truncate',
        )}
      >
        {value}
      </button>
    </div>
  )
}
