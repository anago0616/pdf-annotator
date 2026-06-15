# PDFノートをサーバー起動し、スマホからアクセスできる公開URLを発行するスクリプト
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$cloudflared = Join-Path (Split-Path -Parent $root) "tools\cloudflared.exe"

Write-Host ""
Write-Host "=== PDFノート スマホ公開モード ===" -ForegroundColor Cyan
Write-Host ""

# サーバー起動(8741が未使用なら)
$listening = Get-NetTCPConnection -LocalPort 8741 -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    Write-Host "サーバーを起動しています..." -ForegroundColor Yellow
    Start-Process node -ArgumentList "`"$root\server.js`"" -WindowStyle Minimized
    Start-Sleep 2
} else {
    Write-Host "サーバーは起動済みです (ポート8741)" -ForegroundColor Green
}

if (-not (Test-Path $cloudflared)) {
    Write-Host "cloudflared.exe が見つかりません: $cloudflared" -ForegroundColor Red
    Write-Host "https://github.com/cloudflare/cloudflared/releases から cloudflared-windows-amd64.exe を上記パスに保存してください"
    pause
    exit 1
}

Write-Host ""
Write-Host "公開URLを発行しています... 下に表示される https://～.trycloudflare.com をスマホで開いてください" -ForegroundColor Yellow
Write-Host "(このウィンドウを閉じると公開は終了します)" -ForegroundColor DarkGray
Write-Host ""

& $cloudflared tunnel --protocol http2 --url http://localhost:8741
