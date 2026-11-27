# ffmpeg を Tauri の sidecar として使える名前で src-tauri/binaries/ に配置する。
#
# 既定では gyan.dev のバージョン固定 zip をダウンロードし、公開 SHA-256 と照合してから
# 展開する。URL・SHA-256・サイズは docs/release.md の手順で 3 点同時に更新する。
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
#
# 手元の ffmpeg を使う場合（-SourceSha256 を渡すとその exe も検証する）:
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1 `
#       -Source C:\path\to\ffmpeg.exe -SourceSha256 <64桁のhex>
#
# バイナリは .gitignore 済み。コミットしないこと。
param(
    [string]$Source = '',
    [string]$SourceSha256 = '',
    [string]$Url = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.1-essentials_build.zip',
    [string]$Sha256 = 'b9bbbb3acece000cbeec994f856649354e52c773807841e78908374b24d658fd',
    [long]$Size = 119467219,
    [string]$TargetTriple = 'x86_64-pc-windows-msvc'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$destDir = Join-Path $root 'src-tauri\binaries'
$dest = Join-Path $destDir "ffmpeg-$TargetTriple.exe"

function Get-Sha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Sha256([string]$Path, [string]$Expected, [string]$Label) {
    $expected = $Expected.Trim().ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        throw "$Label の SHA-256 は 64 桁の hex で指定してください: '$Expected'"
    }
    $actual = Get-Sha256 $Path
    if ($actual -ne $expected) {
        throw "$Label の SHA-256 が一致しません: expected=$expected actual=$actual path=$Path"
    }
    Write-Output "$Label SHA-256 OK: $actual"
}

$tempRoot = $null
try {
    if ($Source) {
        if (-not (Test-Path -LiteralPath $Source)) {
            throw @"
ffmpeg が見つかりません: $Source

次のどちらかで用意してください。
  1. 既定のダウンロードを使う（URL と SHA-256 を検証）
     powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
  2. 既存の ffmpeg をコピーする
     powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1 -Source <ffmpeg.exe のパス> -SourceSha256 <64桁のhex>
"@
        }

        $sourceHash = Get-Sha256 $Source
        if ($SourceSha256) {
            Assert-Sha256 $Source $SourceSha256 'コピー元 ffmpeg.exe' | Out-Null
        }
        else {
            Write-Warning "コピー元 ffmpeg.exe の SHA-256 は未検証です: $sourceHash"
            Write-Warning "-SourceSha256 を渡すと照合できます。"
        }
        $exePath = (Resolve-Path -LiteralPath $Source).Path
    }
    else {
        $tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("fetch-ffmpeg-" + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null
        $zip = Join-Path $tempRoot 'ffmpeg.zip'
        $extractDir = Join-Path $tempRoot 'extracted'

        Write-Output "downloading $Url"
        Invoke-WebRequest -Uri $Url -OutFile $zip -UseBasicParsing

        Assert-Sha256 $zip $Sha256 'ffmpeg zip'
        $actualSize = (Get-Item -LiteralPath $zip).Length
        if ($actualSize -ne $Size) {
            throw "ffmpeg zip のサイズが一致しません: expected=$Size actual=$actualSize url=$Url"
        }
        Write-Output "ffmpeg zip size OK: $actualSize B"

        Expand-Archive -Path $zip -DestinationPath $extractDir -Force
        $exe = Get-ChildItem $extractDir -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
        if (-not $exe) {
            throw 'アーカイブ内に ffmpeg.exe が見つかりません'
        }
        $exePath = $exe.FullName
    }

    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
    Copy-Item -LiteralPath $exePath -Destination $dest -Force

    $item = Get-Item -LiteralPath $dest
    if ($item.Length -lt 1MB) {
        throw "コピーしたファイルが小さすぎます（$($item.Length) bytes）: $dest"
    }

    Write-Output ("placed {0} ({1:N1} MB)" -f $dest, ($item.Length / 1MB))
    & $dest -version | Select-Object -First 1
}
finally {
    if ($tempRoot -and (Test-Path -LiteralPath $tempRoot)) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
