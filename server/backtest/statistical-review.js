// Post-replay statistical review. It never changes a strategy artifact: it
// scores chronologically, chooses no threshold from the holdout, and writes an
// explicit report for human review.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { strictRows, summarize } from './consolidated-audit.js'
import { fitTree, selectTrades } from './train-consolidated.js'
import { inputVector } from '../strategy/consolidated-model.js'
import { EXIT_POLICIES } from './exit-policy.js'

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..')
const args=Object.fromEntries(process.argv.slice(2).reduce((a,x,i,v)=>x.startsWith('--')?[...a,[x.slice(2),v[i+1]]]:a,[]))
const runId=args['run-id']
if(!runId)throw new Error('Use --run-id <completed replay run>')
const source=path.join(root,'server/data/backtest-runs',`${runId}.ndjson`)
const outDir=path.join(root,'server/data/backtest-research')
const day=t=>new Date(t).toISOString().slice(0,10)
const actualVolumeRules=Object.freeze([
  {id:'all',label:'No volume filter',pass:()=>true},
  {id:'rel_volume_1',label:'5m relative volume ≥ 1.00',pass:r=>r.features.e5_rel_volume>=1},
  {id:'rel_volume_taker',label:'Relative volume ≥ 1.00 + direction-aligned taker flow',pass:r=>r.features.e5_rel_volume>=1&&(r.side==='BUY'?r.features.e5_taker_buy_ratio>=.5:r.features.e5_taker_buy_ratio<=.5)},
  {id:'volume_zscore',label:'5m volume z-score ≥ 0',pass:r=>r.features.e5_vol_zscore>=0},
])
const cloneForExit=(r,id)=>{
  const x=id==='source'?{pnl:r.pnl,r:r.r,end:r.end,closedAt:r.end}:r.exitVariants?.[id]
  if(!x)return null
  return {...r,pnl:Number(x.pnl),r:Number(x.netR??x.r),end:Number(x.closedAt??x.end),closedAt:Number(x.closedAt??x.end)}
}
const stress=rows=>rows.map(r=>({...r,r:r.r-.0016/r.stopFraction,pnl:r.pnl-.0016*r.notional}))
function predict(tree,x){let n=tree;while(n.feature!==undefined)n=x[n.feature]<=n.threshold?n.left:n.right;return n.meanR}
function scoreBuckets(rows,tree){
  const buckets=[[-Infinity,-.1],[-.1,0],[0,.1],[.1,.25],[.25,Infinity]]
  return buckets.map(([lo,hi])=>{const rs=rows.filter(r=>{const p=predict(tree,r.x);return p>=lo&&p<hi});return {range:`${lo===-Infinity?'-∞':lo} to ${hi===Infinity?'∞':hi}`,...summarize(rs)}})
}
const fmt=s=>`${s.trades} trades · ${(s.winRate*100).toFixed(1)}% win · ${s.meanR.toFixed(3)} R · PF ${s.profitFactor?.toFixed(3)??'n/a'} · 95% [${s.lower95R?.toFixed(3)??'n/a'}, ${s.upper95R?.toFixed(3)??'n/a'}]`
const table=(headers,rows)=>['| '+headers.join(' | ')+' |','| '+headers.map(()=>'---').join(' | ')+' |',...rows.map(r=>'| '+r.join(' | ')+' |')].join('\n')

async function main(){
  const rows=[]
  for await(const raw of strictRows(source)){
    const t=Number(raw.timestamp),end=Number(raw.closedAt),stopFraction=Number(raw.configuredStopLossPercent)/100
    const x=inputVector({features:raw.features,botId:raw.signalModelId,side:raw.side,stopFraction})
    const r=Number(raw.label?.netR),pnl=Number(raw.label?.pnl)
    if(!x||!Number.isFinite(t)||!Number.isFinite(end)||!Number.isFinite(r)||!Number.isFinite(pnl)||stopFraction<=0)continue
    rows.push({t,end,closedAt:end,r,pnl,x,features:raw.features,side:raw.side,bot:raw.signalModelId,symbol:raw.symbol,split:raw.split,stopFraction,notional:Number(raw.notional)||0,exitVariants:raw.exitVariants||{}})
  }
  const train=rows.filter(r=>r.split==='train'),validation=rows.filter(r=>r.split==='val'),holdout=rows.filter(r=>r.split==='holdout')
  if(train.length<1000||validation.length<300||holdout.length<300)throw new Error(`Insufficient chronological rows: ${train.length}/${validation.length}/${holdout.length}`)
  // AI score: shallow regression tree trained exclusively on the chronological
  // train split. Fixed 0.10R gate is declared before validation/holdout review.
  const aiTree=fitTree(train,6,100),threshold=.1
  const evaluations=[]
  for(const volume of actualVolumeRules){
    const valCandidates=validation.filter(volume.pass).map(r=>({...r,prediction:predict(aiTree,r.x)}))
    const testCandidates=holdout.filter(volume.pass).map(r=>({...r,prediction:predict(aiTree,r.x)}))
    for(const policyId of Object.keys(EXIT_POLICIES)){
      const val=selectTrades(valCandidates.map(r=>cloneForExit(r,policyId)).filter(Boolean),aiTree,threshold)
      const test=selectTrades(testCandidates.map(r=>cloneForExit(r,policyId)).filter(Boolean),aiTree,threshold)
      evaluations.push({volume:volume.id,volumeLabel:volume.label,policyId,policyLabel:EXIT_POLICIES[policyId].label,validation:summarize(val),holdout:summarize(test),holdoutStress:summarize(stress(test)),days:new Set(test.map(r=>day(r.t))).size})
    }
  }
  const ranked=[...evaluations].sort((a,b)=>(b.validation.lower95R??-Infinity)-(a.validation.lower95R??-Infinity)||b.validation.trades-a.validation.trades)
  const chosen=ranked[0]
  const report={version:'statistical-review-v1',runId,generatedAt:new Date().toISOString(),source,rows:rows.length,
    specification:{aiScore:'chronological shallow regression tree, train split only',aiThresholdR:threshold,volumeRules:actualVolumeRules.map(({id,label})=>({id,label})),exitPolicies:EXIT_POLICIES,frictionStress:'additional 16 bps round trip'},
    splits:{train:train.length,validation:validation.length,holdout:holdout.length},
    aiCalibration:{validation:scoreBuckets(validation,aiTree),holdout:scoreBuckets(holdout,aiTree)},evaluations,chosenByValidation:chosen,
    caveats:['The selector, volume rule, and exit policy are evaluated on the same finite validation period; holdout remains descriptive only after this run is complete.','Historical Binance kline volume and taker-buy volume are used; historical order-book depth is unavailable and remains a proxy limitation.','Exit policies use 5m OHLC only. Stop wins same-bar stop/target ambiguity; results are conservative but not tick-accurate.','A one-position global sequence is enforced separately for every exit policy.','No finding here authorizes real-money trading.']}
  await fs.mkdir(outDir,{recursive:true})
  await fs.writeFile(path.join(outDir,`${runId}.json`),JSON.stringify(report,null,2))
  const lines=['# Statistical consolidated-backtest review','',`Run: \`${runId}\``,`Rows: ${rows.length.toLocaleString()} · chronological splits: ${train.length.toLocaleString()} / ${validation.length.toLocaleString()} / ${holdout.length.toLocaleString()}`,'',
    '## Predeclared design','', '- Actual Binance 5m relative volume, volume z-score, and taker-buy flow are entry-time features.', '- AI score is a shallow regression tree fit only on the train split; fixed gate: 0.10 expected R.', '- Exit comparisons use source brackets, 1R / 1.5R targets, breakeven after 1R, and 12h / 24h time exits.', '', '## Validation-ranked combinations','',table(['Volume filter','Exit','Validation','Holdout','Stressed holdout'],ranked.map(x=>[x.volumeLabel,x.policyLabel,fmt(x.validation),fmt(x.holdout),fmt(x.holdoutStress)])),'', '## AI score calibration','',table(['Score bucket','Validation','Holdout'],report.aiCalibration.validation.map((x,i)=>[x.range,fmt(x),fmt(report.aiCalibration.holdout[i])])),'', '## Caveats','',...report.caveats.map(x=>`- ${x}`),'']
  await fs.writeFile(path.join(root,'server/backtest/runs',`${runId}-statistical-review.md`),lines.join('\n'))
  console.log(JSON.stringify({runId,rows:rows.length,chosenByValidation:chosen,report:path.join(outDir,`${runId}.json`)},null,2))
}
main().catch(e=>{console.error(e);process.exitCode=1})
