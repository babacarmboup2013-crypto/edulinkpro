param(
  [int]$Start = 1,
  [int]$End = 10
)
$path = 'c:/Users/LENOVO/Desktop/JSX1/EduLink Pro V1.jsx'
$lines = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)
$i = $Start - 1
while ($i -lt $End -and $i -lt $lines.Length -and $i -ge 0) {
  Write-Output ('L' + ($i + 1) + ': ' + $lines[$i])
  $i = $i + 1
}
