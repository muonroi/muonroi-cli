$ESC   = [char]27
$PIPE  = [char]0x2503   # ┃
$ARROW = ">"
$DOT   = [char]0x00B7   # middle dot - use ASCII fallback if issues

function rgb($r, $g, $b, $text) { "${ESC}[38;2;${r};${g};${b}m${text}${ESC}[0m" }
function bg($r, $g, $b, $text)  { "${ESC}[48;2;${r};${g};${b}m${text}${ESC}[0m" }
function bold($text)  { "${ESC}[1m${text}${ESC}[0m" }
function dim2($text)  { "${ESC}[2m${text}${ESC}[0m" }
function ul($text)    { "${ESC}[4m${text}${ESC}[0m" }

# Color palette from real TUI
function accent($t)  { rgb 92 156 245 $t }   # #5c9cf5 blue
function white($t)   { rgb 224 224 224 $t }  # #e0e0e0
function muted($t)   { rgb 102 102 102 $t }  # #666666
function dimgray($t) { rgb 68  68  68  $t }  # #444444
function green2($t)  { rgb 138 223 138 $t }  # #8adf8a diff add
function red2($t)    { rgb 223 138 138 $t }  # #df8a8a diff remove
function amber($t)   { rgb 229 192 123 $t }  # #e5c07b
function teal($t)    { rgb 102 217 194 $t }  # #66d9c2

function userBorder { "${ESC}[38;2;92;156;245m${PIPE}${ESC}[0m" }

function separator {
    Write-Host (muted "  $(('-' * 65))")
}

Clear-Host
Start-Sleep -Milliseconds 200

# ── Header ──────────────────────────────────────────────────────────
$hdrLeft  = "  $(accent (bold 'Agent'))  $(dimgray 'session: a3f9c2')"
$hdrRight = "$(dimgray '~/projects/api')  "
Write-Host "${hdrLeft}$(dimgray '                                              ')${hdrRight}"
Write-Host ""

# ── Turn 2: previous (already done) ─────────────────────────────────
Write-Host "  $(userBorder) $(muted 'You')"
Write-Host "  $(userBorder) $(white 'add unit tests for the auth module')"
Write-Host ""

Write-Host "   $(accent 'Agent')"
Write-Host "   $(white 'Created') $(rgb 138 223 138 'src/auth/__tests__/auth.test.ts') $(white 'with 8 test cases.')"
Write-Host "   $(white 'All passing.')  $(muted '(deepseek-v4-flash | $0.0008 | 0.9s)')"
Write-Host ""
separator
Write-Host ""
Start-Sleep -Milliseconds 600

# ── Turn 3: new user message typing ─────────────────────────────────
Write-Host "  $(userBorder) $(muted 'You')"
Write-Host -NoNewline "  $(userBorder) "
$prompt = "refactor UserService to remove the singleton pattern"
foreach ($ch in $prompt.ToCharArray()) {
    Write-Host -NoNewline (white $ch)
    Start-Sleep -Milliseconds 28
}
Write-Host ""
Write-Host ""
Start-Sleep -Milliseconds 400

# PIL routing line
Write-Host "   $(muted 'PIL') $(dimgray 'intent=')$(amber 'refactor') $(dimgray 'conf=')$(rgb 34 197 94 '0.94') $(dimgray 'role=')$(accent 'implement') $(dimgray 'model=')$(accent 'deepseek-v4-flash')"
Write-Host ""
Start-Sleep -Milliseconds 600

# ── Agent response ───────────────────────────────────────────────────
Write-Host "   $(accent 'Agent')"
Start-Sleep -Milliseconds 350

Write-Host -NoNewline "   "
foreach ($ch in "Refactoring ".ToCharArray()) {
    Write-Host -NoNewline (white $ch); Start-Sleep -Milliseconds 16
}
foreach ($ch in "UserService".ToCharArray()) {
    Write-Host -NoNewline (amber $ch); Start-Sleep -Milliseconds 16
}
foreach ($ch in " -- removing singleton,".ToCharArray()) {
    Write-Host -NoNewline (white $ch); Start-Sleep -Milliseconds 16
}
Write-Host ""

Write-Host -NoNewline "   "
foreach ($ch in "converting to dependency-injected instance.".ToCharArray()) {
    Write-Host -NoNewline (white $ch); Start-Sleep -Milliseconds 14
}
Write-Host ""
Write-Host ""
Start-Sleep -Milliseconds 250

# Tool indicator
Write-Host "   $(muted "$ARROW  Writing src/services/user-service.ts")"
Start-Sleep -Milliseconds 400

# Diff block
Write-Host ""
Write-Host "   ${ESC}[48;2;58;30;30m$(red2 '- ')$(rgb 223 138 138 "  export const userService = new UserService()")${ESC}[0m"
Start-Sleep -Milliseconds 110
Write-Host "   ${ESC}[48;2;30;58;30m$(green2 '+ ')$(rgb 138 223 138 '  export class UserService {')${ESC}[0m"
Start-Sleep -Milliseconds 110
Write-Host "   ${ESC}[48;2;30;58;30m$(green2 '+ ')$(rgb 138 223 138 '    constructor(private readonly db: Database) {}')${ESC}[0m"
Start-Sleep -Milliseconds 110
Write-Host "   ${ESC}[48;2;30;58;30m$(green2 '+ ')$(rgb 138 223 138 '  }')${ESC}[0m"
Start-Sleep -Milliseconds 300

Write-Host ""
Write-Host -NoNewline "   "
foreach ($ch in "Updated ".ToCharArray()) {
    Write-Host -NoNewline (white $ch); Start-Sleep -Milliseconds 14
}
Write-Host -NoNewline (amber "4")
foreach ($ch in " call sites. No breaking changes.".ToCharArray()) {
    Write-Host -NoNewline (white $ch); Start-Sleep -Milliseconds 14
}
Write-Host ""
Write-Host "   $(muted '(deepseek-v4-flash | $0.0011 | 1.2s)')"
Start-Sleep -Milliseconds 500

Write-Host ""
separator
Write-Host ""

# ── Input area ───────────────────────────────────────────────────────
Write-Host "  $(accent (bold 'Agent'))  $(dimgray '|')"
Start-Sleep -Milliseconds 600

# Key hints
Write-Host "  $(dimgray 'deepseek-v4-flash  14%')$(dimgray '                          ')$(muted '@ files')$(dimgray '  ')$(muted 'shift+enter')$(dimgray '  ')$(muted 'tab modes')"
Write-Host ""

# ── Status bar ───────────────────────────────────────────────────────
$sLeft  = " $(bold (accent 'anthropic/deepseek-v4-flash'))  $(dimgray '|')  $(muted 'implement')  $(dimgray '|')  $(muted 'u:0.8K d:1.2K')  $(dimgray '|')"
$sRight = "  $(rgb 34 197 94 '$0.001')  $(dimgray '|')  $(muted '1.2k tok')  $(dimgray '|')  $(muted 'turn 3')  $(rgb 34 197 94 (bold 'o'))"
$barContent = "${ESC}[48;2;20;20;20m${sLeft}$(muted '                          ')${sRight} ${ESC}[0m"
Write-Host $barContent

Start-Sleep -Seconds 2
