# 1024x1024 のアプリアイコン原画 (assets/icon.png) を生成する。
#   powershell -ExecutionPolicy Bypass -File scripts/generate-icon.ps1
# 生成した原画から実際のアイコン一式を作るには:
#   npm run tauri icon assets/icon.png
param(
    [string]$OutFile = (Join-Path $PSScriptRoot '..\assets\icon.png')
)

Add-Type -AssemblyName System.Drawing

$size = 1024
$bmp = [System.Drawing.Bitmap]::new($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
    $p = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $d = $r * 2
    $p.AddArc($x, $y, $d, $d, 180, 90)
    $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $p.CloseFigure()
    return $p
}

function New-SolidBrush([string]$hex) {
    return [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($hex))
}

# 背景（角丸スクエア + 縦グラデーション）
$bgPath = New-RoundedPath 32 32 960 960 200
$bgBrush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
    [System.Drawing.Point]::new(0, 0),
    [System.Drawing.Point]::new(0, $size),
    [System.Drawing.ColorTranslator]::FromHtml('#33415C'),
    [System.Drawing.ColorTranslator]::FromHtml('#151C2A')
)
$g.FillPath($bgBrush, $bgPath)

# 作品カードを扇状に 3 枚
$cards = @(
    @{ Angle = -16; Dx = -96; Dy = 40; Fill = '#4A5B7E'; W = 420; H = 500 },
    @{ Angle = -5; Dx = -18; Dy = 4; Fill = '#8FA3C8'; W = 420; H = 500 },
    @{ Angle = 7; Dx = 74; Dy = -30; Fill = '#EDF1F8'; W = 420; H = 500 }
)

$cx = 512.0
$cy = 512.0
foreach ($card in $cards) {
    $state = $g.Save()
    $g.TranslateTransform($cx + $card.Dx, $cy + $card.Dy)
    $g.RotateTransform($card.Angle)
    $w = $card.W
    $h = $card.H
    $path = New-RoundedPath (-$w / 2) (-$h / 2) $w $h 56
    $brush = New-SolidBrush $card.Fill
    $g.FillPath($brush, $path)

    if ($card.Fill -eq '#EDF1F8') {
        # カード上部の「サムネイル帯」
        $band = New-RoundedPath (-$w / 2 + 40) (-$h / 2 + 40) ($w - 80) 268 32
        $bandBrush = New-SolidBrush '#3B4B6B'
        $g.FillPath($bandBrush, $band)
        $bandBrush.Dispose()
        $band.Dispose()

        # 再生マーク
        $play = [System.Drawing.Drawing2D.GraphicsPath]::new()
        $play.AddPolygon([System.Drawing.Point[]]@(
                [System.Drawing.Point]::new(-34, -136),
                [System.Drawing.Point]::new(62, -76),
                [System.Drawing.Point]::new(-34, -16)
            ))
        $playBrush = New-SolidBrush '#EDF1F8'
        $g.FillPath($playBrush, $play)
        $playBrush.Dispose()
        $play.Dispose()

        # 下段のテキスト行を模したバー
        $bar1 = New-RoundedPath (-$w / 2 + 40) 60 300 44 22
        $bar2 = New-RoundedPath (-$w / 2 + 40) 136 200 44 22
        $barBrush = New-SolidBrush '#C3CCDD'
        $g.FillPath($barBrush, $bar1)
        $g.FillPath($barBrush, $bar2)
        $barBrush.Dispose()
        $bar1.Dispose()
        $bar2.Dispose()
    }

    $brush.Dispose()
    $path.Dispose()
    $g.Restore($state)
}

# 外周のヘアライン
$borderPen = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#55648A'), 10)
$g.DrawPath($borderPen, $bgPath)

$bgBrush.Dispose()
$borderPen.Dispose()
$bgPath.Dispose()
$g.Dispose()

$resolved = [System.IO.Path]::GetFullPath($OutFile)
$dir = Split-Path -Parent $resolved
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($resolved, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "wrote $resolved"
