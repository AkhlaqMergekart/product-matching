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
# Case-insensitive, substring brand match (the SQL `brand ILIKE '%x%'`), rather
# than an exact equality. The stored spelling is not always what you would type
# — project 360 holds "Technosport" where the destination site writes
# "Techno Sport" — and an exact filter silently returns 0 rows on a near miss,
# which looks identical to "this brand isn't in the project".
BRAND_FILTER=""
[ -n "$BRAND" ] && BRAND_FILTER=", brand: { [require('sequelize').Op.iLike]: '%$BRAND%' }"
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

# How often the ledger is polled, and therefore how often a progress line can
# appear. 5s suits a fast destination (technosport ~1.8s/row); it costs one
# `wc -l` per tick, which is nothing next to a network fetch.
POLL="${POLL:-5}"

# Seconds -> "1h 04m 12s" / "4m 12s" / "12s".
fmt_hms() {
  local s=$1
  if   [ "$s" -ge 3600 ]; then printf '%dh %02dm %02ds' $((s/3600)) $(((s%3600)/60)) $((s%60))
  elif [ "$s" -ge 60 ];   then printf '%dm %02ds' $((s/60)) $((s%60))
  else                          printf '%ds' "$s"
  fi
}

# One progress line: rows done, rate, ETA, and the running outcome split.
#
# The rate is computed in awk, NOT shell arithmetic. `$(( EL / DONE ))` is
# integer division, so a real 1.77s/row truncated to 1 and the ETA came out
# ~40% short — the figure that is supposed to tell you when the run ends was
# the least accurate number on the line.
progress_line() {
  local now_rows=$1 note="${2:-}"
  local done_rows=$(( now_rows - LEDGER_AT_START ))
  [ "$done_rows" -le 0 ] && return 0

  local el=$(( $(date +%s) - START ))
  local left=$(( TOTAL - DONE_AT_START - done_rows ))
  [ "$left" -lt 0 ] && left=0

  # rate (s/row) and remaining seconds, both as floats rounded for display.
  local rate eta_s
  rate=$(awk -v e="$el" -v d="$done_rows" 'BEGIN{printf "%.2f", e/d}')
  eta_s=$(awk -v r="$rate" -v l="$left" 'BEGIN{printf "%d", r*l}')

  # `grep -c` on a FILE prints a trailing newline, and command substitution
  # keeps the count on its own line only if the pattern is absent and the `||`
  # fallback fires — which split one progress line into three. Counted with
  # `grep -o | wc -l` piped from stdin instead, which yields a bare number,
  # and `tr -d` strips wc's leading padding on macOS.
  local n_matched n_nomatch n_err
  n_matched=$(grep -o '"outcome":"matched"' "$LEDGER" 2>/dev/null | wc -l | tr -d ' ')
  n_nomatch=$(grep -o '"outcome":"no-match"' "$LEDGER" 2>/dev/null | wc -l | tr -d ' ')
  n_err=$(grep -o '"outcome":"error"' "$LEDGER" 2>/dev/null | wc -l | tr -d ' ')

  printf '  %d/%d rows (%d%%) | elapsed %s | %ss/row | ETA %s | matched %s / no-match %s / err %s%s\n' \
    "$(( DONE_AT_START + done_rows ))" "$TOTAL" \
    "$(awk -v a="$(( DONE_AT_START + done_rows ))" -v b="$TOTAL" 'BEGIN{printf "%d", a*100/b}')" \
    "$(fmt_hms "$el")" "$rate" "$(fmt_hms "$eta_s")" \
    "$n_matched" "$n_nomatch" "$n_err" \
    "${note:+ | $note}"
}

START=$(date +%s)
# Baselines for the rate maths: rows already in the ledger from a PREVIOUS run
# must not count toward this run's elapsed time, or a resumed run reports an
# absurdly fast rate and an ETA of zero.
LEDGER_AT_START=$(wc -l < "$LEDGER" | tr -d ' ')
DONE_AT_START=$DONE
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
  LAST_PRINT=0
  while :; do
    BEFORE=$(wc -l < "$LEDGER" | tr -d ' ')
    sleep "$POLL"

    NOW_ROWS=$(wc -l < "$LEDGER" | tr -d ' ')

    # Live progress WHILE the chunk runs, not only when it ends. A chunk is 50
    # rows; on a fast destination (technosport ~1.8s/row) that is a single line
    # every 90s, and on a slow one (puma ~16s/row) one every 13 minutes — too
    # coarse to tell a working run from a hung one. Printed on every poll that
    # advanced instead.
    #
    # ETA is computed from the rows finished SO FAR IN THIS RUN
    # (NOW_ROWS - LEDGER_AT_START) against the wall clock, so it reflects the
    # real observed rate including inter-product delay and chunk overhead —
    # not a per-step figure from the timing log.
    if [ "$NOW_ROWS" -ne "$BEFORE" ]; then
      STALL=0
      progress_line "$NOW_ROWS"
      LAST_PRINT=$NOW_ROWS
    else
      STALL=$((STALL+1))
      # 30 min with no new row means the chunk died. Move on rather than hang;
      # rows missing from the ledger are retried on the next pass.
      if [ $(( STALL * POLL )) -ge 1800 ]; then
        echo "  WARNING: no progress for 30min, moving on"
        break
      fi
    fi

    # Exit test AFTER printing, so the line for the rows that completed the
    # chunk is never swallowed.
    #
    # `-ge`, not `-lt` inverted: TARGET is ledger + the number of VARIATION
    # KEYS in this chunk, but index.js selects by `sku IN (...)` and one sku
    # pulls back all of its rows — so the ledger can overshoot TARGET within a
    # single poll. A `-lt` guard then failed on the first evaluation and the
    # loop never ran, which is why a fast chunk printed nothing at all.
    [ "$NOW_ROWS" -ge "$TARGET" ] && break
  done

  printf '%s\n' "${DONEKEYS[@]}" >> "$PROGRESS"
  # Only if the count moved since the last in-loop print, so a chunk that
  # finished between two polls does not repeat an identical line.
  NOW_ROWS=$(wc -l < "$LEDGER" | tr -d ' ')
  [ "$NOW_ROWS" -ne "$LAST_PRINT" ] && progress_line "$NOW_ROWS" "chunk done"
  BATCH=()
  DONEKEYS=()
done < "$SKUFILE"

TOTAL_EL=$(( $(date +%s) - START ))
FINAL_ROWS=$(( $(wc -l < "$LEDGER" | tr -d ' ') - LEDGER_AT_START ))
echo "FINISHED $DEST: $FINAL_ROWS rows in $(fmt_hms "$TOTAL_EL")$(
  [ "$FINAL_ROWS" -gt 0 ] && printf ' (%.2fs/row)' "$(echo "$TOTAL_EL $FINAL_ROWS" | awk '{print $1/$2}')"
)"
echo "  matched: $(grep -o '"outcome":"matched"' "$LEDGER" 2>/dev/null | wc -l | tr -d ' ') | no-match: $(grep -o '"outcome":"no-match"' "$LEDGER" 2>/dev/null | wc -l | tr -d ' ') | no-candidates: $(grep -o '"outcome":"no-candidates"' "$LEDGER" 2>/dev/null | wc -l | tr -d ' ') | errors: $(grep -o '"outcome":"error"' "$LEDGER" 2>/dev/null | wc -l | tr -d ' ')"
