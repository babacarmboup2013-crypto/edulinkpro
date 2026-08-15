$path = 'c:/Users/LENOVO/Desktop/JSX1/EduLink Pro V1.jsx'
$lines = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)

# L1198 (index 1197) : restaurer indentation "  useEffect(() => {"
if ($lines[1197] -eq 'useEffect(() => {') {
  $lines[1197] = '  useEffect(() => {'
  [System.IO.File]::WriteAllLines($path, $lines, [System.Text.Encoding]::UTF8)
  Write-Output 'FIXED L1198'
} else {
  Write-Output ('L1198 already correct or unexpected: [' + $lines[1197] + ']')
}

# Verification
$lines2 = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)
Write-Output ('VERIFY L1198: [' + $lines2[1197] + ']')
