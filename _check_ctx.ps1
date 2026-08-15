$lines = [System.IO.File]::ReadAllLines('c:/Users/LENOVO/Desktop/JSX1/EduLink Pro V1.jsx', [System.Text.Encoding]::UTF8)
for ($i = 1196; $i -lt 1208; $i++) {
  if ($i -lt $lines.Length) { Write-Output ('L' + ($i+1) + ': [' + $lines[$i] + ']') }
}
