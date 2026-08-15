$patterns = @(
  "sb('GET', 'school_data'",
  "sb('POST', 'school_data'",
  "sb('PATCH', 'school_data'",
  "sb('GET', 'schools'",
  "sb('POST', 'schools'",
  "sb('PATCH', 'schools'",
  "sb('DELETE', 'schools'",
  "sb('GET', 'iefs'",
  "sb('POST', 'iefs'",
  "sb('PATCH', 'iefs'",
  "sb('DELETE', 'iefs'",
  "sb('GET', 'admins'",
  "sb('POST', 'admins'",
  "sb('PATCH', 'admins'",
  "sb('DELETE', 'admins'",
  "sb('GET', 'ief_config'",
  "sb('PATCH', 'ief_config'",
  "sb('POST', 'ief_config'",
  "public_schools",
  "get_schools_overview",
  "get_school_data",
  "save_school_data",
  "get_school_personnel",
  "init_school_data",
  "check_school_code",
  "check_ief_code",
  "check_admin_code"
)
$lines = [System.IO.File]::ReadAllLines('c:/Users/LENOVO/Desktop/JSX1/EduLink Pro V1.jsx', [System.Text.Encoding]::UTF8)
foreach ($pat in $patterns) {
  for ($i = 0; $i -lt $lines.Length; $i++) {
    if ($lines[$i].Contains($pat)) {
      Write-Output ('L' + ($i+1) + ' [' + $pat + ']: ' + $lines[$i].Trim())
    }
  }
}
