# smoke_test_hdud_core.ps1 — HDUD Core Smoke Test (UTF-8 safe)
# Run: powershell -ExecutionPolicy Bypass -File .\scripts\smoke_test_hdud_core.ps1

$ErrorActionPreference = "Stop"

# =========================
# CONFIG
# =========================
$BaseUrl  = "http://127.0.0.1:4000"
$Email    = "dba.alexandre.neves@gmail.com"
$Password = "SenhaForte#2025"
$AuthorId = 1

function Write-Ok   { param([string]$msg) Write-Host "✅ $msg" -ForegroundColor Green }
function Write-Info { param([string]$msg) Write-Host "ℹ️  $msg" -ForegroundColor Cyan }
function Write-Fail { param([string]$msg) Write-Host "❌ $msg" -ForegroundColor Red }

function Invoke-JsonUtf8 {
  param(
    [Parameter(Mandatory=$true)][string]$Method,
    [Parameter(Mandatory=$true)][string]$Url,
    [Hashtable]$Headers = $null,
    [object]$BodyObject = $null
  )

  $contentType = "application/json; charset=utf-8"
  if ($null -eq $Headers) { $Headers = @{} }

  if ($null -eq $BodyObject) {
    return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers
  }

  $json  = $BodyObject | ConvertTo-Json -Depth 20
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)

  return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers -ContentType $contentType -Body $bytes
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

try {
  Write-Info "HDUD Core Smoke Test iniciando..."
  Write-Info "BaseUrl: $BaseUrl"

  # =========================
  # 1) HEALTH
  # =========================
  $health1 = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
  Assert-True ($health1.status -eq "ok") "Health check falhou (status != ok)."
  Write-Ok ("Health OK ({0})" -f $health1.version)

  # =========================
  # 2) LOGIN (UTF-8 safe)
  # =========================
  $loginBody = @{
    email    = $Email
    password = $Password
  }

  $login = Invoke-JsonUtf8 -Method Post -Url "$BaseUrl/auth/login" -BodyObject $loginBody
  Assert-True ($null -ne $login.access_token -and $login.access_token.Length -gt 20) "Login falhou: access_token ausente."

  $token   = $login.access_token
  $headers = @{ Authorization = "Bearer $token" }

  $userId = $login.user.user_id
  $roles  = @()
  if ($null -ne $login.user.roles) { $roles = $login.user.roles }
  $rolesText = ($roles -join ",")

  Write-Ok ("Login OK (user_id={0} roles={1})" -f $userId, $rolesText)

  # =========================
  # 3) CREATE MEMORY (UTF-8 safe)
  # =========================
  $title1   = "SMOKE — Memória com acentuação correta — versão 1"
  $content1 = "ÁÉÍÓÚ — memória máquina coração funcionando corretamente."

  $createBody = @{
    title   = $title1
    content = $content1
  }

  $created = Invoke-JsonUtf8 -Method Post -Url "$BaseUrl/authors/$AuthorId/memories" -Headers $headers -BodyObject $createBody
  Assert-True ($null -ne $created.memory_id) "Create memory falhou: memory_id ausente."

  $memoryId = [int]$created.memory_id
  $ver1 = $created.version_number

  Write-Ok ("Create memory OK (memory_id={0} version={1})" -f $memoryId, $ver1)

  # =========================
  # 4) GET MEMORY
  # =========================
  $fetched = Invoke-RestMethod -Method Get -Uri "$BaseUrl/memories/$memoryId" -Headers $headers
  Assert-True ($fetched.memory_id -eq $memoryId) "GET falhou: memory_id não confere."
  Assert-True ($fetched.title -eq $title1) "GET falhou: title diferente (possível encoding)."
  Assert-True ($fetched.content -eq $content1) "GET falhou: content diferente (possível encoding)."
  Write-Ok "GET OK (Unicode OK)"

  # =========================
  # 5) UPDATE MEMORY (UTF-8 safe)
  # =========================
  $title2   = "SMOKE — Memória com acentuação correta — versão 2"
  $content2 = "Atualizada — HDUD está operando com versionamento. Coração, máquina, memória."

  $updateBody = @{
    title   = $title2
    content = $content2
  }

  $updated = Invoke-JsonUtf8 -Method Put -Url "$BaseUrl/memories/$memoryId" -Headers $headers -BodyObject $updateBody
  Assert-True ($updated.version_number -ge 2) "UPDATE falhou: version_number não incrementou."
  Write-Ok ("UPDATE OK (version={0})" -f $updated.version_number)

  # =========================
  # 6) VERSIONS
  # =========================
  $versions = Invoke-RestMethod -Method Get -Uri "$BaseUrl/memories/$memoryId/versions" -Headers $headers

  # seu endpoint pode devolver { value: [...], Count: N } (como você mostrou antes)
  $events = $null
  if ($versions.PSObject.Properties.Name -contains "value") {
    $events = $versions.value
    $count  = $versions.Count
  } else {
    $events = $versions
    $count  = $versions.Count
  }

  Assert-True ($count -ge 2) "VERSIONS falhou: esperado >=2 eventos."
  Write-Ok ("VERSIONS OK (count={0})" -f $count)

  # =========================
  # 7) ROLLBACK para versão 1
  # =========================
  $rollback = Invoke-RestMethod -Method Post -Uri "$BaseUrl/memories/$memoryId/rollback/1" -Headers $headers
  Assert-True ($rollback.message -match "Rollback realizado com sucesso") "ROLLBACK falhou: mensagem inesperada."
  Assert-True ($rollback.updated.version_number -ge 3) "ROLLBACK falhou: version_number não criou nova versão."
  Write-Ok ("ROLLBACK OK (new_version={0})" -f $rollback.updated.version_number)

  # =========================
  # 8) TIMELINE
  # =========================
  $timeline = Invoke-RestMethod -Method Get -Uri "$BaseUrl/memories/$memoryId/timeline" -Headers $headers
  Assert-True ($timeline.memory_id -eq $memoryId) "TIMELINE falhou: memory_id não confere."
  Assert-True ($timeline.total_versions -ge 3) "TIMELINE falhou: total_versions esperado >=3."
  Write-Ok ("TIMELINE OK (total_versions={0})" -f $timeline.total_versions)

  # =========================
  # 9) HEALTH FINAL
  # =========================
  $health2 = Invoke-RestMethod -Method Get -Uri "$BaseUrl/health"
  Assert-True ($health2.status -eq "ok") "Health final falhou."
  Write-Ok "Health final OK"

  Write-Host ""
  Write-Ok "SMOKE TEST FINALIZADO COM SUCESSO ✅"
  Write-Info ("memory_id testado: {0}" -f $memoryId)
  exit 0
}
catch {
  Write-Host ""
  Write-Fail "SMOKE TEST FALHOU ❌"
  Write-Fail $_.Exception.Message
  exit 1
}
