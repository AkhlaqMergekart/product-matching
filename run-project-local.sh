#!/bin/bash
# Run a project through one destination, in chunks, on a LOCAL macOS machine,
# optionally restricted to a single BRAND.
#
#   ./run-project-local.sh <projectId> <destination> [chunkSize] [brand]
#   ./run-project-local.sh 360 puma 50 Puma
#   ./run-project-local.sh 353 myntra 100
#
# Differences from run-project2.sh (which is the server's copy):
#
#   1. A fourth argument restricts the run to one brand. run-project2.sh pulls
#      EVERY SKU of the project; project 360 holds 1183 Adidas / 825 ASICS /
#      810 Puma / 727 Nike and more, so running it unfiltered against
#      in.puma.com would search Puma's own site for Adidas products.
#   2. Paths and the node version are resolved for this machine rather than
#      hardcoded to the server's ~/product-matching/node/... and v24.19.0.
#
# Everything else - chunking, the per-product JSONL ledger, resume, and the
# stall detector - is deliberately identical, so a run can be moved between
# machines without changing its semantics.
set -u

PROJECT="${1:?usage: run-project-local.sh <projectId> <destination> [chunkSize] [brand]}"
DEST="${2:?usage: run-project-local.sh <projectId> <destination> [chunkSize] [brand]}"
CHUNK="${3:-50}"
BRAND="${4:-}"

APP="$(cd "$(dirname "$0")" && pwd)"
cd "$APP" || exit 1

# Resolve node from nvm without requiring the shell to have sourced it (this
# script is usually launched detached, where the profile has not run).
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
[ -x "$NODE_BIN" ] || { echo "node not found - set NODE_BIN or install nvm"; exit 1; }
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "using node $("$NODE_BIN" -v) at $NODE_BIN"

# The ledger name carries the brand too, so a Puma run and an Adidas run of the
# same project+destination do not resume off each other's progress.
SUFFIX="${PROJECT}_${DEST}"
[ -n "$BRAND" ] && SUFFIX="${SUFFIX}_$(echo "$BRAND" | tr -cd '[:alnum:]')"

LEDGER="progress_${SUFFIX}.jsonl"
touch "$LEDGER"
PROGRESS="/tmp/done_${SUFFIX}.txt"
SKUFILE="/tmp/skus_${SUFFIX}.txt"
PAYLOAD="/tmp/payload_${SUFFIX}.json"

# Per-VARIATION resume, keyed on asin rather than sku.
#
# A project can hold several variation rows under one sku: project 360 keeps
# ONE ROW PER SIZE, and the rows of a product are otherwise identical — same
# sku, same title, same colourway — with the size only in `asin`
# ("10927703-7"). Measured over its 810 Puma rows: 810 distinct asins but only
# 275 distinct skus and 275 distinct titles.
#
# Resuming on sku would therefore mark a whole product done after its first
# size and silently skip the other six. index.js records `asin` on every
# ledger line for exactly this reason; sku is the fallback for rows/projects
# that have no asin.
"$NODE_BIN" -e "
const fs=require('fs');
const done=new Set();
for(const l of fs.readFileSync('$LEDGER','utf8').split('\n')){
  if(!l.trim())continue;
  try{ const j=JSON.parse(l); done.add(String(j.asin||j.sku)); }catch(e){}
}
fs.writeFileSync('$PROGRESS',[...done].map(s=>s+'\n').join(''));
"

# Pull one line PER ROW (not per sku) for the project and brand, as
# "<asin>\t<sku>": every variation row must be processed, so this must not
# collapse rows that share a sku.
BRAND_FILTER=""
[ -n "$BRAND" ] && BRAND_FILTER=", brand: '$BRAND'"
"$NODE_BIN" -e "
const SP=require('./models/scratchProducts.js');
(async()=>{
  const rows=await SP.findAll({where:{projectId:$PROJECT$BRAND_FILTER},attributes:['sku','asin'],raw:true});
  console.log(rows.map(r=>[String(r.asin||r.sku),String(r.sku)].join('\t')).join('\n'));
  process.exit(0);
})();
" 2>/dev/null | grep -v '^\*\*\*' | grep -v '^$' > "$SKUFILE"

TOTAL=$(wc -l < "$SKUFILE" | tr -d ' ')
DISTINCT_SKU=$(cut -f2 "$SKUFILE" | sort -u | wc -l | tr -d ' ')
DONE=$(wc -l < "$PROGRESS" | tr -d ' ')
echo "project $PROJECT${BRAND:+ brand $BRAND} -> $DEST | $TOTAL variation rows ($DISTINCT_SKU distinct sku) | chunk $CHUNK | already done: $DONE"
[ "$TOTAL" -eq 0 ] && { echo "no rows found - aborting"; exit 1; }

# Fail fast if the stack is not up, rather than firing chunks into nothing.
curl -sf -m 10 http://127.0.0.1:8010/test  >/dev/null || { echo "node service not answering on :8010 - start it first"; exit 1; }
curl -s  -m 10 -o /dev/null http://127.0.0.1:8000/ || { echo "pd-match not answering on :8000 - start it first"; exit 1; }

START=$(date +%s)
N=0
BATCH=()
DONEKEYS=()
while IFS=$'\t' read -r KEY SKU; do
  N=$((N+1))
  # Resume on the VARIATION key (asin), so other sizes of the same sku are
  # still run. The payload itself carries skus, because index.js selects by
  # `sku IN (...)` — one sku in the list pulls back ALL of its variation rows,
  # which is what we want: every row must be processed.
  grep -Fxq "$KEY" "$PROGRESS" && continue
  DONEKEYS+=("$KEY")
  # De-duplicate the skus inside the chunk: sending a sku twice would make
  # index.js fetch all of its rows twice over.
  case " ${BATCH[*]-} " in *" $SKU "*) ;; *) BATCH+=("$SKU") ;; esac
  if [ "${#DONEKEYS[@]}" -lt "$CHUNK" ] && [ "$N" -lt "$TOTAL" ]; then continue; fi

  # Build the payload with node so SKUs containing quotes or spaces are safe.
  printf '%s\n' "${BATCH[@]}" | "$NODE_BIN" -e "
const fs=require('fs');
const skus=fs.readFileSync(0,'utf8').split('\n').filter(Boolean);
fs.writeFileSync('$PAYLOAD',JSON.stringify({brand:skus,projectId:$PROJECT,destination:'$DEST'}));
console.error('  chunk of '+skus.length);
"

  curl -s -m 60 -X POST http://127.0.0.1:8010/product-matching \
       -H "Content-Type: application/json" -d @"$PAYLOAD" > /dev/null

  # Wait for THIS chunk before sending the next. Polls the per-destination
  # ledger rather than the shared timing logs: `ls -t logs/...` returns the
  # newest log of ANY destination, which is what made a Myntra run idle 13h on
  # 2026-11-02 waiting on another destination's in-progress log.
  # Wait on the number of VARIATION rows this chunk covers, not the number of
  # skus sent: one sku can expand to several rows, each of which writes its own
  # ledger line.
  TARGET=$(( $(wc -l < "$LEDGER" | tr -d ' ') + ${#DONEKEYS[@]} ))
  STALL=0
  while [ "$(wc -l < "$LEDGER" | tr -d ' ')" -lt "$TARGET" ]; do
    BEFORE=$(wc -l < "$LEDGER" | tr -d ' ')
    sleep 20
    if [ "$(wc -l < "$LEDGER" | tr -d ' ')" -eq "$BEFORE" ]; then
      STALL=$((STALL+1))
      # 30 min with no new product means the chunk died. Move on rather than
      # hang; SKUs missing from the ledger are retried on the next pass.
      if [ $STALL -ge 90 ]; then echo "  WARNING: no progress for 30min, moving on"; break; fi
    else
      STALL=0
    fi
  done

  printf '%s\n' "${DONEKEYS[@]}" >> "$PROGRESS"
  DONE=$(wc -l < "$PROGRESS" | tr -d ' ')
  EL=$(( $(date +%s) - START ))
  RATE=$(( DONE > 0 ? EL / DONE : 0 ))
  LEFT=$(( (TOTAL - DONE) * RATE / 60 ))
  echo "  $DONE/$TOTAL rows | elapsed $((EL/60))m | ~${RATE}s/row | ETA ~${LEFT}m | $(grep -c '"outcome":"matched"' "$LEDGER" 2>/dev/null || echo 0) match(es)"
  BATCH=()
  DONEKEYS=()
done < "$SKUFILE"

echo "FINISHED $DEST in $(( ($(date +%s) - START) / 60 )) minutes"
