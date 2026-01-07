# ================================
# HDUD — Login Helper (JWT)
# ================================

$API_BASE = "http://127.0.0.1:4000"

$email    = "dba.alexandre.neves@gmail.com"
$password = "SenhaForte#2025"

Write-Host "Realizando login na HDUD API..." -ForegroundColor Cyan

try {
    $login = Invoke-RestMethod -Method Post `
        -Uri "$API_BASE/auth/login" `
        -ContentType "application/json; charset=utf-8" `
        -Body (@{
            email    = $email
            password = $password
        } | ConvertTo-Json -Depth 5)

    $Global:token = $login.access_token

    if (-not $Global:token) {
        throw "Token nao retornado pela API."
    }

    Write-Host "Token obtido com sucesso!" -ForegroundColor Green
    Write-Host ("Token inicio: {0}..." -f $Global:token.Substring(0,20))

} catch {
    Write-Host "Erro ao realizar login:" -ForegroundColor Red
    Write-Host $_
}
