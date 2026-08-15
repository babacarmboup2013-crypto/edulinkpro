$lines = [System.IO.File]::ReadAllLines('c:/Users/LENOVO/Desktop/JSX1/EduLink Pro V1.jsx', [System.Text.Encoding]::UTF8)
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match 'MAX_STUDENTS_PRIVATE|Limite atteinte : une classe privée|Limite privée') {
    Write-Output ('L' + ($i+1) + ': ' + $lines[$i].Trim())
  }
}
