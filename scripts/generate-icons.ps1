Add-Type -AssemblyName System.Drawing

function New-Icon {
    param(
        [int]$Size,
        [string]$OutPath
    )

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    # ── Rounded-square red background ──────────────────────────────────────
    $bgColor = [System.Drawing.ColorTranslator]::FromHtml('#d62728')
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    $r = [int]([Math]::Max(2, $Size * 0.22))   # corner radius
    $d = $r * 2                                # diameter of corner arc

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($Size - $d - 1, 0, $d, $d, 270, 90)
    $path.AddArc($Size - $d - 1, $Size - $d - 1, $d, $d, 0, 90)
    $path.AddArc(0, $Size - $d - 1, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($bgBrush, $path)

    # Subtle top highlight for a bit of depth
    $g.SetClip($path)
    $highlightColor = [System.Drawing.Color]::FromArgb(25, 255, 255, 255)
    $highlightBrush = New-Object System.Drawing.SolidBrush($highlightColor)
    $hw = [single]$Size
    $hh = [single]($Size * 0.5)
    $highlightRect = [System.Drawing.RectangleF]::new([single]0, [single]0, $hw, $hh)
    $g.FillRectangle($highlightBrush, $highlightRect)
    $g.ResetClip()

    # ── "OC" text, bold, white ─────────────────────────────────────────────
    $fontRatio = if ($Size -le 16) { 0.70 } elseif ($Size -le 48) { 0.62 } else { 0.58 }
    $fontSize = [single]($Size * $fontRatio)

    $fontFamily = $null
    foreach ($name in @('Segoe UI Semibold', 'Segoe UI', 'Arial Black', 'Arial')) {
        try {
            $fontFamily = New-Object System.Drawing.FontFamily($name)
            break
        } catch {}
    }
    if (-not $fontFamily) { $fontFamily = [System.Drawing.FontFamily]::GenericSansSerif }

    $font = New-Object System.Drawing.Font(
        $fontFamily,
        $fontSize,
        [System.Drawing.FontStyle]::Bold,
        [System.Drawing.GraphicsUnit]::Pixel
    )
    $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)

    $text = 'OC'
    $measured = $g.MeasureString($text, $font)
    $x = ($Size - $measured.Width) / 2.0
    $y = ($Size - $measured.Height) / 2.0 - ($Size * 0.02)
    $g.DrawString($text, $font, $textBrush, [single]$x, [single]$y)

    # ── Small "flight path" wedge under the text (subtle, bottom-center) ──
    # Acts as a visual hint of "pilot/navigation" without clashing with letters.
    if ($Size -ge 24) {
        $wedgeColor = [System.Drawing.Color]::FromArgb(220, 255, 255, 255)
        $wedgeBrush = New-Object System.Drawing.SolidBrush($wedgeColor)
        $ww = [int]($Size * 0.42)
        $wh = [int]([Math]::Max(2, $Size * 0.045))
        $wx = [int](($Size - $ww) / 2)
        $wy = [int]($Size * 0.80)
        $wedgePath = New-Object System.Drawing.Drawing2D.GraphicsPath
        $radius = [single]($wh / 2.0)
        $wedgePath.AddArc($wx, $wy, $wh, $wh, 90, 180)
        $wedgePath.AddArc($wx + $ww - $wh, $wy, $wh, $wh, 270, 180)
        $wedgePath.CloseFigure()
        $g.FillPath($wedgeBrush, $wedgePath)
    }

    # Save
    $dir = Split-Path -Parent $OutPath
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $g.Dispose()
    $bmp.Dispose()
    Write-Host "  wrote $OutPath  ($Size x $Size)"
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$root      = Split-Path -Parent $scriptDir
$iconsDir  = Join-Path $root 'extension/icons'

Write-Host "Generating OC Pilot icons..."
New-Icon -Size 16  -OutPath (Join-Path $iconsDir 'icon-16.png')
New-Icon -Size 48  -OutPath (Join-Path $iconsDir 'icon-48.png')
New-Icon -Size 128 -OutPath (Join-Path $iconsDir 'icon-128.png')
Write-Host "Done."
