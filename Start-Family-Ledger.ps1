[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'
$projectFolder = $PSScriptRoot
$address = '127.0.0.1'
$url = "http://localhost:$Port/"

function Test-LocalPortAvailable {
    param(
        [string]$IPAddress,
        [int]$TcpPort
    )

    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($IPAddress), $TcpPort)
    try {
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        $listener.Stop()
    }
}

try {
    $python = Get-Command py -CommandType Application -ErrorAction SilentlyContinue
    if (-not $python) {
        $python = Get-Command python -CommandType Application -ErrorAction SilentlyContinue
    }
    if (-not $python) {
        throw 'Python was not found. Install Python from python.org, making sure the Python launcher is enabled, then run this launcher again.'
    }
    if (-not (Test-LocalPortAvailable -IPAddress $address -TcpPort $Port)) {
        throw "Port $Port is already in use. Close the other local server, or run Start-Family-Ledger.ps1 -Port 8001 instead."
    }

    Write-Host "Starting Family Ledger from $projectFolder" -ForegroundColor Cyan
    Write-Host "Opening $url" -ForegroundColor Cyan
    Write-Host 'Leave this window open while using Family Ledger. Close it to stop the local server.' -ForegroundColor Yellow

    $server = Start-Process -FilePath $python.Source `
        -ArgumentList @('-m', 'http.server', $Port, '--bind', $address) `
        -WorkingDirectory $projectFolder `
        -NoNewWindow `
        -PassThru

    Start-Sleep -Milliseconds 700
    if ($server.HasExited) {
        throw 'Python started but the local web server stopped immediately. Check that the project folder and Python installation are available.'
    }

    Start-Process $url
    try {
        Wait-Process -Id $server.Id
    } finally {
        if (-not $server.HasExited) {
            Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
        }
    }
} catch {
    Write-Host "Family Ledger could not start: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
