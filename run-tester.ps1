
$loglocation = $pwd
Write-Output "Log folder $loglocation"

Expand-Archive -Path nvda-portable\2023.2.0.29051.zip -DestinationPath nvda-portable\

Write-Output "Starting NVDA"
nvda-portable\2023.2.0.29051\NVDA.exe --debug-logging --disable-addons
Start-Sleep -Seconds 10

# Spooky things... If we don't first probe the service like this, the startup of at-driver seems to fail later
try {
  Invoke-WebRequest -UseBasicParsing -Uri http://localhost:8765/info | Tee-Object $loglocation\localhost-test-8765.log
}
catch {
}

Write-Output "Starting at-driver"
$atprocess = Start-Job -Init ([ScriptBlock]::Create("Set-Location '$pwd\nvda-at-automation\Server'")) -ScriptBlock { & .\main.exe 2>&1 >$using:loglocation\at-driver.log }
Start-Sleep -Seconds 10

Write-Output "Starting chromedriver"
$chromeprocess = Start-Job -Init ([ScriptBlock]::Create("Set-Location '$pwd'")) -ScriptBlock { chromedriver --port=4444 --log-level=INFO *>&1 >$using:loglocation\chromedriver.log }
Start-Sleep -Seconds 10

function Trace-Logs {
  Write-Output "At-Driver job process log:"
  Receive-Job $atprocess
  Write-Output "--at-driver.log"
  Get-Content -Path $loglocation\at-driver.log -ErrorAction Continue
  Write-Output "chromedriver job process log:"
  Receive-Job $chromeprocess
  Write-Output "--chromedriver.log"
  Get-Content -Path $loglocation\chromedriver.log -ErrorAction Continue
  Write-Output "--nvda.log???"
  Get-Content -Path $env:TEMP\nvda.log -ErrorAction Continue
}

Trace-Logs

Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$screens = [Windows.Forms.Screen]::AllScreens
$top    = ($screens.Bounds.Top    | Measure-Object -Minimum).Minimum
$left   = ($screens.Bounds.Left   | Measure-Object -Minimum).Minimum
$width  = ($screens.Bounds.Right  | Measure-Object -Maximum).Maximum
$height = ($screens.Bounds.Bottom | Measure-Object -Maximum).Maximum
$bounds   = [Drawing.Rectangle]::FromLTRB($left, $top, $width, $height)
$bmp      = New-Object System.Drawing.Bitmap ([int]$bounds.width), ([int]$bounds.height)
$graphics = [Drawing.Graphics]::FromImage($bmp)

$graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.size)
$bmp.Save("$loglocation\test.png")


Write-Output "Launching automation-harness host"
Set-Location aria-at-automation-harness

node bin/host.js  run-plan --plan-workingdir ../aria-at/build/tests/alert "reference/**,test-01-*-nvda.*" --agent-web-driver-url=http://127.0.0.1:4444 --agent-at-driver-url=ws://127.0.0.1:3031 --reference-hostname=127.0.0.1 --debug --agent-debug | Tee-Object -FilePath $loglocation\harness-run.log

$graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.size)
$bmp.Save("$loglocation\test2.png")


Write-Output "Opening notepad for good luck (and screenshot purposes)"
Start-Process notepad

Start-Sleep -Seconds 10
$graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.size)
$bmp.Save("$loglocation\test3.png")
$graphics.Dispose()
$bmp.Dispose()

Set-Location ..
get-process > .\get-process.log
Copy-Item -Path $env:TEMP\nvda.log -Destination $loglocation -ErrorAction Continue

Trace-Logs
