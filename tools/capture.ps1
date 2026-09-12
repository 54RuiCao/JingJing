param(
  [string]$Out = "shot.png",
  [string]$WindowTitle = "aireader",
  [int]$WaitSeconds = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if ($WaitSeconds -gt 0) { Start-Sleep -Seconds $WaitSeconds }

$sig = @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string cls, string name);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
if (-not ("Win32" -as [type])) { Add-Type -TypeDefinition $sig }

$hwnd = [Win32]::FindWindow($null, $WindowTitle)
if ($hwnd -ne [IntPtr]::Zero) {
  [Win32]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
  [Win32]::SetForegroundWindow($hwnd) | Out-Null
  Start-Sleep -Milliseconds 900
  $r = New-Object Win32+RECT
  [Win32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
} else {
  Write-Output "window '$WindowTitle' not found, capturing full screen"
  $b0 = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $r = New-Object Win32+RECT
  $r.Left = $b0.X; $r.Top = $b0.Y; $r.Right = $b0.Right; $r.Bottom = $b0.Bottom
  $w = $b0.Width; $h = $b0.Height
}

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $h)))
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$gfx.Dispose(); $bmp.Dispose()
Write-Output ("saved " + $Out + " " + $w + "x" + $h)
