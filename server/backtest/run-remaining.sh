#!/usr/bin/env bash
# Detached orchestrator for the rest of the primary 8-bot pipeline. Safe to run
# while replay-dataset.js is still going: it waits for the run to reach status
# "complete", restarting the replay with --resume if it dies mid-way, then runs
# training (CUDA) and the 38-section report. Survives closing the Claude session.
#
#   nohup bash server/backtest/run-remaining.sh > launcher-logs/pipeline.log 2>&1 &
set -u
cd "$(dirname "$0")/../.."
RUN=primary-8bot-5yr
BOTS=model-1,model-2,model-3,model-4,model-5,model-6,model-7,model-8
REG=server/data/backtest-runs.json
MAN=server/data/backtest-runs/$RUN/_manifest.json
log(){ echo "$(date '+%F %T')  $*"; }

HB=server/data/backtest-runs/$RUN/_heartbeat.json
status(){ node -e "try{const r=require('./$REG');const e=r.find(x=>x.id==='$RUN');process.stdout.write(e?e.status:'none')}catch(e){process.stdout.write('none')}"; }
done_count(){ node -e "try{const m=require('./$MAN');process.stdout.write(String(m.symbolsDone.length))}catch(e){process.stdout.write('0')}"; }
# replay is alive if its heartbeat file was written in the last 150s
replay_alive(){ node -e "const fs=require('fs');try{const h=JSON.parse(fs.readFileSync('./$HB','utf8'));process.exit(Date.now()-h.updatedAt<150000?0:1)}catch(e){process.exit(1)}"; }

log "=== phase 2 orchestrator start (run $RUN) ==="
# grace period: let a freshly-launched replay write its first heartbeat
sleep 120

MISS=0
while true; do
  S=$(status); D=$(done_count)
  log "replay status=$S  symbolsDone=$D/20  alive=$(replay_alive && echo yes || echo NO)"
  [ "$S" = "complete" ] && { log "replay complete"; break; }
  if replay_alive; then MISS=0; else MISS=$((MISS+1)); fi
  # require two consecutive stale checks (~2 min) before resuming, to avoid
  # racing a replay that is mid-restart
  if [ "$MISS" -ge 2 ]; then
    log "replay heartbeat stale x$MISS and run not complete — resuming with --resume"
    node server/backtest/replay-dataset.js --months 60 --stride 2 --concurrency 5 \
      --bots "$BOTS" --symbols universe --run-id "$RUN" --cap-per-symbol-bot 500 --no-train --resume \
      >> launcher-logs/replay-resume.log 2>&1
    log "resume run exited $? (status now $(status))"
    MISS=0
  fi
  sleep 60
done

log "=== training (per-bot TAKE/SKIP, CUDA) ==="
node server/backtest/train-primary.js --run-id "$RUN"
TRAIN_RC=$?
log "train-primary exit $TRAIN_RC"

log "=== 38-section report ==="
node server/backtest/report.js --run-id "$RUN"
REPORT_RC=$?
log "report exit $REPORT_RC"

log "=== PIPELINE COMPLETE ===  report: server/backtest/reports/$RUN.md   (train_rc=$TRAIN_RC report_rc=$REPORT_RC)"
