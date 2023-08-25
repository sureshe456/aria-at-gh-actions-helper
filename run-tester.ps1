Start-Job -ScriptBlock { at-driver *>&1 >$env:TEMP\at-driver.output }
Start-Sleep -Seconds 10
Start-Job -ScriptBlock { chromedriver --port=4444 --log-level=INFO *>&1 >$env:TEMP\chromedriver.output }
Start-Sleep -Seconds 10
start nvda-portable\2023.1.0.27913\NVDA.exe --install --debug-logging
Start-Sleep -Seconds 10
cd aria-at/build/tests/alert
Start-Sleep -Seconds 10
echo "--at-driver.output"
Get-Content -Path $env:TEMP\at-driver.output -ErrorAction Continue
echo "--chromedriver.output"
Get-Content -Path $env:TEMP\chromedriver.output -ErrorAction Continue
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


node ../../../../automation-harness/bin/host.js run-plan --debug --tests-match 'test-01-trigger-alert*nvda*.json' '**/*.html'

Start-Process notepad

Start-Sleep -Seconds 10
$graphics.CopyFromScreen($bounds.Location, [Drawing.Point]::Empty, $bounds.size)
$bmp.Save("D:\a\aria-at-gh-actions-helper\test2.png")
$graphics.Dispose()
$bmp.Dispose()

get-process

echo "--at-driver.output"
Get-Content -Path $env:TEMP\at-driver.output -ErrorAction Continue
echo "--chromedriver.output"
Get-Content -Path $env:TEMP\chromedriver.output -ErrorAction Continue
echo "--nvda.log???"
Get-Content -Path $env:TEMP\nvda.log -ErrorAction Continue
