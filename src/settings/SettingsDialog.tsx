import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { getVersion } from '@tauri-apps/api/app'
import { isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  CheckCircle2,
  Copy,
  Film,
  FolderPlus,
  HardDrive,
  Info,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react'
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
import { Separator } from '@/components/ui/separator'
import { api } from '../api'
import type {
  AppSettings,
  ComfyStatus,
  FfmpegProbe,
  MetaIndexSummary,
  MetaProgress,
  MetaReport,
  SettingsPatch,
} from '../api'
import { describeError, formatBytes, formatCount, formatDate } from '../lib/format'
import { comfySettingsPatch } from '../library/comfy'
import { pickFolders } from '../library/rootPicker'
import {
  cacheUsagePercent,
  DEFAULT_CACHE_LIMIT_MB,
  DEFAULT_EXCLUDE_PATTERNS,
  excludePatternsToText,
  normalizeCacheLimitMb,
  normalizeQuality,
  openSettingsFromUrl,
  parseExcludePatterns,
  QUALITY_MAX,
  QUALITY_MIN,
} from './model'
import { setRememberVolume as persistRememberVolume } from './playback'

/** 更新（インストーラ差し替え）の配布元。 */
const RELEASES_URL = 'https://github.com/yuyashimizu2756/works-browser/releases'

/** Tauri に接続できない（headless / ブラウザ単体）ときの表示用。 */
const FALLBACK_SETTINGS: AppSettings = {
  config: {
    view_mode: 'works',
    thumbnails_visible: true,
    shield_hotkey: 'Ctrl+Shift+P',
    shield_hold_ms: 1000,
    shield_start_hidden: false,
    shield_appearance: 'files',
    exclude_patterns: DEFAULT_EXCLUDE_PATTERNS,
    ffmpeg_path: '',
    thumb_quality: 75,
    thumb_cache_limit_mb: DEFAULT_CACHE_LIMIT_MB,
    remember_volume: false,
    comfy_url: 'http://127.0.0.1:8188',
    comfy_workflows_dir: '',
  },
  config_path: '%APPDATA%\\works-browser\\config.json',
  roots: [],
  thumbs: {
    max_edge: 512,
    quality: 75,
    parallelism: 8,
    cache_dir: '%LOCALAPPDATA%\\works-browser\\thumbs',
    ffmpeg: null,
    ffmpeg_source: 'none',
  },
  cache: {
    path: '%LOCALAPPDATA%\\works-browser\\thumbs',
    bytes: 0,
    files: 0,
    limit_bytes: DEFAULT_CACHE_LIMIT_MB * 1024 * 1024,
  },
  ffmpeg: { path: null, source: 'none', version: null, error: null },
}

const DEPTHS = [
  { value: 1, label: '第 1 階層（作品/ファイル）' },
  { value: 2, label: '第 2 階層（作品/サブ/ファイル）' },
  { value: 0, label: 'フラット（ルート直下）' },
]

const FFMPEG_SOURCE_LABEL: Record<string, string> = {
  setting: '手動指定',
  sidecar: '同梱 sidecar',
  path: 'PATH',
  fallback: '既定の場所',
  none: '見つかりません',
}

type Props = {
  /** URL（`?settings=1`）で開く場合に使う。通常は省略。 */
  defaultOpen?: boolean
  /** #49: 遅延読み込み用。指定時は親（SettingsLauncher）が開閉を管理する。 */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * 設定画面（#8）。
 *
 * #49 で「設定」ボタンは `SettingsLauncher` に移し、このコンポーネントは
 * ダイアログ本体だけを持つ（初回クリックまで `React.lazy` で読み込まない）。
 */
export function SettingsDialog({ defaultOpen, open: controlledOpen, onOpenChange }: Props = {}) {
  const [openState, setOpenState] = useState(() => defaultOpen ?? openSettingsFromUrl())
  const open = controlledOpen ?? openState
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )
  const [settings, setSettings] = useState<AppSettings>(FALLBACK_SETTINGS)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)

  // 編集用の下書き（保存を押すまで config.json には書かない）
  const [excludeText, setExcludeText] = useState(
    excludePatternsToText(FALLBACK_SETTINGS.config.exclude_patterns),
  )
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [ffmpegChecked, setFfmpegChecked] = useState<FfmpegProbe | null>(null)
  const [quality, setQuality] = useState(75)
  const [cacheLimit, setCacheLimit] = useState(DEFAULT_CACHE_LIMIT_MB)
  const [startHidden, setStartHidden] = useState(false)
  const [rememberVolume, setRememberVolume] = useState(false)
  // #73: ComfyUI 連携
  const [comfyUrl, setComfyUrl] = useState('http://127.0.0.1:8188')
  const [comfyWorkflowsDir, setComfyWorkflowsDir] = useState('')
  const [comfyStatus, setComfyStatus] = useState<ComfyStatus | null>(null)
  // #60: 生成情報の索引と付与率
  const [metaReport, setMetaReport] = useState<MetaReport | null>(null)
  const [metaProgress, setMetaProgress] = useState<MetaProgress | null>(null)
  const [metaIndexing, setMetaIndexing] = useState(false)

  // ルート追加
  const [addDepth, setAddDepth] = useState(1)
  // 削除の 2 段階確認（ルート id / キャッシュ）
  const [confirmDeleteRoot, setConfirmDeleteRoot] = useState<number | null>(null)
  const [confirmClearCache, setConfirmClearCache] = useState(false)
  // ルートを変えたら、閉じたときにライブラリを読み直す（App.tsx に依存しない）
  const [rootsDirty, setRootsDirty] = useState(false)

  const close = useCallback(() => {
    setOpen(false)
    if (rootsDirty) window.location.reload()
  }, [rootsDirty])

  const applySettings = useCallback((next: AppSettings) => {
    setSettings(next)
    setExcludeText(excludePatternsToText(next.config.exclude_patterns))
    setFfmpegPath(next.config.ffmpeg_path)
    setFfmpegChecked(next.ffmpeg)
    setQuality(normalizeQuality(next.config.thumb_quality))
    setCacheLimit(normalizeCacheLimitMb(next.config.thumb_cache_limit_mb))
    setStartHidden(next.config.shield_start_hidden)
    setRememberVolume(next.config.remember_volume)
    setComfyUrl(next.config.comfy_url)
    setComfyWorkflowsDir(next.config.comfy_workflows_dir)
    // 保存済みの音量設定を次回の再生に効かせる
    persistRememberVolume(next.config.remember_volume)
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const next = await api.getSettings()
      applySettings(next)
      setOffline(false)
      setError(null)
      // #60: 付与率は失敗しても設定画面全体は止めない
      void api
        .metaReport()
        .then(setMetaReport)
        .catch(() => undefined)
    } catch (cause) {
      // Tauri 未接続（headless / ブラウザ単体）でも画面は表示する。
      // 接続できないこと自体は上の案内文で伝えるので、生のエラーは出さない。
      setOffline(true)
      if (isTauri()) setError(describeError(cause))
    } finally {
      setLoading(false)
    }
  }, [applySettings])

  useEffect(() => {
    if (!open) return
    void reload()
  }, [open, reload])

  const dirty = useMemo(() => {
    const config = settings.config
    return (
      excludePatternsToText(parseExcludePatterns(excludeText)) !==
        excludePatternsToText(config.exclude_patterns) ||
      ffmpegPath.trim() !== config.ffmpeg_path ||
      normalizeQuality(quality) !== normalizeQuality(config.thumb_quality) ||
      normalizeCacheLimitMb(cacheLimit) !==
        normalizeCacheLimitMb(config.thumb_cache_limit_mb) ||
      startHidden !== config.shield_start_hidden ||
      rememberVolume !== config.remember_volume ||
      comfyUrl.trim() !== config.comfy_url ||
      comfyWorkflowsDir.trim() !== config.comfy_workflows_dir
    )
  }, [
    cacheLimit,
    comfyUrl,
    comfyWorkflowsDir,
    excludeText,
    ffmpegPath,
    quality,
    rememberVolume,
    settings,
    startHidden,
  ])

  const save = useCallback(async () => {
    setSaving(true)
    setError(null)
    setNotice(null)
    setComfyStatus(null)
    try {
      const nextPatterns = parseExcludePatterns(excludeText)
      const patch: SettingsPatch = {
        exclude_patterns: nextPatterns,
        ffmpeg_path: ffmpegPath.trim(),
        thumb_quality: normalizeQuality(quality),
        thumb_cache_limit_mb: normalizeCacheLimitMb(cacheLimit),
        shield_start_hidden: startHidden,
        remember_volume: rememberVolume,
        ...comfySettingsPatch(comfyUrl, comfyWorkflowsDir),
      }
      const next = await api.updateSettings(patch)
      applySettings(next)
      const rescan =
        excludePatternsToText(nextPatterns) !==
        excludePatternsToText(settings.config.exclude_patterns)
      setNotice(
        rescan
          ? '保存しました。除外パターンは次回の走査から反映されます'
          : '保存しました',
      )
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSaving(false)
    }
  }, [
    applySettings,
    cacheLimit,
    comfyUrl,
    comfyWorkflowsDir,
    excludeText,
    ffmpegPath,
    quality,
    rememberVolume,
    settings.config.exclude_patterns,
    startHidden,
  ])

  // -------------------------------------------------------------------------
  // ルート（即時反映）
  // -------------------------------------------------------------------------

  const addRoots = useCallback(async () => {
    setError(null)
    setNotice(null)
    setBusy('フォルダを選択しています…')
    try {
      const paths = await pickFolders()
      if (paths.length === 0) return
      const checks = await api.inspectRootPaths(paths)
      const directories = checks.filter((check) => check.kind === 'directory')
      if (directories.length === 0) {
        setError('フォルダを選んでください（ファイルは追加できません）')
        return
      }

      let added = 0
      for (const check of directories) {
        setBusy(`追加しています: ${check.path}`)
        const root = await api.addRoot(check.path, addDepth)
        added += 1
        setBusy(`走査しています: ${check.path}`)
        await api.scanRoot(root.id)
      }
      setNotice(`${formatCount(added)} 件のルートを追加して走査しました`)
      setRootsDirty(true)
      await reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }, [addDepth, reload])

  const changeRootEnabled = useCallback(
    async (rootId: number, enabled: boolean) => {
      setError(null)
      setNotice(null)
      try {
        await api.updateRoot(rootId, { enabled })
        setRootsDirty(true)
        setNotice(
          enabled
            ? 'ルートを有効にしました（ライブラリに戻ります）'
            : 'ルートを無効にしました（ライブラリから消えます）',
        )
        await reload()
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [reload],
  )

  const changeRootDepth = useCallback(
    async (rootId: number, depth: number) => {
      setError(null)
      setNotice(null)
      try {
        await api.updateRoot(rootId, { depth })
        setRootsDirty(true)
        setNotice('深さを変更しました。作品のまとまりは次回の走査から変わります')
        await reload()
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [reload],
  )

  const deleteRoot = useCallback(
    async (rootId: number) => {
      if (confirmDeleteRoot !== rootId) {
        setConfirmDeleteRoot(rootId)
        return
      }
      setConfirmDeleteRoot(null)
      setError(null)
      setNotice(null)
      try {
        await api.deleteRoot(rootId)
        setRootsDirty(true)
        setNotice('ルートを削除しました。作品とファイルの索引も消えました')
        await reload()
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [confirmDeleteRoot, reload],
  )

  // -------------------------------------------------------------------------
  // ffmpeg・キャッシュ
  // -------------------------------------------------------------------------

  const checkFfmpeg = useCallback(async () => {
    setError(null)
    setBusy('ffmpeg を確認しています…')
    try {
      const probe = await api.ffmpegProbe(ffmpegPath.trim() || null)
      setFfmpegChecked(probe)
      if (probe.error) setError(probe.error)
      else setNotice(`ffmpeg を確認しました: ${probe.path ?? ''}`)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }, [ffmpegPath])

  // #73: ComfyUI の接続確認。Rust は設定値だけを使うので、入力中の値を
  // 先に保存してから `GET /system_stats` を叩く（他の編集中の項目は触らない）。
  const checkComfy = useCallback(async () => {
    setError(null)
    setNotice(null)
    setComfyStatus(null)
    setBusy('ComfyUI に接続しています…')
    try {
      const next = await api.updateSettings(comfySettingsPatch(comfyUrl, comfyWorkflowsDir))
      // applySettings は使わない（編集中の除外パターン等を巻き戻さない）
      setSettings(next)
      setComfyUrl(next.config.comfy_url)
      setComfyWorkflowsDir(next.config.comfy_workflows_dir)
      const status = await api.comfyCheck()
      setComfyStatus(status)
      if (status.ok) setNotice(status.message)
      else setError(status.message)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }, [comfyUrl, comfyWorkflowsDir])

  const clearCache = useCallback(async () => {
    if (!confirmClearCache) {
      setConfirmClearCache(true)
      return
    }
    setConfirmClearCache(false)
    setError(null)
    setNotice(null)
    setBusy('キャッシュを削除しています…')
    try {
      const result = await api.clearThumbCache()
      setSettings((current) => ({ ...current, cache: result.cache }))
      setNotice(
        `キャッシュを削除しました: ${formatCount(result.removed)} ファイル / ${formatBytes(result.freed_bytes)}`,
      )
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }, [confirmClearCache])

  const usagePercent = cacheUsagePercent(settings.cache.bytes, settings.cache.limit_bytes)

  // -------------------------------------------------------------------------
  // 生成情報の索引（#60）
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (!open || !isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<MetaProgress>('meta://progress', (event) => {
      setMetaProgress(event.payload)
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [open])

  const indexMeta = useCallback(async () => {
    if (metaIndexing) return
    setMetaIndexing(true)
    setError(null)
    setNotice(null)
    setMetaProgress(null)
    let found = 0
    try {
      // 1 回 500 件ずつ、残りが無くなるまで続ける（暴走防止に上限つき）
      for (let guard = 0; guard < 200; guard += 1) {
        const summary: MetaIndexSummary = await api.indexMeta(500)
        found += summary.with_meta
        if (summary.total === 0 || summary.remaining === 0) break
      }
      const report = await api.metaReport()
      setMetaReport(report)
      setNotice(`生成情報を索引しました（${formatCount(found)} 件で見つかりました）`)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setMetaIndexing(false)
      setMetaProgress(null)
    }
  }, [metaIndexing])

  const metaPercent =
    metaReport && metaReport.total > 0
      ? Math.round((metaReport.with_meta / metaReport.total) * 100)
      : 0

  // バージョン表示（更新は Releases のインストーラを実行して上書きする運用）
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!isTauri()) return
    void getVersion()
      .then((value) => setAppVersion(value))
      .catch(() => undefined)
  }, [])
  const copyReleasesUrl = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(RELEASES_URL)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // クリップボードが使えない環境では何もしない（URL は表示されている）
    }
  }, [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-3xl"
          data-testid="settings-dialog"
          aria-label="設定"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings2 className="size-4 text-muted-foreground" aria-hidden="true" />
              設定
            </DialogTitle>
            <DialogDescription className="text-xs">
              ルート・除外パターン・ffmpeg・サムネイル・動作をまとめて変更します。設定は{' '}
              <code className="text-xs">{settings.config_path}</code> に保存されます。
            </DialogDescription>
          </DialogHeader>

          {offline && (
            <p className="m-0 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
              Tauri に接続できないため既定値を表示しています（表示確認用）。変更の保存には
              デスクトップアプリで開いてください。
            </p>
          )}
          {error && (
            <p
              className="m-0 rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-xs whitespace-pre-line text-destructive"
              role="alert"
            >
              {error}
            </p>
          )}
          {notice && (
            <p
              className="m-0 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs text-foreground"
              role="status"
            >
              {notice}
            </p>
          )}
          {busy && (
            <p className="m-0 flex items-center gap-2 text-xs text-muted-foreground" role="status">
              <RefreshCw className="size-3.5 animate-spin" aria-hidden="true" />
              {busy}
            </p>
          )}

          {/* ルート */}
          <section className="flex flex-col gap-2.5" aria-label="走査ルート">
            <SectionTitle icon={<HardDrive className="size-3.5" />} title="走査ルート" />
            <p className="m-0 text-xs text-muted-foreground">
              追加するとそのまま走査します。有効 / 無効は即時、深さは次回の走査から反映されます。
            </p>

            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                <span>作品の単位（追加時）</span>
                <select
                  className="h-8 rounded-lg border border-input bg-black/25 px-2 text-xs text-foreground"
                  value={addDepth}
                  aria-label="追加するルートの深さ"
                  onChange={(event) => setAddDepth(Number(event.target.value))}
                >
                  {DEPTHS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button size="sm" onClick={() => void addRoots()} disabled={busy !== null}>
                <FolderPlus data-icon="inline-start" />
                フォルダを選んで追加
              </Button>
            </div>

            {settings.roots.length === 0 ? (
              <p className="m-0 rounded-lg border border-border bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
                登録されたルートはありません。
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {settings.roots.map(({ root, works, files, total_bytes, last_scan_at }) => (
                  <li
                    key={root.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-2.5 py-2"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <p className="m-0 flex flex-wrap items-center gap-1.5 text-[13px] font-semibold">
                        {root.label}
                        <Badge
                          variant="outline"
                          className="h-[1.15rem] px-1.5 text-xs text-muted-foreground"
                        >
                          深さ {root.depth}
                        </Badge>
                        {!root.enabled && (
                          <Badge
                            variant="outline"
                            className="h-[1.15rem] border-warning/55 px-1.5 text-xs text-warning"
                          >
                            無効
                          </Badge>
                        )}
                        {root.duplicate_of !== null && (
                          <Badge
                            variant="outline"
                            className="h-[1.15rem] border-warning/55 px-1.5 text-xs text-warning"
                          >
                            重複 #{root.duplicate_of}
                          </Badge>
                        )}
                      </p>
                      <code className="text-xs break-all text-muted-foreground">{root.path}</code>
                      <p className="m-0 text-xs text-muted-foreground">
                        作品 {formatCount(works)} / ファイル {formatCount(files)} /{' '}
                        {formatBytes(total_bytes)} / 最終走査 {formatDate(last_scan_at)}
                      </p>
                    </div>
                    <div className="flex flex-none flex-wrap items-center gap-2">
                      <label className="flex items-center gap-1.5 text-xs">
                        <Checkbox
                          checked={root.enabled}
                          aria-label={`${root.label} を有効にする`}
                          onCheckedChange={(value) =>
                            void changeRootEnabled(root.id, value === true)
                          }
                        />
                        有効
                      </label>
                      <select
                        className="h-8 rounded-lg border border-input bg-black/25 px-2 text-xs text-foreground"
                        value={root.depth}
                        aria-label={`${root.label} の深さ`}
                        onChange={(event) =>
                          void changeRootDepth(root.id, Number(event.target.value))
                        }
                      >
                        {DEPTHS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant={confirmDeleteRoot === root.id ? 'destructive' : 'ghost'}
                        size="xs"
                        onClick={() => void deleteRoot(root.id)}
                        title={
                          confirmDeleteRoot === root.id
                            ? 'もう一度押すと索引ごと削除します'
                            : 'ルートを削除'
                        }
                      >
                        <Trash2 data-icon="inline-start" />
                        {confirmDeleteRoot === root.id ? '本当に削除' : '削除'}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <Separator />

          {/* 除外パターン */}
          <section className="flex flex-col gap-2" aria-label="除外パターン">
            <SectionTitle icon={<ShieldCheck className="size-3.5" />} title="除外パターン" />
            <p className="m-0 text-xs text-muted-foreground">
              1 行 1 パターンの glob（<code>*</code> は任意の文字、<code>?</code> は 1
              文字）。ファイル名とルートからの相対パスの両方に当たります。変更は
              <strong className="text-foreground">次回の走査</strong>から反映されます。
            </p>
            <textarea
              className="min-h-24 rounded-lg border border-input bg-black/25 px-2.5 py-2 font-mono text-xs text-foreground"
              value={excludeText}
              aria-label="除外パターン（1 行 1 件）"
              spellCheck={false}
              onChange={(event) => setExcludeText(event.target.value)}
            />
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="xs"
                onClick={() => setExcludeText(excludePatternsToText(DEFAULT_EXCLUDE_PATTERNS))}
              >
                既定値に戻す
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setExcludeText('')}
                title="何も除外しません（ドット始まりのフォルダも走査します）"
              >
                すべてクリア
              </Button>
            </div>
          </section>

          <Separator />

          {/* ffmpeg */}
          <section className="flex flex-col gap-2" aria-label="ffmpeg">
            <SectionTitle icon={<Film className="size-3.5" />} title="ffmpeg（動画サムネイル）" />
            <div className="rounded-lg border border-border bg-muted/25 px-2.5 py-2 text-xs">
              <p className="m-0 flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground">自動検出:</span>
                <code className="break-all text-foreground">
                  {ffmpegChecked?.path ?? '見つかりません'}
                </code>
                {ffmpegChecked && (
                  <Badge variant="outline" className="h-[1.1rem] px-1.5 text-xs">
                    {FFMPEG_SOURCE_LABEL[ffmpegChecked.source] ?? ffmpegChecked.source}
                  </Badge>
                )}
              </p>
              {ffmpegChecked?.version && (
                <p className="mt-1 mb-0 truncate text-xs text-muted-foreground">
                  {ffmpegChecked.version}
                </p>
              )}
              {ffmpegChecked?.error && (
                <p className="mt-1 mb-0 text-xs text-warning">{ffmpegChecked.error}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                className="min-w-0 flex-1 bg-black/25"
                value={ffmpegPath}
                placeholder="空欄なら自動検出（例: C:\tools\ffmpeg.exe）"
                aria-label="ffmpeg のパス"
                spellCheck={false}
                onChange={(event) => setFfmpegPath(event.target.value)}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => void checkFfmpeg()}
                disabled={busy !== null}
              >
                存在チェック
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setFfmpegPath('')
                  setFfmpegChecked(null)
                }}
              >
                自動検出に戻す
              </Button>
            </div>
          </section>

          <Separator />

          {/* サムネイル */}
          <section className="flex flex-col gap-2" aria-label="サムネイル">
            <SectionTitle icon={<CheckCircle2 className="size-3.5" />} title="サムネイル" />
            <label className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-20 text-muted-foreground">品質</span>
              <input
                type="range"
                min={QUALITY_MIN}
                max={QUALITY_MAX}
                step={1}
                value={quality}
                aria-label="サムネイルの品質"
                className="h-1.5 min-w-40 flex-1 accent-[var(--accent-cyan)]"
                onChange={(event) => setQuality(Number(event.target.value))}
              />
              <span className="w-10 text-right tabular-nums">{quality}</span>
            </label>
            <label className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-20 text-muted-foreground">キャッシュ上限</span>
              <Input
                type="number"
                min={0}
                max={102400}
                value={cacheLimit}
                aria-label="キャッシュ上限（MB）"
                className="h-8 w-24 bg-black/25 tabular-nums"
                onChange={(event) => setCacheLimit(Number(event.target.value))}
              />
              <span className="text-muted-foreground">MB（0 = 無制限）</span>
            </label>

            <div className="rounded-lg border border-border bg-muted/25 px-2.5 py-2 text-xs">
              <p className="m-0 flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground">使用量</span>
                <span className="tabular-nums">
                  {formatBytes(settings.cache.bytes)} /{' '}
                  {settings.cache.limit_bytes > 0
                    ? formatBytes(settings.cache.limit_bytes)
                    : '無制限'}{' '}
                  （{formatCount(settings.cache.files)} ファイル）
                  {settings.cache.limit_bytes > 0 && ` / ${usagePercent}%`}
                </span>
              </p>
              <code className="mt-1 block break-all text-xs text-muted-foreground">
                {settings.cache.path}
              </code>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant={confirmClearCache ? 'destructive' : 'outline'}
                size="sm"
                onClick={() => void clearCache()}
                disabled={busy !== null}
                title="次回必要になったサムネイルは再生成されます"
              >
                <Trash2 data-icon="inline-start" />
                {confirmClearCache ? 'もう一度押すと削除' : 'キャッシュを削除'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void reload()}
                disabled={loading || busy !== null}
              >
                <RefreshCw data-icon="inline-start" />
                再読み込み
              </Button>
            </div>
          </section>

          <Separator />

          {/* 生成情報（#60） */}
          <section className="flex flex-col gap-2" aria-label="生成情報">
            <SectionTitle icon={<Sparkles className="size-3.5" />} title="生成情報（メタデータ）" />
            <p className="m-0 text-xs text-muted-foreground">
              画像・動画に埋め込まれたプロンプト・モデル・シード等を索引すると、検索欄の
              「生成情報も検索」で作品を絞り込めます。重いので必要なときだけ実行してください。
            </p>

            <div className="rounded-lg border border-border bg-muted/25 px-2.5 py-2 text-xs">
              {metaReport ? (
                <>
                  <p className="m-0 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-muted-foreground">メタデータ付与率</span>
                    <span className="tabular-nums">
                      {metaPercent}%（{formatCount(metaReport.with_meta)} /{' '}
                      {formatCount(metaReport.total)} ファイル）
                    </span>
                  </p>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/30">
                    <div
                      className="h-full rounded-full bg-[var(--accent-cyan)]"
                      style={{ width: `${metaPercent}%` }}
                    />
                  </div>
                  {metaReport.by_root.length > 0 && (
                    <ul className="mt-1.5 m-0 list-none space-y-0.5 p-0 text-xs text-muted-foreground">
                      {metaReport.by_root.map((entry) => (
                        <li key={entry.root_id} className="flex justify-between gap-2">
                          <span className="truncate">{entry.label}</span>
                          <span className="shrink-0 tabular-nums">
                            {formatCount(entry.with_meta)} / {formatCount(entry.total)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="m-0 text-muted-foreground">付与率を取得できませんでした。</p>
              )}
            </div>

            {metaProgress && metaProgress.total > 0 && (
              <p className="m-0 text-xs text-muted-foreground tabular-nums" role="status">
                索引中… {formatCount(metaProgress.done)} / {formatCount(metaProgress.total)}
                （見つかった: {formatCount(metaProgress.with_meta)}）
              </p>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void indexMeta()}
                disabled={metaIndexing || offline || busy !== null}
                title="未索引のファイルだけを読みます（何度でも実行できます）"
              >
                <Sparkles data-icon="inline-start" />
                {metaIndexing ? '索引しています…' : '生成情報を索引する'}
              </Button>
              {metaIndexing && (
                <RefreshCw className="size-3.5 animate-spin text-primary" aria-hidden="true" />
              )}
            </div>
          </section>

          <Separator />

          {/* ComfyUI（#73） */}
          <section className="flex flex-col gap-2" aria-label="ComfyUI">
            <SectionTitle icon={<Wand2 className="size-3.5" />} title="ComfyUI 連携" />
            <p className="m-0 text-xs text-muted-foreground">
              生成情報パネルの「ComfyUI へ」で workflow を開き、「この設定で再実行」で API 形式の
              プロンプトを ComfyUI のキューへ送ります。ローカルの ComfyUI（http）を想定しています。
            </p>
            <label className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-24 text-muted-foreground">URL</span>
              <Input
                className="min-w-0 flex-1 bg-black/25"
                value={comfyUrl}
                placeholder="http://127.0.0.1:8188"
                aria-label="ComfyUI の URL"
                spellCheck={false}
                onChange={(event) => {
                  setComfyUrl(event.target.value)
                  setComfyStatus(null)
                }}
              />
            </label>
            <label className="flex flex-wrap items-center gap-2 text-xs">
              <span className="w-24 flex-none text-muted-foreground">workflows</span>
              <Input
                className="min-w-0 flex-1 bg-black/25"
                value={comfyWorkflowsDir}
                placeholder="例: D:\ComfyUI\user\default\workflows"
                aria-label="ComfyUI の workflows フォルダ"
                spellCheck={false}
                onChange={(event) => {
                  setComfyWorkflowsDir(event.target.value)
                  setComfyStatus(null)
                }}
              />
            </label>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              workflows フォルダは「ComfyUI へ」で workflow を{' '}
              <code className="rounded bg-muted px-1">&lt;name&gt;.json</code> として保存する場所です
              （ComfyUI の <code className="rounded bg-muted px-1">user/default/workflows</code>）。
              空欄なら保存せず、API 形式のコピーだけを使えます。
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void checkComfy()}
                disabled={busy !== null || offline}
                title="入力中の URL を保存してから GET /system_stats で確認します"
              >
                <Wand2 data-icon="inline-start" />
                {busy === 'ComfyUI に接続しています…' ? '確認しています…' : '接続確認'}
              </Button>
              {comfyStatus && (
                <Badge variant={comfyStatus.ok ? 'default' : 'destructive'}>
                  {comfyStatus.ok ? '接続 OK' : '接続できません'}
                </Badge>
              )}
            </div>
            {comfyStatus && (
              <p
                className={`m-0 text-xs ${
                  comfyStatus.ok ? 'text-[var(--success)]' : 'text-[var(--destructive)]'
                }`}
                role="status"
              >
                {comfyStatus.message}
              </p>
            )}
          </section>

          <Separator />

          {/* 動作 */}
          <section className="flex flex-col gap-2" aria-label="動作">
            <SectionTitle icon={<ShieldCheck className="size-3.5" />} title="動作" />
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={startHidden}
                aria-label="起動時に隠す"
                onCheckedChange={(value) => setStartHidden(value === true)}
              />
              <span>
                起動直後から隠した状態で開始する（#22）
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  次回起動時から有効になります。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                checked={rememberVolume}
                aria-label="音量を保存する"
                onCheckedChange={(value) => setRememberVolume(value === true)}
              />
              <span>
                動画の音量を保存する
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  既定はオフ（毎回ミュート）。オフのままなら次回も音は出ません。
                </span>
              </span>
            </label>
          </section>

          <Separator />

          {/* バージョン / 更新 */}
          <section className="flex flex-col gap-1.5" aria-label="バージョン">
            <SectionTitle icon={<Info className="size-3.5" />} title="バージョン / 更新" />
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="tabular-nums">v{appVersion ?? '—'}</span>
              <Button variant="ghost" size="sm" onClick={() => void copyReleasesUrl()}>
                <Copy data-icon="inline-start" />
                {copied ? 'コピーしました' : '更新用URLをコピー'}
              </Button>
            </div>
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              更新は <code className="rounded bg-muted px-1">{RELEASES_URL}</code>{' '}
              から新しい NSIS インストーラを取得して実行すると、そのまま上書きされます。
              設定・索引・タグは保持されます（portable exe は手動で置き換え）。
            </p>
          </section>

          <DialogFooter className="gap-2">
            <span className="mr-auto text-xs text-muted-foreground">
              {settings.thumbs.max_edge}px / 並列 {settings.thumbs.parallelism} / 長辺は #3
              の既定値
            </span>
            <Button variant="outline" onClick={close}>
              閉じる
            </Button>
            <Button onClick={() => void save()} disabled={saving || offline || !dirty}>
              {saving ? '保存しています…' : dirty ? '保存' : '保存済み'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
  )
}

function SectionTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <h3 className="m-0 flex items-center gap-1.5 text-[13px] font-semibold tracking-wide">
      <span className="text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      {title}
    </h3>
  )
}
