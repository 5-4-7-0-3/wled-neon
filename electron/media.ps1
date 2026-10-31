# Prints one JSON line per second with the media sessions Windows knows about
# (browsers, Spotify, players), so the app can react to what is playing.
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
# Windows PowerShell has no await for WinRT async calls; go through AsTask
$asTask = [WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, $type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
$ns = 'Windows.Media.Control.GlobalSystemMediaTransportControlsSession'
$mgrType = [Type]"$($ns)Manager, Windows.Media.Control, ContentType=WindowsRuntime"
$propsType = [Type]"$($ns)MediaProperties, Windows.Media.Control, ContentType=WindowsRuntime"
$mgr = Await ($mgrType::RequestAsync()) $mgrType
while ($true) {
  $list = @(foreach ($s in $mgr.GetSessions()) {
    try {
      $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType
      @{ playing = "$($s.GetPlaybackInfo().PlaybackStatus)" -eq 'Playing'; title = $p.Title; artist = $p.Artist }
    } catch {}
  })
  ConvertTo-Json -Compress -InputObject $list
  Start-Sleep -Seconds 1
}
