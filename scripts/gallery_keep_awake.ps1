param([int]$WorkerPid)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GalleryPower {
  [DllImport("kernel32.dll")]
  public static extern uint SetThreadExecutionState(uint flags);
}
'@
try {
  [void][GalleryPower]::SetThreadExecutionState([uint32]2147483649)
  while (Get-Process -Id $WorkerPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }
} finally {
  [void][GalleryPower]::SetThreadExecutionState([uint32]2147483648)
}
