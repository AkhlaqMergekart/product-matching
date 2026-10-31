#!/bin/bash
# Run a whole project through one destination, in chunks.
#
#   ./run-project.sh <projectId> <destination> [chunkSize]
#   ./run-project.sh 353 nykaafashion 100
#
# Why chunks rather than one POST with every SKU: the service processes a
# request as a single sequential loop and writes its output files only as it
# goes. A pm2 restart, an OOM or a crash part-way through a 15-hour request
# loses the lot. In chunks, each completed chunk is already on disk and the
# script can be restarted from the next one.
#
# Chunks run strictly one after another — two concurrent requests would
# compete for the same single-threaded image service and finish no sooner.
set -u

PROJECT="${1:?usage: run-project.sh <projectId> <destination> [chunkSize]}"
DEST="${2:?usage: run-project.sh <projectId> <destination> [chunkSize]}"
CHUNK="${3:-100}"

APP=~/product-matching/node/product-matching
export PATH=$HOME/.nvm/versions/node/v24.19.0/bin:$PATH
cd "$APP" || exit 1

# Per-PRODUCT ledger written by index.js (one JSONL line per SKU the moment
# it finishes). Resume granularity is therefore a single product, not a chunk.
LEDGER="progress_${PROJECT}_${DEST}.jsonl"
touch "$LEDGER"
PROGRESS=/tmp/done_${PROJECT}_${DEST}.txt
node -e "
const fs=require(0?0:'fs');
const done=new Set();
for(const l of fs.readFileSync('$LEDGER','utf8').split('\n')){ if(!l.trim())continue; try{done.add(JSON.parse(l).sku);}catch(e){} }
fs.writeFileSync('$PROGRESS',[...done].map(s=>s+'\n').join(''));
"

# Pull every SKU for the project, one per line.
node -e "
require('./database/config.js');
const SP=require('./models/scratchProducts.js');
(async()=>{
  const rows=await SP.findAll({where:{projectId:$PROJECT},attributes:['sku'],raw:true});
  console.log(rows.map(r=>r.sku).join('\n'));
  process.exit(0);
})();
" 2>/dev/null | grep -v '^\*\*\*' | grep -v '^$' > /tmp/skus_${PROJECT}.txt

TOTAL=$(wc -l < /tmp/skus_${PROJECT}.txt)
DONE=$(wc -l < "$PROGRESS")
echo "project $PROJECT -> $DEST | $TOTAL SKUs | chunk $CHUNK | already done: $DONE"
[ "$TOTAL" -eq 0 ] && { echo "no SKUs found - aborting"; exit 1; }

START=$(date +%s)
N=0
while read -r SKU; do
  N=$((N+1))
  grep -Fxq "$SKU" "$PROGRESS" && continue          # skip SKUs already processed
  BATCH+=("$SKU")
  if [ "${#BATCH[@]}" -lt "$CHUNK" ] && [ "$N" -lt "$TOTAL" ]; then continue; fi

  # Build the JSON payload with node so SKUs containing quotes/spaces are safe.
  printf '%s\n' "${BATCH[@]}" | node -e "
const fs=require('fs');
const skus=fs.readFileSync(0,'utf8').split('\n').filter(Boolean);
fs.writeFileSync('/tmp/payload.json',JSON.stringify({brand:skus,projectId:$PROJECT,destination:'$DEST'}));
console.error('  chunk of '+skus.length);
"

  PREV=$(ls -t logs/timing_*_${PROJECT}_*.log 2>/dev/null | head -1)
  curl -s -m 60 -X POST http://127.0.0.1:8010/product-matching \
       -H "Content-Type: application/json" -d @/tmp/payload.json > /dev/null

  # Wait for THIS chunk to finish before sending the next one.
  while true; do
    sleep 20
    CUR=$(ls -t logs/timing_*_${PROJECT}_*.log 2>/dev/null | head -1)
    [ "$CUR" != "$PREV" ] && grep -q "Run ended" "$CUR" 2>/dev/null && break
  done

  printf '%s\n' "${BATCH[@]}" >> "$PROGRESS"
  DONE=$(wc -l < "$PROGRESS")
  EL=$(( $(date +%s) - START ))
  echo "  $DONE/$TOTAL done | elapsed $((EL/60))m | $(grep -c 'Result: match found' "$CUR" 2>/dev/null) match(es) this chunk"
  BATCH=()
done < /tmp/skus_${PROJECT}.txt

echo "FINISHED $DEST in $(( ($(date +%s) - START) / 60 )) minutes"
