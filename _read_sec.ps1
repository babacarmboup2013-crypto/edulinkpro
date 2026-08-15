$c = Get-Content 'c:/Users/LENOVO/Desktop/JSX1/EduLink Pro V1.jsx'
$start = [int]$args[0]
$end = [int]$args[1]
$c[($start)..($end)]
