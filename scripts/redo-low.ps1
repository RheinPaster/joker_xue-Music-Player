$env:PYTHONIOENCODING="utf-8"
# 对匹配率偏低/零锚定的歌，用「跳过人声分离」重跑（打样已验证有效）
$names = @(
  "丑八怪","你过得好吗","像风一样","其实","凤毛麟角","初学者","动物世界","小孩",
  "怪咖","慢半拍","木偶人","流星的眼泪","湖泊","火星人来过","爱情宣判","肆无忌惮",
  "被人","解解闷","钗头凤","骆驼","黄色枫叶",
  "刚刚好","在那天回不去的路上","最好","王子归来","租购",
  "我害怕"
)
$ok = 0; $fail = 0
foreach ($n in $names) {
  $mp3 = Join-Path "music" "$n.mp3"
  $lrc = Join-Path "lyrics" "$n.lrc"
  if (-not (Test-Path $mp3) -or -not (Test-Path $lrc)) {
    Write-Output "[跳过] $n —— 缺音频或歌词"
    continue
  }
  $t0 = Get-Date
  python tools/align-lyrics.py --audio $mp3 --lrc $lrc --no-vocals --replace > "_redo_$n.log" 2>&1
  $dt = [int]((Get-Date) - $t0).TotalSeconds
  $rep = "$lrc.aligned.lrc.report.json"
  if ((Test-Path $rep) -and $LASTEXITCODE -eq 0) {
    $r = Get-Content $rep -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-Output ("[完成] {0,-20} 匹配率 {1,-6} 锚定 {2}/{3}  {4}s" -f $n, $r.mean_match_ratio, $r.lines_anchored, $r.lines_total, $dt)
    $ok++
  } else {
    Write-Output ("[失败] {0,-20} {1}s" -f $n, $dt)
    Get-Content "_redo_$n.log" -Encoding UTF8 -Tail 2 | ForEach-Object { "        " + $_ }
    $fail++
  }
}
Write-Output ""
Write-Output "===== 重跑完成：成功 $ok，失败 $fail ====="
