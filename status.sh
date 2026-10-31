#!/bin/bash
# Status of the project-353 runs.  ./status.sh [projectId]
P="${1:-353}"
cd ~/product-matching/node/product-matching || exit 1
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
TOTAL=2852

echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="

echo "-- scripts --"
pgrep -af "run-project.sh" | grep -v "bash -c" | sed 's/^/  /' || echo "  none running"

echo "-- progress --"
for d in nykaafashion myntra; do
  f="progress_${P}_${d}.jsonl"
  if [ ! -f "$f" ]; then echo "  $d: not started"; continue; fi
  n=$(wc -l < "$f")
  m=$(grep -c '"outcome":"matched"' "$f")
  nm=$(grep -c '"outcome":"no-match"' "$f")
  nc=$(grep -c '"outcome":"no-candidates"' "$f")
  er=$(grep -c '"outcome":"error"' "$f")
  pct=$(awk -v a=$n -v b=$TOTAL 'BEGIN{printf "%.1f", 100*a/b}')
  # rate + ETA from the first and last timestamps in the ledger
  eta=$(node -e "
    const fs=require('fs');
    const L=fs.readFileSync('$f','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    if(L.length<2){console.log('--');process.exit(0)}
    const t0=new Date(L[0].at), t1=new Date(L[L.length-1].at);
    const per=(t1-t0)/1000/(L.length-1);
    const left=($TOTAL-L.length)*per;
    console.log(per.toFixed(1)+'s/product, ETA '+(left/3600).toFixed(1)+'h');
  " 2>/dev/null)
  echo "  $d: $n/$TOTAL ($pct%)  matched=$m no-match=$nm no-candidates=$nc errors=$er  [$eta]"
done

echo "-- active right now --"
A=0
for f in $(ls -t logs/timing_*_${P}_*.log 2>/dev/null | head -6); do
  grep -q "Run ended" "$f" && continue
  age=$(( $(date +%s) - $(stat -c %Y "$f") ))
  [ $age -gt 180 ] && continue
  dest=$(head -1 "$f" | grep -oE "Myntra|Nykaa Fashion")
  echo "  ${dest:-?}: $(tail -1 "$f" | sed 's/^[0-9-]* //' | cut -c1-58) (${age}s ago)"
  A=1
done
[ $A -eq 0 ] && echo "  nothing active"

echo "-- services (dead image service = scores silently 0.00) --"
pm2 list 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g' \
  | grep -E "index|pd-match|image-similarity" \
  | awk -F'│' '{gsub(/ /,"",$3); gsub(/ /,"",$10); gsub(/ /,"",$11); printf "  %-18s %-9s cpu=%s\n", $3, $10, $11}'

echo "-- last 3 matches --"
cat progress_${P}_*.jsonl 2>/dev/null | grep '"outcome":"matched"' | tail -3 \
  | node -e "
    const fs=require('fs');
    const ls=fs.readFileSync(0,'utf8').trim().split('\n').filter(Boolean);
    if(!ls.length){console.log('  none yet');process.exit(0)}
    for(const l of ls){const j=JSON.parse(l);
      console.log('  ['+j.destination+'] '+j.sku+' -> '+(j.matchedTitle||'').slice(0,46)+'  comp '+(j.composite||0).toFixed(3));}
  " 2>/dev/null || echo "  none yet"
