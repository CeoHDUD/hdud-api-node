Remove-Module Pester -ErrorAction SilentlyContinue
Get-Module Pester | Remove-Module -Force -ErrorAction SilentlyContinue
Set-StrictMode -Off


# ==========================================
# HDUD — Test Flow End-to-End (JWT + Memory)
# ==========================================

$API_BASE = "http://127.0.0.1:4000"

$email    = "dba.alexandre.neves@gmail.com"
$password = "SenhaForte#2025"
$authorId = 1

Write-Host "Iniciando fluxo HDUD API..." -ForegroundColor Cyan

# -----------------------
# 1) LOGIN
# -----------------------
Write-Host "1) Login..."

$login = Invoke-RestMethod -Method Post `
    -Uri "$API_BASE/auth/login" `
    -ContentType "application/json; charset=utf-8" `
    -Body (@{
        email    = $email
        password = $password
    } | ConvertTo-Json -Depth 5)

$Global:token = $login.access_token

if (-not $token) {
    throw "Token nao obtido no login."
}

Write-Host "Token OK" -ForegroundColor Green

$headers = @{
    Authorization = "Bearer $token"
}

# -----------------------
# 2) CREATE MEMORY
# -----------------------
Write-Host "2) Criando memoria..."

$createBody = @{
    title   = "Memoria criada via test-flow"
    content = "Conteudo inicial da memoria"
} | ConvertTo-Json -Depth 5

$created = Invoke-RestMethod -Method Post `
    -Uri "$API_BASE/authors/$authorId/memories" `
    -Headers $headers `
    -ContentType "application/json; charset=utf-8" `
    -Body $createBody

$memoryId = $created.memory_id

Write-Host ("Memoria criada com ID {0}" -f $memoryId) -ForegroundColor Green

# -----------------------
# 3) UPDATE MEMORY
# -----------------------
Write-Host "3) Atualizando memoria..."

$updateBody = @{
    title   = "Memoria atualizada v2"
    content = "Conteudo atualizado com acentuacao correta"
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Put `
    -Uri "$API_BASE/memories/$memoryId" `
    -Headers $headers `
    -ContentType "application/json; charset=utf-8" `
    -Body $updateBody | Out-Null

Write-Host "Atualizacao OK" -ForegroundColor Green

# -----------------------
# 4) GET MEMORY
# -----------------------
Write-Host "4) Buscando memoria atual..."

$current = Invoke-RestMethod -Method Get `
    -Uri "$API_BASE/memories/$memoryId" `
    -Headers $headers

Write-Host ("Versao atual: {0}" -f $current.version_number)

# -----------------------
# 5) TIMELINE
# -----------------------
Write-Host "5) Timeline..."

$timeline = Invoke-RestMethod -Method Get `
    -Uri "$API_BASE/memories/$memoryId/timeline" `
    -Headers $headers

Write-Host ("Total de eventos: {0}" -f $timeline.total_versions)

# -----------------------
# 6) ROLLBACK
# -----------------------
Write-Host "6) Rollback para versao 1..."

Invoke-RestMethod -Method Post `
    -Uri "$API_BASE/memories/$memoryId/rollback/1" `
    -Headers $headers | Out-Null

Write-Host "Rollback OK" -ForegroundColor Green

# -----------------------
# 7) TIMELINE FINAL
# -----------------------
Write-Host "7) Timeline final..."

$timelineFinal = In
