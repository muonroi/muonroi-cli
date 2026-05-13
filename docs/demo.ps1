$ESC = [char]27
function c($code, $text) { "${ESC}[${code}m${text}${ESC}[0m" }

Clear-Host
Start-Sleep -Milliseconds 300

Write-Host "$(c 36 '>') $(c 97 '/council REST vs gRPC for internal microservices?')"
Start-Sleep -Milliseconds 500

Write-Host ""
Write-Host "$(c '1;38;5;75' 'Council')  $(c 2 '3 models  adversarial debate  convergence detection')"
Start-Sleep -Milliseconds 700

Write-Host ""
Write-Host "$(c 1 'Phase 1  Opening')  $(c 2 'parallel')"
Write-Host "  $(c 33 'o')  $(c 1 'leader   ')  claude-sonnet-4-6   $(c 2 'analyzing...')"
Write-Host "  $(c 33 'o')  $(c 1 'implement')  deepseek-v4-flash   $(c 2 'analyzing...')"
Write-Host "  $(c 33 'o')  $(c 1 'verify   ')  claude-sonnet-4-6   $(c 2 'analyzing...')"
Start-Sleep -Seconds 2

Write-Host "  $(c 32 'v')  $(c 1 'leader   ')  claude-sonnet-4-6   $(c 2 'done (2.1s)')"
Write-Host "  $(c 32 'v')  $(c 1 'implement')  deepseek-v4-flash   $(c 2 'done (1.8s)')"
Write-Host "  $(c 32 'v')  $(c 1 'verify   ')  claude-sonnet-4-6   $(c 2 'done (3.3s)')"
Start-Sleep -Milliseconds 500

Write-Host ""
Write-Host "$(c 1 'Phase 2  Discussion')  $(c 2 'convergence check after each round')"
Write-Host ""
Write-Host "  $(c 2 'Round 1')"
Start-Sleep -Milliseconds 400

Write-Host "  $(c 33 'implement')  gRPC gives type safety and 3-5x throughput."
Write-Host "             REST adds serialization overhead for internal calls."
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "  $(c 35 'verify   ')  Agree on perf. But gRPC adds friction -- proto"
Write-Host "             management, service mesh. Premature optimization?"
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "  $(c 33 'implement')  Fair point. Team size matters. Under 10 engineers,"
Write-Host "             REST pragmatism wins. gRPC at scale."
Start-Sleep -Milliseconds 800

Write-Host ""
Write-Host "  $(c 2 'convergence')  $(c 33 'partial') -- continuing"
Start-Sleep -Milliseconds 500

Write-Host ""
Write-Host "  $(c 2 'Round 2')"
Start-Sleep -Milliseconds 400

Write-Host "  $(c 35 'verify   ')  Updating: hybrid is right. gRPC for hot paths,"
Write-Host "             REST for management/admin APIs."
Start-Sleep -Milliseconds 900

Write-Host ""
Write-Host "  $(c 33 'implement')  Agreed. Established industry pattern."
Start-Sleep -Milliseconds 600

Write-Host ""
Write-Host "  $(c 2 'convergence')  $(c 32 'consensus reached') -- stopping early"
Start-Sleep -Milliseconds 600

Write-Host ""
Write-Host "$(c 1 'Phase 3  Synthesis')"
Start-Sleep -Seconds 1

Write-Host ""
Write-Host "$(c '1;38;5;75' 'Recommendation')"
Write-Host "$(c 2 '--------------------------------------------------------------')"
Write-Host "$(c 1 'Hybrid:') gRPC for hot paths, REST for management plane."
Write-Host ""
Write-Host "  $(c 32 '+')  $(c 1 'gRPC')  auth, data pipelines, event streaming"
Write-Host "  $(c 32 '+')  $(c 1 'REST')  admin endpoints, config, third-party APIs"
Write-Host ""
Write-Host "  Debate surfaced the team-size constraint -- often missed"
Write-Host "  in single-model responses."
Write-Host ""
Write-Host "$(c 2 '  3 models  2 rounds  47s  $0.003')"
Write-Host "$(c 2 '--------------------------------------------------------------')"
Start-Sleep -Seconds 2
