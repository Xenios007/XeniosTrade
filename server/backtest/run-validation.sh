#!/usr/bin/env bash
# Detached orchestrator for validation RUNS 2-7. Waits for RUN 1
# (primary-8bot-5yr: replay + primary training + report) to finish cleanly, then
# executes the six validation runs sequentially at stride 1, none of them feeding
# the primary training set. Finishes with a combined cross-run report.
#
#   nohup bash server/backtest/run-validation.sh > launcher-logs/validation.log 2>&1 &
#
# Safe to re-run: each replay uses --resume, and a run whose registry status is
# already "complete" is skipped.
set -u
cd "$(dirname "$0")/../.."
# feature-rich runs (RUN 7) + combined report hold ~1-2 GB of rows in memory
export NODE_OPTIONS=--max-old-space-size=8192

BOTS=model-1,model-2,model-3,model-4,model-5,model-6,model-7,model-8
CORE12=BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,LINKUSDT,LTCUSDT,TRXUSDT,DOTUSDT,AVAXUSDT
EXT8=NEARUSDT,APTUSDT,ARBUSDT,INJUSDT,SUIUSDT,FETUSDT,HBARUSDT,1000PEPEUSDT
CONC=4
CAP=800
NONE_ARTIFACT=server/data/ai-training/none.json
PRIMARY_REPORT=server/backtest/reports/primary-8bot-5yr.md
REG=server/data/backtest-runs.json

log(){ echo "$(date '+%F %T')  $*"; }
run_status(){ node -e "try{const e=require('./$REG').find(x=>x.id==='$1');process.stdout.write(e?e.status:'none')}catch(e){process.stdout.write('none')}"; }

# replay one validation run (resumable); $1=run-id  $2=symbols  $3=feeBps  $4=slipBps  $5=extra-flags
do_replay(){
  local id="$1" syms="$2" fee="$3" slip="$4" extra="$5"
  local st; st=$(run_status "$id")
  if [ "$st" = "complete" ]; then log "  $id already complete — skip"; return 0; fi
  log "  replay $id  symbols=$syms  fee=$fee slip=$slip  extra='$extra'"
  node server/backtest/replay-dataset.js --months 60 --stride 1 --concurrency $CONC \
    --bots "$BOTS" --symbols "$syms" --run-id "$id" --cap-per-symbol-bot $CAP \
    --fee-bps "$fee" --slippage-bps "$slip" --max-hold-hours 48 --no-train --resume $extra
  local rc=$?
  log "  replay $id exit $rc (status $(run_status "$id"))"
  return $rc
}

# per-run replay-only report (no AI artifact)
do_report(){
  local id="$1"
  mkdir -p server/data/ai-training
  node server/backtest/report.js --run-id "$id" --artifact "$NONE_ARTIFACT" \
    --out "server/backtest/reports/$id.md"
  log "  report $id exit $? -> server/backtest/reports/$id.md"
}

log "=== validation orchestrator start — waiting for RUN 1 to finish ==="
while [ ! -f "$PRIMARY_REPORT" ]; do
  log "waiting: primary status=$(run_status primary-8bot-5yr), report not present yet"
  sleep 120
done
log "RUN 1 report present — starting validation runs"

# RUN 2 — moderate execution stress
do_replay validation-stress-5y-20symbols-8bots-5fee-5slip universe 5 5 "--no-features" && \
  do_report validation-stress-5y-20symbols-8bots-5fee-5slip

# RUN 3 — high execution stress
do_replay validation-high-stress-5y-20symbols-8bots-7fee-10slip universe 7 10 "--no-features" && \
  do_report validation-high-stress-5y-20symbols-8bots-7fee-10slip

# RUN 4 — strict historical context (no fabricated order-book / funding proxy)
do_replay validation-strict-context-5y-20symbols-8bots universe 5 3 "--no-features --strict-context" && \
  do_report validation-strict-context-5y-20symbols-8bots

# RUN 5 — core market validation (12 symbols)
do_replay validation-core-12symbols-5y-8bots "$CORE12" 5 3 "--no-features" && \
  do_report validation-core-12symbols-5y-8bots

# RUN 6 — extended / high-beta validation (8 symbols)
do_replay validation-extended-8symbols-8bots "$EXT8" 5 3 "--no-features" && \
  do_report validation-extended-8symbols-8bots

# RUN 7 — true unseen-symbol generalization (features ON; own experimental model)
do_replay validation-unseen-symbol-generalization universe 5 3 "" && {
  do_report validation-unseen-symbol-generalization
  log "  training RUN 7 experimental model (LINK/AVAX/NEAR/INJ held out of all fitting)"
  node server/backtest/train-experimental.js --run-id validation-unseen-symbol-generalization
  log "  train-experimental exit $?"
}

log "=== combined cross-run report ==="
node server/backtest/combined-report.js
log "combined-report exit $?"

log "=== VALIDATION PIPELINE COMPLETE ===  see server/backtest/reports/COMBINED-validation-report.md"
