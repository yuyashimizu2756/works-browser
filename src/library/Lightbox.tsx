import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Film,
  FolderOpen,
  Heart,
  ImageIcon,
  Info,
  Maximize,
  Minimize,
  MonitorPlay,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  Tag as TagIcon,
  Trash2,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { api } from '../api'
import type { FileSummary, WorkMark } from '../api'
import type { GenerationMeta } from '../api'
import { reinitializeAudioOutput } from '../lib/audioOutput'
import { formatBytes, formatDuration, formatShortDate, describeError } from '../lib/format'
import { fileAbsolutePath } from '../lib/path'
import { slideshowAction } from '../lib/lightbox'
import { matchesShortcut } from '../lib/shortcuts'
import { volumeAfterMuteToggle, volumeAfterSlider } from '../lib/volume'
import { readPlaybackPreference, rememberPlayback } from '../settings/playback'
import { canQueuePrompt, comfyActionFor } from './comfy'
import { imageSrc, mediaSrc } from './mediaSrc'
import { RatingStars } from './RatingStars'
import { emptyMark, notifyMarkChanged, notifyTagsChanged, tagData } from './tagData'
import { TagEditor } from './TagEditor'
import { useScrubPreview } from './useScrubPreview'
import { lightboxVisualFromUrl } from './visualLightbox'

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
  /** #8: お気に入り・評価・タグは作品単位。未指定ならその操作を出さない。 */
  workId?: number
  /** #8: ルートの実パス（「パスをコピー」用。ベンチでは null）。 */
  rootRealPath?: string | null
  /** #8: 「ゴミ箱へ」。確認と Undo は App の既存フローに任せる。 */
  onDeleteFile?: (file: FileSummary) => void
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SEEK_STEP = 5
const PRELOAD_RADIUS = 3
/** これ未満の位置は「最初から」とみなして保存しない。 */
const MIN_RESUME_MS = 3_000
/** 終端からこの距離まで来たら「見終わった」として位置を消す。 */
const END_GUARD_MS = 2_000
const SAVE_INTERVAL_MS = 5_000
/** #8: スライドショーの送り間隔（画像）。動画は再生完了で次へ。 */
const SLIDESHOW_INTERVAL_MS = 3_000
/** #8: 解除・コピーなどの短い通知を出しておく時間。 */
const NOTICE_MS = 3_000

/** #13: 通知の種類（色分け用）。音声の通知だけ既存の data 属性を残す。 */
type NoticeTone = 'info' | 'audio' | 'error'
type LightboxNotice = { id: number; message: string; tone: NoticeTone }

/** #8: ベンチ / スクショ用のサンプル生成情報（実ファイルが無いため）。 */
const BENCH_META: GenerationMeta = {
  prompt:
    '1girl, silver hair, blue eyes, night city, neon signs, cinematic lighting, looking at viewer, masterpiece, best quality',
  negative_prompt: 'lowres, bad anatomy, bad hands, text, watermark',
  model: 'sdxl_base_1.0',
  loras: ['detail_tweaker_v2', 'neon_night'],
  steps: '28',
  sampler: 'DPM++ 2M Karras',
  cfg: '5.5',
  seed: '1234567890',
  size: '1024x1024',
  raw: null,
  source: 'bench',
  workflow_json: null,
  api_prompt: null,
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function secondsText(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0:00'
  return formatDuration(Math.round(value * 1000))
}

/**
 * ライトボックス / プレイヤー（#5 / #8）。
 *
 * - 画像: `←` / `→` で移動、ホイールでズーム、`0` で原寸、`F` で全画面、`Esc` で閉じる
 * - 動画: `Space` 再生 / 停止、`←` / `→` ±5 秒、`Shift+←` / `→` 前後ファイル
 * - #8: 上部バー / `⋯` からお気に入り（`Shift+F`）・評価（`1`〜`5` / `Shift+0`）・
 *   タグ（`T`）・生成情報（`I`）・スライドショー（`S`）・フォルダ / パス / ゴミ箱
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
  workId,
  rootRealPath,
  onDeleteFile,
}: Props) {
  const file: FileSummary | undefined = files[index]
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  /** #16: メニューを閉じたあと、開いたボタンへフォーカスを戻す。 */
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  /** #8: `?lightboxMeta=1` などのスクショ用初期状態（ベンチのみ）。 */
  const visualLightbox = useMemo(() => (bench ? lightboxVisualFromUrl() : null), [bench])

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
  /** #12: ミュート解除（true → false）を 1 回だけ検出するための前回値。 */
  const wasMutedRef = useRef(muted)
  const [resumeMs, setResumeMs] = useState<number | null>(null)
  // #60: 生成メタデータ（プロンプト・モデル等）の表示
  const [metaOpen, setMetaOpen] = useState(visualLightbox?.meta ?? false)
  const [meta, setMeta] = useState<GenerationMeta | null>(null)
  const [metaLoading, setMetaLoading] = useState(false)
  // #73: ComfyUI 連携（workflow を開く / API 形式をコピー / この設定で再実行）
  const [comfyBusy, setComfyBusy] = useState(false)
  const [comfyNotice, setComfyNotice] = useState<string | null>(null)
  const [comfyError, setComfyError] = useState<string | null>(null)
  const [comfyJson, setComfyJson] = useState<string | null>(null)
  const [confirmQueue, setConfirmQueue] = useState(false)
  // #8: 作品単位のマーク（お気に入り・評価）とタグ編集
  const [mark, setMark] = useState<WorkMark | null>(null)
  const [markBusy, setMarkBusy] = useState(false)
  /** #13: マークの読み込みが終わるまでは操作させない（既存の評価を消さない）。 */
  const [markLoaded, setMarkLoaded] = useState(false)
  const [markError, setMarkError] = useState<string | null>(null)
  const [tagsOpen, setTagsOpen] = useState(false)
  // #8: `⋯` メニューとスライドショー、短い通知（音声・コピー）
  const [menuOpen, setMenuOpen] = useState(visualLightbox?.menu ?? false)
  const [slideshow, setSlideshow] = useState(visualLightbox?.slideshow ?? false)
  /**
   * #13 / #15: 通知は 1 本のキューにまとめる。音声・コピー・保存失敗が同時に
   * 起きても表示は常に 1 行（高さが変わらない）。
   */
  const [notices, setNotices] = useState<LightboxNotice[]>([])
  const noticeSeq = useRef(0)

  /**
   * #10: `<video>` に適用する値の「現在値」。`onLoadedMetadata` は React の
   * レンダー時点の値を閉じ込めず、必ずこの ref を読む（メタデータ到着が
   * ミュート解除より後になっても解除が巻き戻らない）。
   */
  const volumeRef = useRef(volume)
  const mutedRef = useRef(muted)
  const rateRef = useRef(rate)
  const shieldedRef = useRef(shielded)
  volumeRef.current = volume
  mutedRef.current = muted
  rateRef.current = rate
  shieldedRef.current = shielded

  /** 保存用のスナップショット（アンマウント時に video 要素が無くても保存できる）。 */
  const snapshot = useRef<{ fileId: number | null; positionMs: number; durationMs: number | null }>(
    { fileId: null, positionMs: 0, durationMs: null },
  )
  const lastSavedAt = useRef(0)
  const pendingSeekMs = useRef<number | null>(null)
  const panDrag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null)
  /** #22: シールド前の再生状態（復帰時に戻す）。 */
  const shieldWasPlaying = useRef(false)

  // #13: マークの読み込み世代 / 書き込み世代。書き込み開始後に届いた GET は捨てる。
  const markLoadSeq = useRef(0)
  const markWriteSeq = useRef(0)
  /** 最後にサーバーへ保存できた値（失敗時のロールバック先）。 */
  const confirmedMark = useRef<WorkMark | null>(null)
  const workIdRef = useRef(workId)
  workIdRef.current = workId

  const fileKind = file?.kind
  const fileId = file?.id ?? null
  const direct = file ? mediaSrc(file.id) : null
  const absolutePath = useMemo(
    () => (file ? fileAbsolutePath(rootRealPath, file.rel_path) : null),
    [file, rootRealPath],
  )

  // #47: プレビュー専用の `<video>`（本体とは別要素・ミュート固定）。
  // ベンチ / シールド / 再生エラー中は出さない。ファイルが変われば破棄される。
  const scrubEnabled = fileKind === 'video' && !bench && !shielded && !videoError
  const scrub = useScrubPreview({ enabled: scrubEnabled, duration, fileKey: fileId })

  /**
   * #10: `<video>` の実プロパティを状態から 1 箇所で反映する。
   * デバッグ用に、**実際に反映された値**を `data-video-muted` / `data-video-volume`
   * へ読み戻す（テスト・実機確認用）。
   */
  const applyVideoState = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volumeRef.current
    video.muted = shieldedRef.current ? true : mutedRef.current
    video.playbackRate = rateRef.current
    video.dataset.videoMuted = String(video.muted)
    video.dataset.videoVolume = video.volume.toFixed(2)
  }, [])

  // #10: 音量・ミュート・速度・シールドの変更はこの 1 本だけで `<video>` に反映する。
  useEffect(() => {
    applyVideoState()
  }, [applyVideoState, volume, muted, rate, shielded, fileId])

  /**
   * #12: ミュート解除（`muted: true → false`）では、WebView2 の音声出力が
   * 初期化されないまま無音になることがある。状態を反映する上の effect の後に、
   * 再生中なら `play()` をやり直し、`pause()` → `play()` のフォールバックを
   * 1 回だけ行う。停止中・シールド中は勝手に再生しないので何もしない。
   */
  useEffect(() => {
    const wasMuted = wasMutedRef.current
    wasMutedRef.current = muted
    if (!wasMuted || muted) return
    const video = videoRef.current
    if (!video || bench || shieldedRef.current) return
    reinitializeAudioOutput(video)
  }, [bench, muted])

  // #10: WebView2 側で `volume` が変わっても data 属性が実値に追随するようにする。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onVolumeChange = () => {
      video.dataset.videoMuted = String(video.muted)
      video.dataset.videoVolume = video.volume.toFixed(2)
    }
    video.addEventListener('volumechange', onVolumeChange)
    return () => video.removeEventListener('volumechange', onVolumeChange)
  }, [fileId, fileKind])

  /** #13: 通知をキューへ積む（1 本ずつ表示するので高さは常に同じ）。 */
  const pushNotice = useCallback((message: string, tone: NoticeTone = 'info') => {
    noticeSeq.current += 1
    const next: LightboxNotice = { id: noticeSeq.current, message, tone }
    setNotices((queue) => [...queue, next])
  }, [])

  const showNotice = useCallback(
    (message: string) => {
      pushNotice(message)
    },
    [pushNotice],
  )

  // 先頭の通知を一定時間で消す（次があれば続けて表示する）
  const currentNotice = notices[0] ?? null
  useEffect(() => {
    if (!currentNotice) return
    const timer = window.setTimeout(() => setNotices((queue) => queue.slice(1)), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [currentNotice])

  // #8 / #13: 作品のマーク（お気に入り・評価）を読む。
  // 読み込みが終わるまでは操作させず、書き込み開始後に届いた応答は捨てる。
  useEffect(() => {
    markLoadSeq.current += 1
    const generation = markLoadSeq.current
    if (workId === undefined) {
      setMark(null)
      setMarkLoaded(false)
      setMarkError(null)
      confirmedMark.current = null
      return
    }
    const writeAtStart = markWriteSeq.current
    setMark(emptyMark(workId))
    setMarkLoaded(false)
    setMarkError(null)
    confirmedMark.current = null
    void tagData()
      .getWorkMark(workId)
      .then((next) => {
        if (generation !== markLoadSeq.current) return
        // 書き込みが始まった後に届いた GET は、古い値で UI を巻き戻すので捨てる
        if (markWriteSeq.current !== writeAtStart) return
        confirmedMark.current = next
        setMark(next)
        setMarkLoaded(true)
      })
      .catch((cause: unknown) => {
        if (generation !== markLoadSeq.current) return
        // 読めないまま操作させない（見ているだけなら続行できる）
        setMarkLoaded(false)
        setMarkError(describeError(cause))
      })
    return () => {
      markLoadSeq.current += 1
    }
  }, [workId])


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
  // ミュートの実値は #10 の `applyVideoState` が `shielded` から決める。
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (shielded) {
      shieldWasPlaying.current = video.dataset.shieldWasPlaying === '1'
      video.pause()
      return
    }
    if (shieldWasPlaying.current) {
      void video.play().catch(() => undefined)
      shieldWasPlaying.current = false
    }
  }, [shielded, applyVideoState])

  // #60: パネルを開いたときにだけ生成情報を抽出する（走査時には読まない）
  useEffect(() => {
    if (!metaOpen || !file) return
    if (bench) {
      // ベンチは合成データなのでサンプルを出す（スクショ / デザイン確認用）
      setMeta(BENCH_META)
      setMetaLoading(false)
      return
    }
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
  }, [bench, metaOpen, file])

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

  const seekBy = useCallback((seconds: number) => {
    const video = videoRef.current
    if (!video) return
    const max = Number.isFinite(video.duration) ? video.duration : 0
    video.currentTime = clamp(video.currentTime + seconds, 0, Math.max(0, max))
  }, [])

  const toggleFullscreen = useCallback(() => {
    const element = containerRef.current
    if (!element) return
    if (document.fullscreenElement) {
      void document.exitFullscreen?.()?.catch?.(() => undefined)
    } else {
      void element.requestFullscreen?.()?.catch?.(() => undefined)
    }
  }, [])

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // ---------------------------------------------------------------------------
  // #8: お気に入り・評価・タグ・メタ・スライドショー・メニュー
  // ---------------------------------------------------------------------------

  /**
   * #13: 作品マークを 1 項目だけ変えて即保存する（評価・お気に入りは作品単位）。
   *
   * - 読み込み完了までは呼ばない（`markLoaded` で入口を閉じる）
   * - 楽観更新し、**最新の書き込み**の応答だけを反映する（連打で巻き戻らない）
   * - 失敗したら最後に保存できた値へ戻して通知する
   */
  const changeMark = useCallback(
    (next: { favorite: boolean; rating: number | null }, successMessage?: string) => {
      const current = mark
      if (workId === undefined || !markLoaded || !current) return
      const forWork = workId
      // 同じ作品を見ている間だけ。別作品の遅延応答は無視する
      const seq = markWriteSeq.current + 1
      markWriteSeq.current = seq
      const fallback = confirmedMark.current ?? current
      setMarkBusy(true)
      setMark({ ...current, ...next })
      void tagData()
        .setWorkMark(forWork, {
          favorite: next.favorite,
          rating: next.rating,
          note: current.note ?? null,
        })
        .then((saved) => {
          if (workIdRef.current !== forWork) return
          confirmedMark.current = saved
          if (seq !== markWriteSeq.current) return
          setMark(saved)
          if (successMessage) pushNotice(successMessage)
          // 詳細ヘッダ（WorkMarksBar）とライブラリの評価フィルタへ知らせる
          notifyMarkChanged(forWork)
          notifyTagsChanged()
        })
        .catch((cause: unknown) => {
          if (workIdRef.current !== forWork || seq !== markWriteSeq.current) return
          // #13: 楽観更新を戻す（既存の評価を消したままにしない）
          setMark(fallback)
          pushNotice(`保存できませんでした: ${describeError(cause)}`, 'error')
        })
        .finally(() => {
          if (workIdRef.current !== forWork || seq !== markWriteSeq.current) return
          setMarkBusy(false)
        })
    },
    [mark, markLoaded, pushNotice, workId],
  )

  const toggleFavorite = useCallback(() => {
    if (!mark || !markLoaded) return
    changeMark(
      { favorite: !mark.favorite, rating: mark.rating },
      mark.favorite ? 'お気に入りから外しました' : 'お気に入りに追加しました',
    )
  }, [changeMark, mark, markLoaded])

  const applyRating = useCallback(
    (rating: number | null) => {
      if (!mark || !markLoaded) return
      changeMark(
        { favorite: mark.favorite, rating },
        rating === null ? '未評価に戻しました' : `★${rating} に評価しました`,
      )
    },
    [changeMark, mark, markLoaded],
  )

  /** #10: ミュート解除時は音量 0 なら既定音量まで上げる（`volumeAfterMuteToggle`）。 */
  const toggleMute = useCallback(() => {
    const next = volumeAfterMuteToggle({ volume, muted })
    setVolume(next.volume)
    setMuted(next.muted)
    rememberPlayback(next.volume, next.muted)
    if (next.muted) {
      pushNotice('ミュートにしました', 'audio')
      return
    }
    if (next.volume <= 0) {
      pushNotice('音量が 0 のため音が出ません。音量スライダーで上げてください', 'audio')
    } else {
      pushNotice(
        `音声を有効化しました（音量 ${Math.round(next.volume * 100)}%）`,
        'audio',
      )
    }
  }, [muted, pushNotice, volume])

  const changeVolume = useCallback((value: number) => {
    const next = volumeAfterSlider(value)
    setVolume(next.volume)
    setMuted(next.muted)
    rememberPlayback(next.volume, next.muted)
  }, [])

  const toggleSlideshow = useCallback(() => {
    const next = !slideshow
    setSlideshow(next)
    if (next) {
      showNotice('スライドショーを開始しました（S で停止）')
      const video = videoRef.current
      if (video && video.paused) void video.play().catch(() => undefined)
    } else {
      showNotice('スライドショーを停止しました')
    }
  }, [slideshow, showNotice])

  /**
   * #16: スライドショーの 1 ステップ。画像の 3 秒送りと動画の再生完了で同じ判定を使う。
   * 終端では停止し、`hasMore` のあいだは追加読み込みし、読み込み中は待つ。
   */
  const advanceSlideshow = useCallback(() => {
    const action = slideshowAction({
      index,
      count: files.length,
      hasMore,
      loadingMore,
    })
    if (action === 'next') goNext()
    else if (action === 'load-more') onRequestMore()
    else if (action === 'stop') setSlideshow(false)
  }, [files.length, goNext, hasMore, index, loadingMore, onRequestMore])

  // #8 / #16: スライドショー（画像は 3 秒で次へ。動画は onEnded が担当する）
  useEffect(() => {
    if (!slideshow || fileKind !== 'image') return
    const timer = window.setTimeout(advanceSlideshow, SLIDESHOW_INTERVAL_MS)
    return () => window.clearTimeout(timer)
  }, [advanceSlideshow, fileKind, slideshow])

  /** #8: `⋯` の「フォルダで開く」。 */
  const revealInFolder = useCallback(() => {
    setMenuOpen(false)
    if (!file) return
    if (bench) {
      showNotice('ベンチモードではエクスプローラを開けません')
      return
    }
    void api
      .revealFile(file.id)
      .then(() => showNotice('エクスプローラでファイルを選択しました'))
      .catch((cause: unknown) => showNotice(describeError(cause)))
  }, [bench, file, showNotice])

  /** #8: `⋯` の「パスをコピー」。相対パスはルートの実パスと繋いで渡す。 */
  const copyPath = useCallback(() => {
    setMenuOpen(false)
    if (!absolutePath) {
      showNotice('パスを取得できませんでした')
      return
    }
    void navigator.clipboard
      .writeText(absolutePath)
      .then(() => showNotice('パスをコピーしました'))
      .catch(() => showNotice('クリップボードにコピーできませんでした'))
  }, [absolutePath, showNotice])

  /** #8: `⋯` の「ゴミ箱へ」。確認 + Undo は App の既存フロー。 */
  const requestDelete = useCallback(() => {
    setMenuOpen(false)
    if (!file) return
    if (!onDeleteFile) {
      showNotice('この画面からは削除できません')
      return
    }
    onDeleteFile(file)
  }, [file, onDeleteFile, showNotice])

  // `⋯` メニューは外側クリックで閉じる（Esc は下のキー処理が 1 段だけ閉じる）。
  // #16: どちらで閉じても、開いたボタンへフォーカスを戻す。
  useEffect(() => {
    if (!menuOpen) return
    const closeMenu = () => {
      setMenuOpen(false)
      menuTriggerRef.current?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      closeMenu()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [menuOpen])

  // キーボード（capture で作品詳細の Esc = 戻るより先に処理する）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // #22: シールド中は下の画面を動かさない（解除後に元の状態へ戻す）
      if (shielded) return
      // #5: ショートカット一覧（?）が開いている間は、Esc をヘルプへ渡して
      // ライトボックスは閉じない（1 段ずつ閉じる）。他のキーも下へ流さない。
      if (document.querySelector('[data-shortcuts-dialog]')) return
      // #8: タグ編集（Radix のダイアログ）が開いている間は、Esc をそちらへ渡す
      if (document.querySelector('[data-tag-editor]')) return
      // #73: 再実行の確認中は Esc でダイアログだけを閉じる
      if (confirmQueue) {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setConfirmQueue(false)
        }
        return
      }
      // #8: `⋯` メニューが開いていれば Esc はメニューだけを閉じる
      if (menuOpen && event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setMenuOpen(false)
        // #16: 閉じたあとは開いたボタンへ戻す（キーボードだけで往復できる）
        menuTriggerRef.current?.focus()
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

      // #8: ライトボックスからの操作。修飾キー付きの既存操作（Alt+← など）は
      // ここで奪わない（`matchesShortcut` が Ctrl / Alt / Meta を見る）。
      if (!event.ctrlKey && !event.altKey && !event.metaKey) {
        // #13: 長押し（自動リピート）で評価を連打しない。読み込み前も反応しない。
        if (matchesShortcut('detail-favorite', event)) {
          event.preventDefault()
          if (!event.repeat && markLoaded) toggleFavorite()
          return
        }
        if (matchesShortcut('detail-rate', event)) {
          event.preventDefault()
          if (!event.repeat && markLoaded) applyRating(Number(event.key))
          return
        }
        if (matchesShortcut('detail-unrated', event)) {
          event.preventDefault()
          if (!event.repeat && markLoaded) applyRating(null)
          return
        }
        if (matchesShortcut('detail-tags', event)) {
          event.preventDefault()
          if (workId !== undefined) setTagsOpen(true)
          return
        }
        if (matchesShortcut('detail-meta', event)) {
          event.preventDefault()
          setMetaOpen((open) => !open)
          return
        }
        if (matchesShortcut('detail-slideshow', event)) {
          event.preventDefault()
          toggleSlideshow()
          return
        }
        if (matchesShortcut('detail-trash', event)) {
          event.preventDefault()
          requestDelete()
          return
        }
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
  }, [
    applyRating,
    close,
    confirmQueue,
    fileKind,
    goNext,
    goPrev,
    markLoaded,
    menuOpen,
    requestDelete,
    seekBy,
    shielded,
    toggleFavorite,
    toggleFullscreen,
    togglePlay,
    toggleSlideshow,
    workId,
  ])

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
  const favorite = mark?.favorite ?? false
  const rating = mark?.rating ?? null
  // #13: 読み込みが終わるまでは「まだ分からない」ので操作させない
  const markReady = mark !== null && markLoaded
  const markHint = markReady
    ? undefined
    : markError
      ? `評価を読み込めませんでした（${markError}）`
      : '評価を読み込んでいます…'

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${file.name} のプレビュー`}
      data-lightbox
      data-file-id={file.id}
      data-shielded={shielded ? 'true' : undefined}
      data-slideshow={slideshow ? 'true' : 'false'}
      className={cn(
        'fixed inset-0 z-[80] flex select-none flex-col bg-black/92 text-white backdrop-blur-sm',
        shielded && 'hidden',
      )}
    >
      {/* 上部バー */}
      <div
        data-lightbox-topbar
        className="flex h-12 flex-none items-center gap-1.5 border-b border-white/10 bg-black/40 px-4 py-2"
      >
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
            <ImageIcon className="size-4 flex-none text-[var(--brand)]" aria-hidden="true" />
          ) : (
            <Film className="size-4 flex-none text-[var(--brand)]" aria-hidden="true" />
          )}
          <span className="truncate text-sm font-semibold">{file.name}</span>
        </span>
        <div className="ml-auto flex min-w-0 flex-none items-center gap-1.5">
          {/* #15: 位置（N / 全体）は幅 800 でも常に見える。サイズ・日付は広い画面だけ。 */}
          <span
            className="flex flex-none items-center gap-2 text-xs text-white/65 tabular-nums"
            data-lightbox-position
          >
            <span>
              {index + 1} / {hasMore ? `${total}+` : total}
            </span>
            <span
              className="hidden items-center gap-2 xl:flex"
              data-lightbox-file-meta
            >
              <span aria-hidden="true">·</span>
              <span>{formatBytes(file.bytes)}</span>
              <span aria-hidden="true">·</span>
              <span>{formatShortDate(file.mtime)}</span>
            </span>
          </span>

          {/* #8: お気に入り・評価（作品単位） */}
          {workId !== undefined && (
            <span
              className="flex flex-none items-center gap-1 rounded-full border border-white/12 bg-black/30 px-1.5 py-0.5"
              data-lightbox-marks
              data-lightbox-favorite={favorite ? 'true' : 'false'}
              data-lightbox-rating={rating ?? ''}
              data-lightbox-marks-loaded={markReady ? 'true' : 'false'}
              title={markHint}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(
                  'text-white/80 hover:bg-white/10',
                  favorite && 'text-[var(--highlight)]',
                )}
                aria-label={
                  markReady
                    ? favorite
                      ? 'お気に入りから外す（Shift+F）'
                      : 'お気に入りに追加（Shift+F）'
                    : markHint
                }
                aria-pressed={favorite}
                title={
                  markReady
                    ? favorite
                      ? 'お気に入りから外す（Shift+F）'
                      : 'お気に入りに追加（Shift+F）'
                    : markHint
                }
                disabled={!markReady || markBusy}
                data-lightbox-favorite-toggle
                onClick={toggleFavorite}
              >
                <Heart className={cn(favorite && 'fill-current')} aria-hidden="true" />
              </Button>
              <RatingStars
                favorite={favorite}
                rating={rating}
                onChange={(next) => changeMark({ favorite: next.favorite, rating: next.rating })}
                disabled={!markReady || markBusy}
                showFavorite={false}
                showLabel={false}
                unratedClassName="text-white/60"
              />
              <span
                className="w-7 flex-none text-center text-xs text-white/65 tabular-nums"
                aria-live="polite"
              >
                {rating === null ? '—' : `${rating}/5`}
              </span>
            </span>
          )}

        <Button
          variant="ghost"
          size="icon-sm"
          className="flex-none text-white hover:bg-white/10"
          aria-label="タグを編集（T）"
          title="タグを編集（T）"
          disabled={workId === undefined}
          data-lightbox-tags
          onClick={() => setTagsOpen(true)}
        >
          <TagIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="flex-none text-white hover:bg-white/10"
          aria-label="生成情報（I）"
          aria-pressed={metaOpen}
          title="生成情報（プロンプト・モデル・シード）（I）"
          data-lightbox-meta
          onClick={() => setMetaOpen((open) => !open)}
        >
          <Info />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="flex-none text-white hover:bg-white/10"
          aria-label={isFullscreen ? '全画面を解除（F）' : '全画面（F）'}
          title={isFullscreen ? '全画面を解除（F）' : '全画面（F）'}
          data-lightbox-fullscreen
          onClick={toggleFullscreen}
        >
          {isFullscreen ? <Minimize /> : <Maximize />}
        </Button>

        {/* #8: `⋯`（フォルダで開く / パスをコピー / ゴミ箱へ） */}
        <div ref={menuRef} className="relative flex-none">
          <Button
            ref={menuTriggerRef}
            variant="ghost"
            size="icon-sm"
            className="text-white hover:bg-white/10"
            aria-label="その他の操作"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            title="その他の操作"
            data-lightbox-menu-trigger
            onClick={() => setMenuOpen((open) => !open)}
          >
            <MoreHorizontal />
          </Button>
          {menuOpen && (
            <div
              role="menu"
              aria-label="その他の操作"
              data-lightbox-menu
              className="absolute top-[calc(100%+8px)] right-0 z-[90] w-60 origin-top-right rounded-[var(--radius-panel)] border border-white/15 bg-[var(--raised)] p-1.5 text-[13px] text-white shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
            >
              <MenuItem
                icon={<FolderOpen className="size-3.5" aria-hidden="true" />}
                label="フォルダで開く"
                dataAttr="data-lightbox-reveal"
                onClick={revealInFolder}
              />
              <MenuItem
                icon={<Copy className="size-3.5" aria-hidden="true" />}
                label="パスをコピー"
                title={absolutePath ?? 'パスを取得できません'}
                disabled={!absolutePath}
                dataAttr="data-lightbox-copy-path"
                onClick={copyPath}
              />
              <div className="my-1 h-px bg-white/10" role="separator" />
              <MenuItem
                icon={<Trash2 className="size-3.5" aria-hidden="true" />}
                label="ゴミ箱へ"
                hint="Delete"
                tone="danger"
                disabled={!onDeleteFile}
                dataAttr="data-lightbox-trash"
                onClick={requestDelete}
              />
            </div>
          )}
        </div>
        </div>
      </div>

      {/*
        #13 / #15: 音声・コピー・保存失敗の通知は 1 本のキュー。
        同時に起きても表示は 1 行（h-7 固定）なので高さが変わらない。
      */}
      {currentNotice && (
        <p
          className={cn(
            'm-0 flex h-7 flex-none items-center border-b border-white/10 bg-black/55 px-4 text-xs',
            currentNotice.tone === 'audio' && 'text-[var(--brand)]',
            currentNotice.tone === 'error' && 'text-[var(--destructive)]',
            currentNotice.tone === 'info' && 'text-white/85',
          )}
          role="status"
          data-lightbox-notice
          data-lightbox-notice-tone={currentNotice.tone}
          {...(currentNotice.tone === 'audio'
            ? { 'data-lightbox-audio-notice': 'true' }
            : {})}
        >
          {currentNotice.message}
        </p>
      )}

      {/* #60: 生成情報パネル（プロンプト・モデル・シード等） */}
      {metaOpen && (
        <div
          data-meta-panel
          className="max-h-[42vh] flex-none overflow-y-auto border-b border-white/10 bg-black/70 px-4 py-3 text-xs"
        >
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
              // #10: メタデータ到着時も「いまの状態」（ref）を適用する。
              // 解除操作より後に届いても、解除を巻き戻さない。
              applyVideoState()
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
              if (!shieldedRef.current) void video.play().catch(() => undefined)
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
              // #8 / #16: スライドショー中は動画の再生完了で次へ（終端なら停止）
              if (!slideshow) return
              advanceSlideshow()
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

        {slideshow && (
          <span
            className="absolute top-2 right-2 flex items-center gap-1.5 rounded-full border border-white/15 bg-black/70 px-3 py-1 text-xs text-white/85 backdrop-blur-sm"
            data-lightbox-slideshow-indicator
          >
            <MonitorPlay className="size-3.5" aria-hidden="true" />
            スライドショー中
            {fileKind === 'image' ? ` · 3 秒` : ' · 再生完了で次へ'}
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
          {/* #15: スライドショーのボタンは下部バーに 1 つだけ（画像でも使える） */}
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              'flex-none text-white hover:bg-white/10',
              slideshow && 'bg-white/15 text-[var(--brand)]',
            )}
            aria-label={slideshow ? 'スライドショーを停止（S）' : 'スライドショー（S）'}
            aria-pressed={slideshow}
            title={slideshow ? 'スライドショーを停止（S）' : 'スライドショー（S）'}
            data-lightbox-slideshow-bar
            onClick={toggleSlideshow}
          >
            <MonitorPlay />
          </Button>
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
              data-lightbox-mute
              onClick={toggleMute}
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
              onChange={(event) => changeVolume(Number(event.target.value))}
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
                }}
              >
                {SPEEDS.map((speed) => (
                  <option key={speed} value={speed}>
                    {speed}x
                  </option>
                ))}
              </select>
            </label>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn(
                'text-white hover:bg-white/10',
                slideshow && 'bg-white/15 text-[var(--brand)]',
              )}
              aria-label={slideshow ? 'スライドショーを停止（S）' : 'スライドショー（S）'}
              aria-pressed={slideshow}
              title={slideshow ? 'スライドショーを停止（S）' : 'スライドショー（S）'}
              data-lightbox-slideshow-bar
              onClick={toggleSlideshow}
            >
              <MonitorPlay />
            </Button>
            {/* #15: 動画のキー案内（画像は上のズーム案内のまま） */}
            <span
              className="ml-auto hidden text-xs text-white/60 xl:block"
              data-lightbox-key-hint
            >
              Space 再生 / ←→ ±5秒 / Shift+←→ 前後 / Esc 閉じる
            </span>
          </div>
        </div>
      )}

      {/* #8: タグ編集（既存の TagEditor をライトボックスの上に出す） */}
      {workId !== undefined && (
        <TagEditor
          open={tagsOpen}
          onOpenChange={setTagsOpen}
          workIds={[workId]}
          overlayClassName="z-[100]"
          contentClassName="z-[101]"
          onChanged={() => {
            notifyTagsChanged()
            showNotice('タグを更新しました')
          }}
        />
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

/** #8: `⋯` メニューの 1 行。 */
function MenuItem({
  icon,
  label,
  hint,
  title,
  tone,
  disabled = false,
  dataAttr,
  onClick,
}: {
  icon: ReactNode
  label: string
  hint?: string
  title?: string
  tone?: 'danger'
  disabled?: boolean
  dataAttr?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      title={title ?? hint ?? label}
      {...(dataAttr ? { [dataAttr]: 'true' } : {})}
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2 rounded-[6px] px-2 text-left text-[13px] transition-colors hover:bg-white/10 disabled:pointer-events-none disabled:opacity-45',
        tone === 'danger' ? 'text-[var(--destructive)]' : 'text-white',
      )}
    >
      <span className={cn('flex-none', tone === 'danger' ? 'text-current' : 'text-white/65')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="flex-none text-xs text-white/45">{hint}</span>}
    </button>
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
