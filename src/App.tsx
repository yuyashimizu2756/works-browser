import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { listen } from '@tauri-apps/api/event'
import { CopyCheck, FolderPlus, FolderSearch, RotateCw, Shield, X } from 'lucide-react'
import { BrandMark } from '@/components/BrandMark'
import { ThumbStatus } from '@/components/ThumbStatus'
import { ToastStack, pushToast, removeToast, updateToast } from '@/components/ToastStack'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { api } from './api'
import type {
  DeleteProgress,
  DeleteResult,
  FileSummary,
  LibraryStats,
  Root,
  RootInfo,
  ScanProgress,
  ScanSummary,
  WorkSummary,
} from './api'
import type { NavRoute } from './lib/navStack'
import { useMouseNavButtons } from './lib/useMouseNavButtons'
import { useNavStack } from './lib/useNavStack'
import {
  benchCountFromUrl,
  benchDetailFromUrl,
  benchWorkSummary,
  createBenchFileSource,
  createBenchRoots,
  createBenchSource,
  createBenchWorkFileSource,
  demoModeFromUrl,
} from './library/bench'
import {
  EMPTY_SEARCH_QUERY,
  emptyPreviewFromUrl,
  initialSearchFromUrl,
} from './lib/emptyState'
import { buildRootAccentMap, rootAccentFor } from './library/accents'
import type { DeleteIntent, DeleteRequest } from './library/DeleteFlow'
import { LibraryView } from './library/LibraryView'
import type { LibraryFilters } from './library/libraryFilters'
import { ThumbnailToggle } from './library/Toolbar'
import { loadPreferences, readLocalPreferences, savePreferences } from './library/preferences'
import { pickFolders } from './library/rootPicker'
import type { PendingRoots } from './library/rootPicker'
import { useFolderDrop } from './library/useFolderDrop'
import { ShortcutsHelp } from './library/ShortcutsHelp'
import { SettingsLauncher } from './settings/SettingsLauncher'
import {
  RevealedFilesContext,
  toggleRevealedFile as toggleReveal,
  toggleRevealedWork as toggleRevealWork,
} from './library/revealedFiles'
import { useThumbnailVisible } from './library/useThumbnailVisible'
import { ShieldOverlay } from './library/shield/ShieldOverlay'
import type { ShieldSettings } from './library/shield/settings'
import { DEFAULT_SHIELD_SETTINGS, normalizeShieldSettings } from './library/shield/settings'
import { usePrivacyShield } from './library/shield/usePrivacyShield'
import type { LibraryViewMode } from './lib/viewMode'
import {
  initialShieldFromUrl,
  initialThumbnailsFromUrl,
  initialViewModeFromUrl,
  THUMBNAIL_SHORTCUT,
} from './lib/viewMode'
import { describeError, formatBytes, formatCount, formatDate, formatShortDate } from './lib/format'

/** #49: シールド設定ダイアログは初回クリックまで読み込まない。 */
const ShieldSettingsDialog = lazy(() =>
  import('./library/shield/ShieldSettingsDialog').then((module) => ({
    default: module.ShieldSettingsDialog,
  })),
)

/**
 * #49: ライブラリ以外の画面・ダイアログは、必要になったときだけ読み込む。
 * 初期表示（作品グリッド）に不要なコードを初期チャンクから外す。
 */
const WorkDetail = lazy(() =>
  import('./library/WorkDetail').then((module) => ({ default: module.WorkDetail })),
)
const RootsDrawer = lazy(() =>
  import('./library/RootsDrawer').then((module) => ({ default: module.RootsDrawer })),
)
const DeleteConfirmDialog = lazy(() =>
  import('./library/DeleteFlow').then((module) => ({ default: module.DeleteConfirmDialog })),
)
const DeleteReportDialog = lazy(() =>
  import('./library/DeleteFlow').then((module) => ({ default: module.DeleteReportDialog })),
)
const UndoToast = lazy(() =>
  import('./library/DeleteFlow').then((module) => ({ default: module.UndoToast })),
)
/** #67: 重複・類似の整理ダイアログも必要時のみ読み込む。 */
const DupesDialog = lazy(() =>
  import('./library/DupesDialog').then((module) => ({ default: module.DupesDialog })),
)

type SelectedWork = {
  work: WorkSummary
  rootLabel: string
  accent: string
  /** ファイルモードから開いたときの開始ファイル（#5 のプレビュー用）。 */
  startFile?: { id: number; name: string }
}

/**
 * #33: ライブラリへ戻ったときに復元する状態（スクロール位置と選択）。
 * #120: 絞り込み（ルート・検索・種類・タグ・評価・並び順）も一緒に控える。
 */
type LibrarySnapshot = {
  scrollTop: number
  selection: WorkSummary[]
  filters?: LibraryFilters
}

export default function App() {
  // #97: `?bench=N&demo=1` のデザイン検証モード。画像はこのフラグが立ったときだけ
  // 動的 import + `<img>` で取得し、通常起動では読み込まない。
  const demoMode = useMemo(() => demoModeFromUrl(), [])
  // ベンチ用の URL 指定（`?mode=files` / `?thumbs=hidden`）は保存値より優先する
  const forcedMode = useMemo(() => initialViewModeFromUrl(), [])
  // #97: デモモードはサムネイル表示から始める（明示の `?thumbs=hidden` が優先）。
  // ヘッダーの目アイコン / `Ctrl+Shift+H` で画像あり・なしを切り替えられる。
  const forcedThumbnails = useMemo(
    () => initialThumbnailsFromUrl() ?? (demoMode ? true : null),
    [demoMode],
  )
  const forcedShield = useMemo(() => initialShieldFromUrl(), [])
  // 起動直後のちらつきを避けるため、localStorage の写しを同期の初期値にする
  const localPreferences = useMemo(() => readLocalPreferences(), [])

  // `?bench=10000` で Tauri を使わず合成データを表示する（性能計測用）
  const benchCount = useMemo(() => benchCountFromUrl(), [])
  const bench = benchCount !== null
  const benchDetailId = useMemo(() => benchDetailFromUrl(), [])
  /** #100: `?empty=` は空状態のショット用（ベンチ時だけ意味を持つ）。 */
  const emptyPreview = useMemo(() => emptyPreviewFromUrl(), [])
  /**
   * #100: 空状態のショットでは作品カードのルートに対応する合成ルートを並べる
   * （「ルートが無い」を見るときだけ空のまま）。
   */
  const benchRoots = useMemo(
    () =>
      emptyPreview !== null && emptyPreview !== 'roots' && benchCount !== null
        ? createBenchRoots(benchCount)
        : [],
    [benchCount, emptyPreview],
  )
  const initialSearch = useMemo(
    () =>
      emptyPreview === 'search' ? EMPTY_SEARCH_QUERY : initialSearchFromUrl(),
    [emptyPreview],
  )
  // #97: デモ画像の URL 一覧。`?demo=1` 以外では null のまま。
  const [demoImages, setDemoImages] = useState<readonly string[] | null>(null)
  useEffect(() => {
    if (!demoMode || benchCount === null) return
    let alive = true
    void import('./library/demo')
      .then((module) => {
        if (alive) setDemoImages(module.demoImageUrls())
      })
      .catch(() => {
        // 画像が読めなくても従来のプレースホルダで表示できる
      })
    return () => {
      alive = false
    }
  }, [benchCount, demoMode])
  const benchSource = useMemo(
    () =>
      benchCount === null ? undefined : createBenchSource(benchCount, demoImages),
    [benchCount, demoImages],
  )

  const [roots, setRoots] = useState<RootInfo[]>([])
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [scanningRoot, setScanningRoot] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [rootsOpen, setRootsOpen] = useState(false)
  /** #49: 一度でも開いたらマウントしたままにする（走査ルートのドロワー）。 */
  const [rootsLoaded, setRootsLoaded] = useState(false)
  // #15: 削除の確認 → 実行 → 結果 / Undo の流れ。
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteProgress, setDeleteProgress] = useState<DeleteProgress | null>(null)
  const [deleteReport, setDeleteReport] = useState<DeleteResult | null>(null)
  const [selectionResetToken, setSelectionResetToken] = useState(0)
  const [undo, setUndo] = useState<{ id: string; count: number } | null>(null)
  const [undoBusy, setUndoBusy] = useState(false)
  const benchDeleteCancel = useRef(false)
  const [selected, setSelected] = useState<SelectedWork | null>(() => {
    if (benchCount === null || benchDetailId === null) return null
    const work = benchWorkSummary(benchDetailId, benchCount)
    return {
      work,
      rootLabel: 'ベンチ',
      accent: rootAccentFor(new Map(), work.root_id),
    }
  })
  // #33: 画面階層（ライブラリ → 作品詳細 → ライトボックス）は履歴スタックを唯一の状態にする
  const initialRoute = useMemo<NavRoute>(
    () =>
      benchDetailId === null
        ? { kind: 'library' }
        : { kind: 'work', workId: benchDetailId },
    [benchDetailId],
  )
  const {
    route,
    snapshot: routeSnapshot,
    push,
    back,
    forward,
    replace,
  } = useNavStack<LibrarySnapshot>(initialRoute)
  // ライブラリの選択は LibraryView が持つため、離脱時に控えられるよう最新値を ref に写す
  const librarySelectionRef = useRef<WorkSummary[]>([])
  const handleSelectionChange = useCallback((works: WorkSummary[]) => {
    librarySelectionRef.current = works
  }, [])
  // #120: 絞り込みも同じ理由で ref に写す（詳細から戻ったときの初期値になる）
  const libraryFiltersRef = useRef<LibraryFilters | null>(null)
  const handleLibraryFiltersChange = useCallback((filters: LibraryFilters) => {
    libraryFiltersRef.current = filters
  }, [])
  // #25: ダイアログ / ドラッグ&ドロップで受け取った、深さを選ぶ前の候補
  const [pending, setPending] = useState<PendingRoots | null>(null)
  const [dropActive, setDropActive] = useState(false)
  // #21 の表示モードとサムネ表示トグル。`config.json` に保存して次回起動時に復元する。
  const [viewMode, setViewMode] = useState<LibraryViewMode>(
    () => forcedMode ?? localPreferences?.viewMode ?? 'works',
  )
  // 起動時は必ずサムネ非表示から始める（前回の状態は復元しない）
  const { thumbnailsVisible, setThumbnailsVisible, toggleThumbnails } = useThumbnailVisible(
    forcedThumbnails ?? false,
  )
  // #52 / #121: サムネ非表示中に「このファイル / この作品だけ一時表示」する
  // セッション状態（永続化しない）
  const [revealedFiles, setRevealedFiles] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [revealedWorks, setRevealedWorks] = useState<ReadonlySet<number>>(() => new Set<number>())
  const toggleRevealedFile = useCallback((fileId: number) => {
    setRevealedFiles((current) => toggleReveal(current, fileId))
  }, [])
  const revealFile = useCallback((fileId: number) => {
    setRevealedFiles((current) => (current.has(fileId) ? current : new Set(current).add(fileId)))
  }, [])
  const toggleRevealedWork = useCallback((workId: number) => {
    setRevealedWorks((current) => toggleRevealWork(current, workId))
  }, [])
  // 全体トグルを切り替えたら個別の一時状態はリセット（#52 / #121 の要件）
  const handleToggleThumbnails = useCallback(() => {
    setRevealedFiles(new Set<number>())
    setRevealedWorks(new Set<number>())
    toggleThumbnails()
  }, [toggleThumbnails])
  const revealedFilesValue = useMemo(
    () => ({
      enabled: !thumbnailsVisible,
      revealed: revealedFiles,
      revealedWorks,
      toggle: toggleRevealedFile,
      reveal: revealFile,
      toggleWork: toggleRevealedWork,
    }),
    [
      thumbnailsVisible,
      revealedFiles,
      revealedWorks,
      toggleRevealedFile,
      revealFile,
      toggleRevealedWork,
    ],
  )
  // #22: シールドの設定（保存値。URL の `?shield=plain|files` は見た目だけ上書き）
  const [shieldSettings, setShieldSettings] = useState<ShieldSettings>(() => {
    const base = localPreferences?.shield ?? DEFAULT_SHIELD_SETTINGS
    return forcedShield.appearance
      ? normalizeShieldSettings({ ...base, appearance: forcedShield.appearance })
      : base
  })
  const [shieldSettingsOpen, setShieldSettingsOpen] = useState(false)
  /** 一度でも開いたらダイアログをマウントしたままにする（下書きを失わない）。 */
  const [shieldSettingsLoaded, setShieldSettingsLoaded] = useState(false)
  const [shieldHotkeyError, setShieldHotkeyError] = useState<string | null>(null)
  /** #67: 重複・類似の整理ダイアログ。 */
  const [dupesOpen, setDupesOpen] = useState(false)
  const [preferencesReady, setPreferencesReady] = useState(false)

  // シールド前後のスクロール位置（グリッド ↔ リストの切り替えで 0 に戻らないように）。
  // 高さはモードで変わるため、絶対 px ではなく割合で覚える。
  const scrollRatio = useRef(0)
  const captureShieldScroll = useCallback(() => {
    const element = document.querySelector<HTMLElement>('[data-scroll-region]')
    if (!element) return
    const range = element.scrollHeight - element.clientHeight
    scrollRatio.current = range > 0 ? element.scrollTop / range : 0
  }, [])
  const restoreShieldScroll = useCallback(() => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const element = document.querySelector<HTMLElement>('[data-scroll-region]')
        if (!element) return
        const range = element.scrollHeight - element.clientHeight
        element.scrollTop = scrollRatio.current * Math.max(0, range)
      })
    })
  }, [])

  const { shielded, activate: activateShield, deactivate: deactivateShield } = usePrivacyShield({
    settings: shieldSettings,
    initialShielded:
      forcedShield.active || (localPreferences?.shield.startHidden ?? false),
    onBeforeActivate: captureShieldScroll,
  })
  const wasShielded = useRef(shielded)

  // 保存済みの設定を読み、URL で強制されていない項目だけ反映する
  useEffect(() => {
    let alive = true
    void loadPreferences()
      .then((preferences) => {
        if (!alive) return
        if (forcedMode === null) setViewMode(preferences.viewMode)
        if (forcedThumbnails === null) setThumbnailsVisible(preferences.thumbnailsVisible)
        setShieldSettings(
          forcedShield.appearance
            ? { ...preferences.shield, appearance: forcedShield.appearance }
            : preferences.shield,
        )
        // 設定ファイル側だけ `start_hidden` が立っている初回起動にも追随する
        if (preferences.shield.startHidden) activateShield()
      })
      .finally(() => {
        if (alive) setPreferencesReady(true)
      })
    return () => {
      alive = false
    }
  }, [activateShield, forcedMode, forcedShield, forcedThumbnails, setThumbnailsVisible])

  // 変更を config.json（と localStorage）へ保存する
  useEffect(() => {
    if (!preferencesReady) return
    void savePreferences({ viewMode, thumbnailsVisible, shield: shieldSettings })
  }, [preferencesReady, viewMode, thumbnailsVisible, shieldSettings])

  // ホットキーの変更を Rust に登録し直す（衝突したら設定ダイアログに出す）
  useEffect(() => {
    if (bench) return
    let alive = true
    void api
      .applyShieldHotkey(shieldSettings.hotkey)
      .then(() => {
        if (alive) setShieldHotkeyError(null)
      })
      .catch((cause: unknown) => {
        if (alive) setShieldHotkeyError(describeError(cause))
      })
    return () => {
      alive = false
    }
  }, [bench, shieldSettings.hotkey])

  // タイトル・Alt+Tab プレビュー・キャプチャ除外を Rust 側で切り替える
  useEffect(() => {
    if (bench) return
    void api.setShieldActive(shielded).catch(() => {
      // 古い Windows や Tauri 未接続でもUIは動かす
    })
  }, [bench, shielded])

  // 実行中のサムネイル生成も止める（購読は effectiveThumbnailsVisible で外れる）
  useEffect(() => {
    if (bench || !shielded) return
    void api.cancelThumbs().catch(() => {
      // 生成していなければ false が返るだけ
    })
  }, [bench, shielded])

  // 解除後に元のスクロール位置へ戻す
  useEffect(() => {
    if (wasShielded.current && !shielded) restoreShieldScroll()
    wasShielded.current = shielded
  }, [shielded, restoreShieldScroll])

  const handleThumbnailsGenerated = useCallback(() => {
    // cover_thumb が DB に載ったので、グリッドを先頭から読み直す
    setRefreshToken((value) => value + 1)
  }, [])

  // #33: 詳細へ入る直前のスクロール位置と選択を控え、戻ったら復元する
  const readLibrarySnapshot = useCallback((): LibrarySnapshot => {
    const element = document.querySelector<HTMLElement>('[data-scroll-region]')
    return {
      scrollTop: element?.scrollTop ?? 0,
      selection: librarySelectionRef.current,
      filters: libraryFiltersRef.current ?? undefined,
    }
  }, [])

  const restoredSnapshot = useRef<LibrarySnapshot | null>(null)
  useEffect(() => {
    if (route.kind !== 'library' || !routeSnapshot) return
    if (restoredSnapshot.current === routeSnapshot) return
    restoredSnapshot.current = routeSnapshot
    const target = routeSnapshot.scrollTop
    let frame = 0
    // 仮想スクロールはページを読み足しながら高さが伸びるため、数フレーム粘って合わせる
    const apply = () => {
      const element = document.querySelector<HTMLElement>('[data-scroll-region]')
      if (element) {
        element.scrollTop = target
        if (Math.abs(element.scrollTop - target) <= 2) return
      }
      frame += 1
      if (frame <= 120) window.requestAnimationFrame(apply)
    }
    window.requestAnimationFrame(apply)
  }, [route.kind, routeSnapshot])

  /** #100: ベンチの空状態ショットでは合成ルートを使う（通常起動は従来どおり）。 */
  const displayRoots = bench ? benchRoots : roots
  const rootAccents = useMemo(
    () => buildRootAccentMap(displayRoots.map(({ root }) => root.id)),
    [displayRoots],
  )

  // ファイルモードを開いたときだけ 65,000 件の合成ファイルを作る
  const benchFileSource = useMemo(
    () =>
      benchCount === null || viewMode !== 'files'
        ? undefined
        : createBenchFileSource(benchCount, demoImages),
    [benchCount, demoImages, viewMode],
  )
  // 作品詳細（#5）用の合成ファイル。`?bench=1000&detail=7` で 1,000 ファイルの作品を開く
  const benchWorkSource = useMemo(
    () =>
      benchCount === null || selected === null || route.kind === 'library'
        ? undefined
        : createBenchWorkFileSource(selected.work.id, benchCount, demoImages),
    [benchCount, demoImages, route.kind, selected],
  )

  const reloadAll = useCallback(async () => {
    if (bench) {
      setRefreshToken((value) => value + 1)
      return
    }
    try {
      const [nextRoots, nextStats] = await Promise.all([api.listRoots(), api.libraryStats()])
      setRoots(nextRoots)
      setStats(nextStats)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [bench])

  const refresh = useCallback(async () => {
    await reloadAll()
    setRefreshToken((value) => value + 1)
  }, [reloadAll])

  useEffect(() => {
    if (bench) return
    let disposed = false
    void (async () => {
      try {
        const nextRoots = await api.listRoots()
        if (disposed) return
        setRoots(nextRoots)
        if (nextRoots.length === 0) {
          setRootsLoaded(true)
          setRootsOpen(true)
        }
        const nextStats = await api.libraryStats()
        if (!disposed) setStats(nextStats)
      } catch (cause) {
        if (!disposed) setError(describeError(cause))
      }
    })()
    return () => {
      disposed = true
    }
  }, [bench])

  useEffect(() => {
    if (bench) return
    let disposed = false
    const unlisteners: Array<() => void> = []

    const track = (pending: Promise<() => void>) => {
      pending
        .then((unlisten) => {
          if (disposed) unlisten()
          else unlisteners.push(unlisten)
        })
        .catch(() => {
          // ブラウザ単体（Tauri なし）ではイベントが無いので無視
        })
    }

    track(
      listen<ScanProgress>('scan://progress', (event) => {
        if (!disposed) setProgress(event.payload)
      }),
    )
    track(
      listen<ScanSummary>('scan://done', () => {
        if (!disposed) setProgress(null)
      }),
    )
    // #15: 大量削除の進捗（done / total）。削除中ダイアログに出す。
    track(
      listen<DeleteProgress>('delete://progress', (event) => {
        if (!disposed) setDeleteProgress(event.payload)
      }),
    )

    return () => {
      disposed = true
      for (const unlisten of unlisteners) unlisten()
    }
  }, [bench])

  const handleScan = useCallback(
    async (rootId: number) => {
      setError(null)
      setNotice(null)
      setScanningRoot(rootId)
      setProgress({ root_id: rootId, phase: 'starting', files: 0, works: 0, bytes: 0 })
      try {
        const summary = await api.scanRoot(rootId)
        if (summary.status === 'cancelled') {
          setNotice(`走査をキャンセルしました（${formatCount(summary.files)} ファイルまで確定）`)
        } else if (summary.duplicate_of !== null) {
          setNotice(
            `このルートのファイルはすべて他のルート（#${summary.duplicate_of}）と同一実体のため索引しませんでした`,
          )
        } else {
          setNotice(
            `走査しました: ${formatCount(summary.files)} ファイル / ${formatCount(summary.works)} 作品` +
              `（追加 ${formatCount(summary.added)} / 更新 ${formatCount(summary.updated)} / 削除 ${formatCount(summary.removed)}）`,
          )
        }
        await reloadAll()
        setRefreshToken((value) => value + 1)
      } catch (cause) {
        setError(describeError(cause))
      } finally {
        setScanningRoot(null)
        setProgress(null)
      }
    },
    [reloadAll],
  )

  /**
   * ダイアログ / ドロップで受け取ったパスを検証して、深さを選ぶステップに積む（#25）。
   * フォルダ以外（ファイル）はここで落とし、1 件も無ければ案内を出す。
   */
  const stagePaths = useCallback(async (paths: string[], source: 'picker' | 'drop') => {
    setError(null)
    try {
      const checks = await api.inspectRootPaths(paths)
      const directories = checks.filter((check) => check.kind === 'directory')
      const skippedFiles = checks.length - directories.length
      if (directories.length === 0) {
        setError('フォルダをドロップしてください（ファイルは追加できません）')
        return
      }
      setPending({ checks: directories, skippedFiles, source })
      setRootsLoaded(true)
      setRootsOpen(true)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [])

  /** OS のフォルダ選択ダイアログ（複数選択）を開く。 */
  const openPicker = useCallback(async () => {
    setError(null)
    try {
      const paths = await pickFolders()
      if (paths.length === 0) return
      await stagePaths(paths, 'picker')
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [stagePaths])

  /** 追加 + 即スキャン。複数フォルダは順に処理する（走査は同時に 1 本）。 */
  const handleAddRoots = useCallback(
    async (paths: string[], depth: number) => {
      setError(null)
      setNotice(null)
      const added: Root[] = []
      const failures: string[] = []
      for (const path of paths) {
        try {
          added.push(await api.addRoot(path, depth))
        } catch (cause) {
          failures.push(`${path}: ${describeError(cause)}`)
        }
      }

      setPending(null)
      await reloadAll()
      for (const root of added) {
        await handleScan(root.id)
      }

      if (failures.length > 0) {
        const message = `追加できませんでした: ${failures.join(' / ')}`
        setError(message)
        throw new Error(message)
      }
      if (added.length > 1) {
        setNotice(`${added.length} 件のルートを追加して走査しました`)
      }
    },
    [reloadAll, handleScan],
  )

  const handleDragActive = useCallback((active: boolean) => setDropActive(active), [])
  const handleDrop = useCallback(
    (paths: string[]) => {
      void stagePaths(paths, 'drop')
    },
    [stagePaths],
  )
  useFolderDrop({
    enabled: !bench,
    onDragActiveChange: handleDragActive,
    onDrop: handleDrop,
  })

  const handleCancelScan = useCallback(() => {
    void api.cancelScan().catch((cause: unknown) => setError(describeError(cause)))
  }, [])

  const handleOpenWork = useCallback(
    (work: WorkSummary, startFileId?: number | null) => {
      const rootLabel = displayRoots.find((info) => info.root.id === work.root_id)?.root.label ?? ''
      setSelected({
        work,
        rootLabel,
        accent: rootAccentFor(rootAccents, work.root_id),
        // #71: 動画カードで Space を押したときは、先頭フレームではなく再生から始める
        startFile:
          startFileId && startFileId > 0 ? { id: startFileId, name: work.title } : undefined,
      })
      push(
        { kind: 'work', workId: work.id },
        route.kind === 'library' ? readLibrarySnapshot() : undefined,
      )
    },
    [displayRoots, push, readLibrarySnapshot, rootAccents, route.kind],
  )

  /** ダイアログが開いていれば、履歴より先にそれを閉じる（#33 の「戻る優先」）。 */
  const closeTopLayer = useCallback((): boolean => {
    if (dupesOpen) {
      setDupesOpen(false)
      return true
    }
    if (shieldSettingsOpen) {
      setShieldSettingsOpen(false)
      return true
    }
    if (rootsOpen) {
      setRootsOpen(false)
      setPending(null)
      return true
    }
    return false
  }, [dupesOpen, rootsOpen, shieldSettingsOpen])

  const handleNavBack = useCallback(() => {
    // シールド中は履歴を動かさない（解除は専用の操作で行う）
    if (shielded) return
    back(closeTopLayer)
  }, [back, closeTopLayer, shielded])

  const handleNavForward = useCallback(() => {
    if (shielded) return
    forward(route.kind === 'library' ? readLibrarySnapshot() : undefined)
  }, [forward, readLibrarySnapshot, route.kind, shielded])

  /** ライトボックスの開閉・index 変更を履歴に反映する（詳細は積み直さない）。 */
  const handleLightboxIndexChange = useCallback(
    (index: number | null) => {
      if (route.kind === 'lightbox') {
        if (index === null) back()
        else replace({ kind: 'lightbox', workId: route.workId, fileIndex: index })
        return
      }
      if (route.kind === 'work' && index !== null) {
        push({ kind: 'lightbox', workId: route.workId, fileIndex: index })
        // ファイルモードの開始ファイルは 1 回だけ開く（戻る→進むで開き直さない）
        setSelected((current) =>
          current?.startFile ? { ...current, startFile: undefined } : current,
        )
      }
    },
    [back, push, replace, route],
  )

  // #33: マウスのサイドボタン（戻る/進む）と Alt+← / Alt+→
  // （シールド中も preventDefault だけは効かせたいので購読は外さない）
  useMouseNavButtons({
    onBack: handleNavBack,
    onForward: handleNavForward,
  })

  /**
   * ファイルモードのダブルクリック（#21）。まず合成した作品要約で詳細（#5 の仮画面）を
   * 即座に開き、実データでは作品の集計を非同期で取り直す。
   */
  const handleOpenFile = useCallback(
    (file: FileSummary) => {
      const rootLabel = displayRoots.find((info) => info.root.id === file.root_id)?.root.label ?? ''
      const accent = rootAccentFor(rootAccents, file.root_id)
      const summary: WorkSummary = {
        id: file.work_id,
        root_id: file.root_id,
        rel_path: file.work_rel_path,
        title: file.work_title,
        kind: file.kind,
        cover_file_id: null,
        cover_thumb: file.thumb_path,
        preview_thumbs: [],
        file_count: 0,
        total_bytes: file.bytes,
        mtime: file.mtime,
      }
      setSelected({
        work: summary,
        rootLabel,
        accent,
        startFile: { id: file.id, name: file.name },
      })
      push(
        { kind: 'work', workId: summary.id },
        route.kind === 'library' ? readLibrarySnapshot() : undefined,
      )

      if (bench) return
      void api
        .getWork(file.work_id)
        .then((detail) => {
          setSelected((current) =>
            current !== null && current.work.id === detail.work.id
              ? { ...current, work: detail.work }
              : current,
          )
        })
        .catch(() => {
          // 取得できなくても仮画面は開けているので何もしない
        })
    },
    [bench, displayRoots, push, readLibrarySnapshot, rootAccents, route.kind],
  )

  // #22: シールド中は #21 のサムネ非表示をそのまま被せる（新しい表示状態は作らない）。
  // 作品/ファイルモードの状態・絞り込み・選択は保ったまま、`<img>` を 0 件にする。
  const effectiveThumbnailsVisible = thumbnailsVisible && !shielded

  // -------------------------------------------------------------------------
  // #15: 削除（確認 → 実行 → Undo）
  // -------------------------------------------------------------------------

  const requestDelete = useCallback(
    (
      source: DeleteRequest['source'],
      kind: DeleteRequest['kind'],
      ids: number[],
      count: number,
      totalBytes: number,
      intent: DeleteIntent,
    ) => {
      if (ids.length === 0) return
      setDeleteReport(null)
      setDeleteProgress(null)
      setDeleteRequest({ source, kind, ids, count, totalBytes, permanent: intent.permanent })
    },
    [],
  )

  /** ライブラリの作品選択（作品まるごと削除）。 */
  const handleDeleteWorks = useCallback(
    (works: WorkSummary[], intent: DeleteIntent) => {
      requestDelete(
        'library',
        'works',
        works.map((work) => work.id),
        works.length,
        works.reduce((total, work) => total + work.total_bytes, 0),
        intent,
      )
    },
    [requestDelete],
  )

  /** ファイルモードのファイル選択。 */
  const handleDeleteFiles = useCallback(
    (files: FileSummary[], intent: DeleteIntent) => {
      requestDelete(
        'library',
        'files',
        files.map((file) => file.id),
        files.length,
        files.reduce((total, file) => total + file.bytes, 0),
        intent,
      )
    },
    [requestDelete],
  )

  /** #67: 重複グループの「キーパー以外」を削除フローへ渡す。 */
  const handleDeleteDuplicates = useCallback(
    (ids: number[], bytes: number) => {
      requestDelete('library', 'files', ids, ids.length, bytes, { permanent: false })
    },
    [requestDelete],
  )

  /** 作品詳細のヘッダ「ゴミ箱へ」（作品まるごと）。 */  const handleDeleteWork = useCallback(
    (work: WorkSummary, intent: DeleteIntent) => {
      requestDelete('detail', 'works', [work.id], 1, work.total_bytes, intent)
    },
    [requestDelete],
  )

  const handleCancelRunningDelete = useCallback(() => {
    if (bench) {
      benchDeleteCancel.current = true
      return
    }
    void api.cancelDelete().catch(() => {
      // 実行していなければ false が返るだけ
    })
  }, [bench])

  const finishBenchDelete = useCallback(
    async (request: DeleteRequest, permanent: boolean) => {
      benchDeleteCancel.current = false
      setDeleting(true)
      setDeleteProgress({ done: 0, total: request.count, id: 0, name: '' })
      let completed = 0
      for (let index = 0; index < request.count; index += 1) {
        if (benchDeleteCancel.current) break
        await new Promise((resolve) => window.setTimeout(resolve, 24))
        completed += 1
        setDeleteProgress({
          done: completed,
          total: request.count,
          id: request.ids[index] ?? 0,
          name: `sample-${String(index + 1).padStart(3, '0')}.png`,
        })
      }
      const cancelled = benchDeleteCancel.current
      const bytes =
        request.count === 0
          ? 0
          : Math.round((request.totalBytes * completed) / request.count)
      setDeleting(false)
      setDeleteRequest(null)
      setDeleteProgress(null)
      setSelectionResetToken((value) => value + 1)
      setDeleteReport({
        deleted: completed,
        failed: [],
        permanent,
        undo_id: permanent ? null : `bench-undo-${Date.now()}`,
        deleted_bytes: bytes,
        cancelled,
      })
      if (!permanent && completed > 0) {
        setUndo({ id: `bench-undo-${Date.now()}`, count: completed })
      }
    },
    [],
  )

  const confirmDelete = useCallback(
    async (permanent: boolean) => {
      const request = deleteRequest
      if (!request || deleting) return
      if (bench) {
        await finishBenchDelete(request, permanent)
        if (request.source === 'detail' && request.kind === 'works') back()
        return
      }

      setDeleting(true)
      setDeleteProgress({ done: 0, total: request.count, id: 0, name: '' })
      try {
        // 作品単位の選択は Rust 側で files.id に展開する（UI はパスを渡さない）。
        const fileIds =
          request.kind === 'works' ? await api.workFileIds(request.ids) : request.ids
        if (fileIds.length === 0) {
          setDeleteRequest(null)
          setError('削除対象のファイルがありません')
          return
        }

        const result = await api.deleteFiles(fileIds, permanent)
        setDeleteRequest(null)
        // 失敗・中止があったときだけ結果ダイアログを出す（成功は通知と Undo トースト）。
        if (result.failed.length > 0 || result.cancelled) setDeleteReport(result)
        if (result.deleted > 0) {
          setSelectionResetToken((value) => value + 1)
          librarySelectionRef.current = []
          await reloadAll()
          setRefreshToken((value) => value + 1)
          // 作品ごと消せたときだけ詳細からライブラリへ戻る（#33 の履歴を 1 段戻す）。
          if (
            request.source === 'detail' &&
            request.kind === 'works' &&
            result.failed.length === 0 &&
            !result.cancelled
          ) {
            back()
          }
          if (result.failed.length === 0) {
            setNotice(
              `${formatCount(result.deleted)} 件を${permanent ? '完全に削除' : 'ゴミ箱へ移動'}しました`,
            )
          }
        }
        if (result.undo_id && result.deleted > 0) {
          setUndo({ id: result.undo_id, count: result.deleted })
        }
      } catch (cause) {
        setDeleteRequest(null)
        setError(describeError(cause))
      } finally {
        setDeleting(false)
        setDeleteProgress(null)
      }
    },
    [back, bench, deleteRequest, deleting, finishBenchDelete, reloadAll],
  )

  const handleUndo = useCallback(async () => {
    if (!undo || undoBusy) return
    if (bench) {
      setUndo(null)
      setSelectionResetToken((value) => value + 1)
      setNotice('（ベンチモード）削除を取り消しました')
      return
    }
    setUndoBusy(true)
    try {
      const result = await api.undoDelete(undo.id)
      setUndo(null)
      setSelectionResetToken((value) => value + 1)
      await reloadAll()
      setRefreshToken((value) => value + 1)
      setNotice(
        `${formatCount(result.restored)} 件をゴミ箱から戻しました` +
          (result.reindexed > 0 ? `（索引 ${formatCount(result.reindexed)} 件）` : ''),
      )
      if (result.failed.length > 0) setError(result.failed.join(' / '))
    } catch (cause) {
      setUndo(null)
      setError(
        `削除を取り消せませんでした: ${describeError(cause)}。エクスプローラのゴミ箱から復元してください`,
      )
    } finally {
      setUndoBusy(false)
    }
  }, [bench, undo, undoBusy, reloadAll])

  // #115: Undo トーストは共通スタックへ積む。undo / undoBusy が変わっても同じ
  // トーストを差し替えるだけで、5 秒タイマーは張り直さない。
  const undoToastRef = useRef<{ id: number; undoId: string } | null>(null)

  useEffect(() => {
    const current = undoToastRef.current
    if (!undo) {
      if (current) {
        removeToast(current.id)
        undoToastRef.current = null
      }
      return
    }

    const content = (
      <Suspense fallback={null}>
        <UndoToast
          undoId={undo.id}
          count={undo.count}
          busy={undoBusy}
          onUndo={() => void handleUndo()}
          onExpire={() => setUndo(null)}
        />
      </Suspense>
    )

    if (current && current.undoId === undo.id) {
      updateToast(current.id, { content })
      return
    }
    if (current) removeToast(current.id)
    const id = pushToast({
      key: `delete-undo:${undo.id}`,
      content,
      width: 'min(92vw,420px)',
      onEvict: () => setUndo(null),
    })
    undoToastRef.current = { id, undoId: undo.id }
  }, [undo, undoBusy, handleUndo])

  useEffect(() => {
    return () => {
      if (undoToastRef.current) {
        removeToast(undoToastRef.current.id)
        undoToastRef.current = null
      }
    }
  }, [])

  return (
    <RevealedFilesContext.Provider value={revealedFilesValue}>
    <TooltipProvider>
      <div className="flex h-dvh flex-col overflow-hidden">
        <header className="flex h-14 flex-none items-center gap-6 border-b border-[var(--line)] bg-[var(--bg)] px-6">
          <div className="flex min-w-0 flex-none items-center gap-2.5">
            <BrandMark />
            <h1 className="type-display m-0 text-[21px] leading-[1.3] font-semibold text-[var(--text-primary)]">
              ライブラリ
            </h1>
          </div>

          {/* #96: 統計は 12px tabular の 1 行（· 区切り）。 */}
          <dl
            className="hidden min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-xs whitespace-nowrap text-[var(--text-secondary)] tabular-nums lg:flex"
            aria-label="索引の集計"
          >
            <div className="flex items-baseline gap-1">
              <dt className="m-0">作品</dt>
              <dd className="m-0 font-medium text-[var(--text-secondary)]">
                {formatCount(stats?.works ?? 0)}
              </dd>
            </div>
            <span aria-hidden="true">·</span>
            <div className="flex items-baseline gap-1">
              <dt className="m-0">ファイル</dt>
              <dd className="m-0 font-medium text-[var(--text-secondary)]">
                {formatCount(stats?.files ?? 0)}
              </dd>
            </div>
            <span aria-hidden="true">·</span>
            <div className="flex items-baseline gap-1">
              <dt className="m-0">サイズ</dt>
              <dd className="m-0 font-medium text-[var(--text-secondary)]">
                {formatBytes(stats?.total_bytes ?? 0)}
              </dd>
            </div>
            <span aria-hidden="true">·</span>
            <div className="flex items-baseline gap-1">
              <dt className="m-0">最終走査</dt>
              <dd
                className="m-0 font-medium text-[var(--text-secondary)]"
                title={formatDate(stats?.last_scan_at ?? null)}
              >
                {stats?.last_scan_at ? formatShortDate(stats.last_scan_at) : '未走査'}
              </dd>
            </div>
          </dl>

          <div className="ml-auto flex flex-none items-center gap-1">
            {!bench && (
              // 幅を固定して、生成中/非表示の切り替えで隣のボタンが動かないようにする
              <span className="hidden w-[168px] justify-end overflow-hidden xl:flex">
                <ThumbStatus
                  visible={effectiveThumbnailsVisible && route.kind === 'library'}
                  onGenerated={handleThumbnailsGenerated}
                />
              </span>
            )}

            <IconTooltip label={thumbnailsVisible ? 'サムネイルを非表示' : 'サムネイルを表示'} hint={THUMBNAIL_SHORTCUT}>
              <ThumbnailToggle
                variant="compact"
                visible={thumbnailsVisible}
                onToggle={handleToggleThumbnails}
              />
            </IconTooltip>

            <IconTooltip label="重複整理" hint="同じ内容・似た画像をまとめる">
              <Button
                variant="ghost"
                size="icon"
                aria-label="重複整理"
                className="text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
                onClick={() => setDupesOpen(true)}
              >
                <CopyCheck />
              </Button>
            </IconTooltip>

            <IconTooltip label="シールド設定" hint="プライバシーシールド">
              <Button
                variant="ghost"
                size="icon"
                aria-label="シールド設定"
                className="text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
                onClick={() => {
                  setShieldSettingsLoaded(true)
                  setShieldSettingsOpen(true)
                }}
              >
                <Shield />
              </Button>
            </IconTooltip>

            <IconTooltip label="再読み込み" hint="索引を読み直す">
              <Button
                variant="ghost"
                size="icon"
                aria-label="再読み込み"
                className="text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
                onClick={() => void refresh()}
              >
                <RotateCw />
              </Button>
            </IconTooltip>

            <IconTooltip label="ルート管理" hint="走査フォルダの追加・深さ">
              <Button
                variant="ghost"
                size="icon"
                aria-label="ルート管理"
                className="text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]"
                onClick={() => {
                  setRootsLoaded(true)
                  setRootsOpen(true)
                }}
              >
                <FolderSearch />
              </Button>
            </IconTooltip>

            <SettingsLauncher />

            <span aria-hidden="true" className="mx-1 h-4 w-px flex-none bg-[var(--line)]" />

            <IconTooltip label="フォルダを追加" hint="複数選択できます">
              <Button
                size="sm"
                aria-label="フォルダを追加"
                className="h-8 gap-1.5 rounded-[var(--radius-control)] bg-[var(--brand)] px-3 text-[13px] font-medium text-[var(--brand-contrast)] hover:bg-[color-mix(in_srgb,var(--brand)_88%,white)]"
                onClick={() => void openPicker()}
              >
                <FolderPlus data-icon="inline-start" />
                ルート
              </Button>
            </IconTooltip>
          </div>
        </header>

        {progress && (
          <div
            className="flex flex-none items-center gap-3 border-b border-border bg-primary/10 px-5 py-1.5"
            role="status"
            aria-live="polite"
          >
            <span className="text-xs font-semibold whitespace-nowrap text-primary">
              {progress.phase === 'finalizing' ? '集計中…' : '走査中…'}
            </span>
            <Progress
              value={100}
              aria-label="走査の進捗"
              className="h-1.5 flex-1 bg-white/10 [&_[data-slot=progress-indicator]]:animate-[scan-bar_1.2s_linear_infinite] [&_[data-slot=progress-indicator]]:bg-[linear-gradient(90deg,transparent,var(--primary),var(--accent-2),transparent)]"
            />
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
              {formatCount(progress.files)} ファイル / {formatCount(progress.works)} 作品 /{' '}
              {formatBytes(progress.bytes)}
            </span>
            <Button variant="ghost" size="xs" onClick={handleCancelScan}>
              キャンセル
            </Button>
          </div>
        )}

        {(error || notice) && (
          <div className="flex flex-none flex-col gap-1.5 px-5 pt-2">
            {error && (
              <div className="flex items-start gap-2">
                <p
                  className="m-0 flex-1 rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                  role="alert"
                >
                  {error}
                </p>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="エラーを閉じる"
                  onClick={() => setError(null)}
                >
                  <X />
                </Button>
              </div>
            )}
            {notice && (
              <div className="flex items-start gap-2">
                <p
                  className="m-0 flex-1 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground"
                  role="status"
                >
                  {notice}
                </p>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="通知を閉じる"
                  onClick={() => setNotice(null)}
                >
                  <X />
                </Button>
              </div>
            )}
          </div>
        )}

        <main className="flex min-h-0 flex-1 flex-col">
          {route.kind !== 'library' && selected ? (
            <Suspense fallback={null}>
              <WorkDetail
                work={selected.work}
                rootLabel={selected.rootLabel}
                accent={selected.accent}
                thumbnailVisible={effectiveThumbnailsVisible}
                onToggleThumbnails={handleToggleThumbnails}
                shielded={shielded}
                startFileId={selected.startFile?.id}
                source={bench ? benchWorkSource : undefined}
                bench={bench}
                refreshToken={refreshToken}
                selectionResetToken={selectionResetToken}
                onDeleteSelected={handleDeleteFiles}
                onDeleteWork={handleDeleteWork}
                lightboxIndex={route.kind === 'lightbox' ? route.fileIndex : null}
                onLightboxIndexChange={handleLightboxIndexChange}
                onBack={handleNavBack}
              />
            </Suspense>
          ) : (
            <LibraryView
              roots={displayRoots}
              initialSearch={initialSearch ?? undefined}
              rootAccents={rootAccents}
              onOpenWork={handleOpenWork}
              onOpenFile={handleOpenFile}
              onOpenRoots={() => {
                setRootsLoaded(true)
                setRootsOpen(true)
              }}
              onRootsChanged={() => void refresh()}
              refreshToken={refreshToken}
              source={benchSource}
              fileSource={benchFileSource}
              bench={bench}
              benchCount={benchCount ?? 0}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onToggleThumbnails={handleToggleThumbnails}
              thumbnailsVisible={effectiveThumbnailsVisible}
              shielded={shielded}
              selectionResetToken={selectionResetToken}
              onDeleteSelected={handleDeleteWorks}
              onDeleteFiles={handleDeleteFiles}
              initialSelection={routeSnapshot?.selection}
              onSelectionChange={handleSelectionChange}
              initialFilters={routeSnapshot?.filters}
              onFiltersChange={handleLibraryFiltersChange}
            />
          )}
        </main>

        {rootsLoaded && (
          <Suspense fallback={null}>
            <RootsDrawer
              open={rootsOpen}
              onClose={() => {
                setRootsOpen(false)
                setPending(null)
              }}
              roots={roots}
              rootAccents={rootAccents}
              onAdd={handleAddRoots}
              onScan={handleScan}
              scanningRoot={scanningRoot}
              progress={progress}
              onCancel={handleCancelScan}
              pending={pending}
              onStagePaths={stagePaths}
              onPickFolders={() => void openPicker()}
              onClearPending={() => setPending(null)}
            />
          </Suspense>
        )}

        {dropActive && (
          <div
            className="pointer-events-none fixed inset-0 z-[100] flex items-center justify-center bg-background/70 p-6 backdrop-blur-sm"
            aria-hidden="true"
          >
            <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-card/95 px-10 py-8 text-center shadow-2xl">
              <FolderPlus className="size-10 text-primary" />
              <p className="m-0 text-lg font-semibold">ここにドロップして追加</p>
              <p className="m-0 text-xs text-muted-foreground">
                フォルダをドロップすると走査ルートに追加します
              </p>
            </div>
          </div>
        )}

        {/* #67: 重複・類似の整理。開いたときだけ読み込む。 */}
        {dupesOpen && (
          <Suspense fallback={null}>
            <DupesDialog
              open={dupesOpen}
              onOpenChange={setDupesOpen}
              onDelete={handleDeleteDuplicates}
            />
          </Suspense>
        )}

        {shieldSettingsLoaded && (
          <Suspense fallback={null}>
            <ShieldSettingsDialog
              open={shieldSettingsOpen}
              onOpenChange={setShieldSettingsOpen}
              value={shieldSettings}
              onSave={(next) => {
                setShieldSettings(next)
                setShieldSettingsOpen(false)
              }}
              hotkeyError={shieldHotkeyError}
            />
          </Suspense>
        )}

        {/* #15: 削除の確認・進捗・結果と Undo（5 秒）。#49 で必要時のみ読み込む。 */}
        {deleteRequest && (
          <Suspense fallback={null}>
            <DeleteConfirmDialog
              request={deleteRequest}
              busy={deleting}
              progress={deleteProgress}
              onClose={() => setDeleteRequest(null)}
              onConfirm={(permanent) => void confirmDelete(permanent)}
              onCancelRunning={handleCancelRunningDelete}
            />
          </Suspense>
        )}
        {deleteReport && (
          <Suspense fallback={null}>
            <DeleteReportDialog result={deleteReport} onClose={() => setDeleteReport(null)} />
          </Suspense>
        )}

        {/* 事前マウント。`active` の切り替えだけで最前面に出す（#22） */}
        <ShieldOverlay
          active={shielded}
          appearance={shieldSettings.appearance}
          onRestore={deactivateShield}
        />

        {/* #82: `?` で開くショートカット一覧。定義は src/lib/shortcuts.ts に集約。 */}
        <ShortcutsHelp />

        {/* #115: 削除 / 移動 / 通知のトーストを 1 つのスタックに集約する。 */}
        <ToastStack />
      </div>
    </TooltipProvider>
    </RevealedFilesContext.Provider>
  )
}

/** #96: ヘッダーの 32px アイコンボタン用ツールチップ（ツールチップ必須）。 */
function IconTooltip({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        <span className="font-medium">{label}</span>
        {hint && <span className="text-background/65">· {hint}</span>}
      </TooltipContent>
    </Tooltip>
  )
}
