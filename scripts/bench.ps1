#requires -Version 5.1
<#
.SYNOPSIS
  works-browser の性能計測（Issue #10）を再現する。

.DESCRIPTION
  GUI は起動しない。実データは読み取りのみで、書き込みは -OutDir の下だけ。
  計測結果（JSON と Markdown の表）を -OutDir に残す。

  1. ルートごとに初回走査 + 再走査（差分）: bench scan --repeat 2
  2. ルートごとにサムネイル生成（既定 1,000 枚まで）: bench thumbs
  3. 10 万行の合成 DB で作品 / ファイル一覧のクエリ時間: bench query

.PARAMETER Bin
  bench.exe のパス。既定は src-tauri/target/release/bench.exe。

.PARAMETER OutDir
  DB・サムネイル・JSON の出力先。既定は %TEMP%\works-browser-bench。

.PARAMETER Roots
  計測するフォルダ。存在しないものはスキップする。

.PARAMETER ThumbLimit
  1 ルートあたりに生成するサムネイルの上限（既定 1,000）。

.PARAMETER QueryRows
  合成 DB のファイル行数（既定 100,000）。

.PARAMETER SkipBuild
  bench.exe を作り直さない（既にある成果物を使う）。

.PARAMETER KeepThumbs
  生成したサムネイルのキャッシュを残す（既定は計測後に削除）。

.EXAMPLE
  .\scripts\bench.ps1

.EXAMPLE
  .\scripts\bench.ps1 -SkipBuild -OutDir D:\Temp\works-browser-bench -ThumbLimit 2000
#>
param(
  [string]$Bin,
  [string]$OutDir = (Join-Path $env:TEMP 'works-browser-bench'),
  [string[]]$Roots = @('D:\Media\Gamma', 'D:\Media\Alpha', 'D:\ComfyUI\output'),
  [int]$ThumbLimit = 1000,
  [int]$QueryRows = 100000,
  [switch]$SkipBuild,
  [switch]$KeepThumbs
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$srcTauri = Join-Path $repo 'src-tauri'

if (-not $Bin) { $Bin = Join-Path $srcTauri 'target\release\bench.exe' }

function Write-Section([string]$Text) {
  Write-Host ""
  Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Invoke-Bench {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$JsonPath
  )
  Write-Section $Label
  $lines = & $Bin @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "bench が失敗しました (exit $LASTEXITCODE): $Bin $($Arguments -join ' ')"
  }
  # PS 5.1 の `>` は UTF-16 になるため、UTF-8 で明示的に書く
  $lines | Set-Content -Path $JsonPath -Encoding UTF8
  # --json の出力はファイルに残すので、画面には要点だけ出す
  $data = ($lines -join "`n") | ConvertFrom-Json
  return $data
}

function Format-Gb([double]$Bytes) {
  return ('{0:N1} GB' -f ($Bytes / 1GB))
}

function Format-Mb([double]$Bytes) {
  return ('{0:N1} MB' -f ($Bytes / 1MB))
}

function Remove-Db([string]$Path) {
  foreach ($suffix in @('', '-wal', '-shm', '-journal')) {
    $candidate = "$Path$suffix"
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate -Force }
  }
}

# --- 準備 ---------------------------------------------------------------

if (-not (Test-Path -LiteralPath (Join-Path $srcTauri 'binaries\ffmpeg-x86_64-pc-windows-msvc.exe'))) {
  # tauri のビルドスクリプトが bundle.externalBin の実ファイルを要求する（CI と同じスタブ）
  New-Item -ItemType Directory -Force -Path (Join-Path $srcTauri 'binaries') | Out-Null
  New-Item -ItemType File -Force -Path (Join-Path $srcTauri 'binaries\ffmpeg-x86_64-pc-windows-msvc.exe') | Out-Null
}

if (-not $SkipBuild -or -not (Test-Path -LiteralPath $Bin)) {
  Write-Section "bench をビルド（release）"
  Push-Location $srcTauri
  try {
    & cargo build --release --bin bench
    if ($LASTEXITCODE -ne 0) { throw "cargo build --release --bin bench が失敗しました" }
  }
  finally {
    Pop-Location
  }
}

if (-not (Test-Path -LiteralPath $Bin)) { throw "bench.exe が見つかりません: $Bin" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Write-Host "bench : $Bin"
Write-Host "outdir: $OutDir"

$scanResults = @()
$thumbResults = @()

foreach ($root in $Roots) {
  if (-not (Test-Path -LiteralPath $root)) {
    Write-Warning "計測対象が無いためスキップします: $root"
    continue
  }

  $slug = (Split-Path -Leaf $root) -replace '[^A-Za-z0-9._-]', '-'
  $db = Join-Path $OutDir "index-$slug.db"
  $cache = Join-Path $OutDir "thumbs-$slug"

  # 初回走査を測るので DB は毎回作り直す（実データ側は読み取りのみ）
  Remove-Db $db
  Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue

  $scan = Invoke-Bench -Label "走査: $root" -Arguments @(
    'scan', $root, '--depth', '1', '--repeat', '2', '--db', $db, '--json'
  ) -JsonPath (Join-Path $OutDir "scan-$slug.json")

  $first = $scan.runs[0]
  $rescan = $scan.runs[$scan.runs.Count - 1]
  $scanResults += [pscustomobject]@{
    root         = $root
    files        = [int64]$first.files
    works        = [int64]$first.works
    bytes        = [int64]$first.total_bytes
    first_ms     = [int64]$first.elapsed_ms
    rescan_ms    = [int64]$rescan.elapsed_ms
    peak_rss     = [int64]$scan.peak_working_set_bytes
    db_bytes     = [int64]$scan.db_bytes
    duplicates   = [int64]$first.duplicates
  }

  $thumb = Invoke-Bench -Label "サムネイル: $root（上限 $ThumbLimit 枚）" -Arguments @(
    'thumbs', "$($scan.root_id)", '--limit', "$ThumbLimit", '--db', $db, '--cache', $cache, '--json'
  ) -JsonPath (Join-Path $OutDir "thumbs-$slug.json")

  $thumbResults += [pscustomobject]@{
    root       = $root
    generated  = [int64]$thumb.generated
    failed     = [int64]$thumb.failed
    images     = [int64]$thumb.pending_by_kind.image
    videos     = [int64]$thumb.pending_by_kind.video
    elapsed_ms = [int64]$thumb.elapsed_ms
    per_sec    = [double]$thumb.thumbs_per_sec
    peak_rss   = [int64]$thumb.peak_working_set_bytes
  }

  if (-not $KeepThumbs) {
    Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# --- 10 万行の合成 DB でクエリ時間 --------------------------------------

$queryDb = Join-Path $OutDir 'synthetic.db'
Remove-Db $queryDb
$query = Invoke-Bench -Label "クエリ: $QueryRows 行の合成 DB" -Arguments @(
  'query', '--rows', "$QueryRows", '--repeat', '5', '--db', $queryDb, '--json'
) -JsonPath (Join-Path $OutDir 'query.json')

Remove-Db $queryDb

# --- まとめ（Markdown） -------------------------------------------------

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# works-browser 性能計測結果（$stamp）")
$lines.Add('')
$lines.Add('`scripts/bench.ps1` による自動計測。GUI は起動していない（ヘッドレスで測れる範囲のみ）。')
$lines.Add('')
$lines.Add('## 走査（初回 / 再走査）')
$lines.Add('')
$lines.Add('| ルート | ファイル | 作品 | サイズ | 初回 | 再走査(差分) | ピーク RSS | DB |')
$lines.Add('|---|---:|---:|---:|---:|---:|---:|---:|')
foreach ($row in $scanResults) {
  $lines.Add(('| `{0}` | {1:N0} | {2:N0} | {3} | {4:N2} 秒 | {5:N2} 秒 | {6} | {7} |' -f `
        $row.root, $row.files, $row.works, (Format-Gb $row.bytes),
    ($row.first_ms / 1000.0), ($row.rescan_ms / 1000.0),
    (Format-Mb $row.peak_rss), (Format-Mb $row.db_bytes)))
}
$lines.Add('')
$lines.Add('## サムネイル生成')
$lines.Add('')
$lines.Add('| ルート | 生成 | 失敗 | 画像/動画（未生成） | 時間 | 枚/秒 | ピーク RSS |')
$lines.Add('|---|---:|---:|---:|---:|---:|---:|')
foreach ($row in $thumbResults) {
  $lines.Add(('| `{0}` | {1:N0} | {2:N0} | {3:N0} / {4:N0} | {5:N2} 秒 | {6:N1} | {7} |' -f `
        $row.root, $row.generated, $row.failed, $row.images, $row.videos,
    ($row.elapsed_ms / 1000.0), $row.per_sec, (Format-Mb $row.peak_rss)))
}
$lines.Add('')
$lines.Add("## クエリ（合成 DB: $QueryRows 行 / 作品 $($query.works) 件）")
$lines.Add('')
$lines.Add('| クエリ | コールド | 中央値 | min | max |')
$lines.Add('|---|---:|---:|---:|---:|')
foreach ($timing in $query.timings) {
  $lines.Add(('| {0} | {1:N2} ms | {2:N2} ms | {3:N2} ms | {4:N2} ms |' -f `
        $timing.label, $timing.cold_ms, $timing.median_ms, $timing.min_ms, $timing.max_ms))
}
$lines.Add('')
$lines.Add("DB 構築: $('{0:N2}' -f ($query.build_ms / 1000.0)) 秒 / DB サイズ: $(Format-Mb $query.db_bytes)")
$lines.Add('')
$lines.Add('サムネイル上限は `-ThumbLimit`、行数は `-QueryRows` で変更できる。')

$summaryPath = Join-Path $OutDir 'perf-summary.md'
$lines | Set-Content -Path $summaryPath -Encoding UTF8

Write-Section '結果'
Write-Host ($lines -join "`n")
Write-Host ""
Write-Host "JSON と表を保存しました: $OutDir" -ForegroundColor Green
Write-Host "  - $summaryPath"
