
$nvdaVersion = "2023.2.0.20951"
$loglocation = $pwd

Write-Output "Log folder $loglocation"

# The zip file contains the folder 2023.2.0.29051 - unzip it in the "parent directory"
Expand-Archive -Path nvda-portable\$nvdaVersion.zip -DestinationPath nvda-portable\

$nvdaParams = ""
if ($env:RUNNER_DEBUG)
{
  $nvdaParams = "--debug-logging"
}
Write-Output "Starting NVDA"
nvda-portable\$nvdaVersion\NVDA.exe $nvdaParams

# Retries to connect to an http url, allowing for any valid "response" (4xx,5xx,etc also valid)
function Wait-For-HTTP-Response {
  param (
    $RequestURL
  )

  $status = "Failed"
  for (($sleeps=1); $sleeps -le 30; $sleeps++)
  {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $RequestURL >> $loglocation\http-testing.log
      $status = "Success"
      break
    }
    catch {
      $code = $_.Exception.Response.StatusCode.Value__
      if ( $code -gt 99)
      {
        $status = "Success ($code)"
        break
      }
    }
    Start-Sleep -Seconds 1
  }
  Write-Output "$status after $sleeps tries"
}

# Spooky things... If we don't first probe the service like this, the startup of at-driver seems to fail later
Write-Output "Waiting for localhost:8765 to start from NVDA"
Wait-For-HTTP-Response -RequestURL http://localhost:8765/info

Write-Output "Starting at-driver"
$atprocess = Start-Job -Init ([ScriptBlock]::Create("Set-Location '$pwd\nvda-at-automation\Server'")) -ScriptBlock { & .\main.exe 2>&1 >$using:loglocation\at-driver.log }
Write-Output "Waiting for localhost:3031 to start from at-driver"
Wait-For-HTTP-Response -RequestURL http://localhost:3031

Write-Output "Starting chromedriver"
$chromeprocess = Start-Job -Init ([ScriptBlock]::Create("Set-Location '$pwd'")) -ScriptBlock { chromedriver --port=4444 --log-level=INFO *>&1 >$using:loglocation\chromedriver.log }
Write-Output "Waiting for localhost:4444 to start from chromedriver"
Wait-For-HTTP-Response -RequestURL http://localhost:4444/

function Trace-Logs {
  if ($env:RUNNER_DEBUG)
  {
    Write-Output "At-Driver job process log:"
    Receive-Job $atprocess
    Write-Output "--at-driver.log"
    Get-Content -Path $loglocation\at-driver.log -ErrorAction Continue
    Write-Output "chromedriver job process log:"
    Receive-Job $chromeprocess
    Write-Output "--chromedriver.log"
    Get-Content -Path $loglocation\chromedriver.log -ErrorAction Continue
    Write-Output "--nvda.log"
    Get-Content -Path $env:TEMP\nvda.log -ErrorAction Continue
  }
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

$hostParams = ""
if ($env:RUNNER_DEBUG)
{
  $hostParams = "--debug"
}
node bin/host.js  run-plan --plan-workingdir ../aria-at/build "**/reference/**,tests/alert/test-*-nvda.*" $hostParams --agent-web-driver-url=http://127.0.0.1:4444 --agent-at-driver-url=ws://127.0.0.1:3031/command --reference-hostname=127.0.0.1 --agent-web-driver-browser=chrome | Tee-Object -FilePath $loglocation\harness-run.log

$result = Get-Content -Path ./harness-run.log | ./jq-win64.exe '{ atVersion: "nvda '$nvdaVersion'", browserVersion: "'$env:BROWSER_VERSION'" } + walk(if type == "object" then del(.log) else . end)'

Write-Output "Final Result: $result"

Invoke-WebRequest -Uri $env:RESULT_POST_URL -Method Post -ContentType "application/json" -Body $result


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
