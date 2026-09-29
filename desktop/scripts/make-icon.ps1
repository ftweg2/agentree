# Generate icons-src/icon.png (1024x1024): a simple tree / fork shape.
# Usage: powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1 ; then: npm run icon
# (ASCII only on purpose: Windows PowerShell 5.1 reads BOM-less files as ANSI.)
Add-Type -AssemblyName System.Drawing

$size = 1024
$s = $size / 64.0
$dir = Join-Path $PSScriptRoot '..\icons-src'
New-Item -ItemType Directory -Force $dir | Out-Null
$out = Join-Path (Resolve-Path $dir).Path 'icon.png'

$bmp = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

$bg = [System.Drawing.Color]::FromArgb(255, 0x3f, 0xb6, 0x8b)
$fg = [System.Drawing.Color]::FromArgb(255, 0x0f, 0x11, 0x15)

# Rounded square background (64x64 design grid, same as ui/index.html SVG)
$r = 14 * $s
$x0 = 2 * $s; $y0 = 2 * $s; $w = 60 * $s
$path = New-Object -TypeName System.Drawing.Drawing2D.GraphicsPath
$path.AddArc([single]$x0, [single]$y0, [single](2 * $r), [single](2 * $r), 180, 90)
$path.AddArc([single]($x0 + $w - 2 * $r), [single]$y0, [single](2 * $r), [single](2 * $r), 270, 90)
$path.AddArc([single]($x0 + $w - 2 * $r), [single]($y0 + $w - 2 * $r), [single](2 * $r), [single](2 * $r), 0, 90)
$path.AddArc([single]$x0, [single]($y0 + $w - 2 * $r), [single](2 * $r), [single](2 * $r), 90, 90)
$path.CloseFigure()
$bgBrush = New-Object -TypeName System.Drawing.SolidBrush -ArgumentList $bg
$g.FillPath($bgBrush, $path)

# Edges
$pen = New-Object -TypeName System.Drawing.Pen -ArgumentList $fg, ([single](4.2 * $s))
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$lines = @(
  @(32, 18, 32, 28),
  @(18, 28, 46, 28),
  @(18, 28, 18, 40),
  @(46, 28, 46, 40),
  @(40, 44, 52, 44),
  @(40, 44, 40, 48),
  @(52, 44, 52, 48)
)
foreach ($l in $lines) {
  $g.DrawLine($pen, [single]($l[0] * $s), [single]($l[1] * $s), [single]($l[2] * $s), [single]($l[3] * $s))
}

# Nodes
$brush = New-Object -TypeName System.Drawing.SolidBrush -ArgumentList $fg
$nodes = @(
  @(32, 16, 5.5),
  @(18, 43, 5),
  @(46, 41, 4.5),
  @(40, 50, 3.6),
  @(52, 50, 3.6)
)
foreach ($n in $nodes) {
  $rad = $n[2]
  $g.FillEllipse($brush, [single](($n[0] - $rad) * $s), [single](($n[1] - $rad) * $s), [single](2 * $rad * $s), [single](2 * $rad * $s))
}

$g.Dispose()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "icon written: $out"
