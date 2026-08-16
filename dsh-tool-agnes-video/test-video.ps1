# Agnes AI 视频生成测试
param([string]$Prompt = "A cute cat napping in the sun")

$ApiBaseUrl = "https://apihub.agnes-ai.com/v1"
$ApiKey = $env:AGNES_API_KEY

Write-Host "=== Agnes AI Video Generation Test (using /v1/videos endpoint) ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Prompt: $Prompt" -ForegroundColor Yellow

# Step 1: Create task using /v1/videos
Write-Host "`n[1/3] Creating video generation task..." -ForegroundColor Cyan
$body = @{
    model = "agnes-video-v2.0"
    prompt = $Prompt
    duration = 4
    width = 720
    height = 1280
    fps = 8
} | ConvertTo-Json -Depth 3

$headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $ApiKey"
}

try {
    $response = Invoke-RestMethod -Uri "$ApiBaseUrl/videos" -Method POST -Headers $headers -Body $body -TimeoutSec 30
    Write-Host "Task created: $($response.id)" -ForegroundColor Green
    $taskId = $response.id
    Write-Host "Initial status: $($response.status)" -ForegroundColor Green
} catch {
    Write-Host "Error creating task: $_" -ForegroundColor Red
    exit 1
}

# Step 2: Poll for completion
Write-Host "`n[2/3] Polling for completion (timeout: 5 min)..." -ForegroundColor Cyan
$maxPolls = 60
$startTime = Get-Date

for ($i = 0; $i -lt $maxPolls; $i++) {
    Start-Sleep -Seconds 5
    
    try {
        $statusResponse = Invoke-RestMethod -Uri "$ApiBaseUrl/videos/$taskId" -Method GET -Headers $headers -TimeoutSec 30
        Write-Host "  Status: $($statusResponse.status) ($($i + 1)/$maxPolls)" -NoNewline
        
        if ($statusResponse.status -eq "completed") {
            Write-Host " - DONE!" -ForegroundColor Green
            break
        } elseif ($statusResponse.status -eq "failed") {
            Write-Host " - FAILED: $($statusResponse.error)" -ForegroundColor Red
            exit 1
        } else {
            Write-Host ""
        }
    } catch {
        Write-Host "  Poll error: $($_.Exception.Message)" -ForegroundColor Red
        exit 1
    }
}

# Step 3: Output result
Write-Host "`n[3/3] Result" -ForegroundColor Cyan
if ($statusResponse.status -eq "completed") {
    Write-Host "Video URL: $($statusResponse.video_url)" -ForegroundColor Green
    Write-Host "`nSuccess! Video generated in $((Get-Date).Subtract($startTime).TotalSeconds.ToString('0')) seconds" -ForegroundColor Green
} else {
    Write-Host "Timeout or failure" -ForegroundColor Red
}
