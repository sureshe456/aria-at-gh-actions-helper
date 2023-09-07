nvda-portable\2022.3.0.26722\NVDA.exe --debug-logging
Start-Sleep -Seconds 10
Start-Job -ScriptBlock { & .\start-at-driver.ps1 }
Start-Sleep -Seconds 10
Start-Job -ScriptBlock { chromedriver --port=4444 --log-level=INFO *>&1 >chromedriver.log }
Start-Sleep -Seconds 10
cd aria-at-automation-harness

echo "--at-driver.log"
Get-Content -Path at-driver.log -ErrorAction Continue
echo "--chromedriver.log"
Get-Content -Path chromedriver.log -ErrorAction Continue
echo "--nvda.log???"
Get-Content -Path $env:TEMP\nvda.log -ErrorAction Continue

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

$bmp.Save("D:\a\aria-at-gh-actions-helper\test.png")


node bin/host.js  run-plan --plan-workingdir ../aria-at/build/tests/alert "reference/**,test-01-*-nvda.*" --agent-web-driver-url=http://127.0.0.1:4444 --agent-at-driver-url=ws://127.0.0.1:3031 --reference-hostname=127.0.0.1 --debug --agent-debug | Tee-Object -FilePath ..\harness-run.log
$graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.size)
$bmp.Save("D:\a\aria-at-gh-actions-helper\test2.png")

Start-Process notepad

Start-Sleep -Seconds 10
$graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.size)
$bmp.Save("D:\a\aria-at-gh-actions-helper\test3.png")
$graphics.Dispose()
$bmp.Dispose()

get-process > .\get-process.log
Copy-Item -Path $env:TEMP\nvda.log -Destination D:\a\aria-at-gh-actions-helper\ -ErrorAction Continue

echo "--at-driver.log"
Get-Content -Path at-driver.log -ErrorAction Continue
echo "--chromedriver.log"
Get-Content -Path chromedriver.log -ErrorAction Continue
echo "--nvda.log???"
Get-Content -Path $env:TEMP\nvda.log -ErrorAction Continue
