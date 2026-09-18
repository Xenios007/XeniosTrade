import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { strictRows, discoverSources, summarize } from './consolidated-audit.js'
import { INPUT_KEYS, inputVector, predictTree, CONSOLIDATED_VERSION } from '../strategy/consolidated-model.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dataDir = path.join(root, 'server/data')
const outDir = path.join(dataDir, 'consolidated')
const TRAIN_END = Date.parse('2024-09-01T00:00:00Z')
const VAL_END = Date.parse('2025-09-01T00:00:00Z')
const EMBARGO = 48*3600000
export function splitRow(t, closedAt) {
  if (!Number.isFinite(t) || !Number.isFinite(closedAt) || closedAt < t) return 'invalid'
  if (Math.abs(t-TRAIN_END) < EMBARGO || Math.abs(t-VAL_END) < EMBARGO) return 'purged'
  if (t < TRAIN_END) return closedAt < TRAIN_END-EMBARGO ? 'train' : 'purged'
  if (t < VAL_END) return closedAt < VAL_END-EMBARGO ? 'validation' : 'purged'
  return 'holdout'
}

// Deterministic shallow CART regression. Cuts are computed from training rows only.
export function fitTree(rows, depth = 4, minLeaf = 300) {
  let nextId = 0
  const cuts = INPUT_KEYS.map((_,j) => {
    const xs = rows.map(r => r.x[j]).sort((a,b) => a-b)
    return [...new Set(Array.from({length:15},(_,i) => xs[Math.floor(xs.length*(i+1)/16)]))]
  })
  function grow(rs, level) {
    const count = rs.length, sum = rs.reduce((s,r) => s+Math.max(-4,Math.min(4,r.r)),0)
    const node = { id: nextId++, count, meanR: sum/count }
    if (!level || count < minLeaf*2) return node
    let best = null, bestGain = 0
    for (let j=0;j<INPUT_KEYS.length;j++) {
      for (const threshold of cuts[j]) {
        let n=0,s=0
        for (const r of rs) if (r.x[j]<=threshold) { n++; s+=Math.max(-4,Math.min(4,r.r)) }
        if (n<minLeaf || count-n<minLeaf) continue
        const gain = s*s/n+(sum-s)**2/(count-n)-sum*sum/count
        if (gain > bestGain) { bestGain=gain; best={feature:j,threshold} }
      }
    }
    if (!best || bestGain < 1) return node
    const left=[],right=[]
    for (const r of rs) (r.x[best.feature]<=best.threshold ? left : right).push(r)
    return { ...node, ...best, gain:bestGain, left:grow(left,level-1),right:grow(right,level-1) }
  }
  return grow(rows,depth)
}

export function selectTrades(rows, tree, threshold) {
  // A single consolidated bot: one open trade globally, deterministic entry ranking.
  const candidates = rows.map(r => ({...r,prediction:predictTree(tree,r.x)?.expectedR ?? -Infinity}))
    .filter(r => r.prediction >= threshold)
    .sort((a,b) => a.t-b.t || b.prediction-a.prediction || a.bot.localeCompare(b.bot) || a.symbol.localeCompare(b.symbol))
  const selected=[]
  let availableAt=-Infinity
  for (const r of candidates) if (r.t>availableAt) { selected.push(r); availableAt=r.end }
  return selected
}

const by = (rows,key) => Object.fromEntries([...new Set(rows.map(r=>r[key]))].sort().map(k => [k,summarize(rows.filter(r=>r[key]===k))]))
const stress = rows => rows.map(r=>({...r,r:r.r-0.0016/r.stopFraction,pnl:r.pnl-0.0016*r.notional}))

async function main() {
  await fs.mkdir(outDir,{recursive:true})
  const sources=await discoverSources(dataDir), audit=[], primary=[], experiments=new Map()
  const seenPrimary=new Set(), hash=crypto.createHash('sha256')
  for (const source of sources) {
    let count=0, invalid=0, featureRows=0, duplicates=0, zeroPrice=0
    const rows=[], seen=new Set(), botCounts={}
    for (const file of source.files) {
      for await (const raw of strictRows(file)) {
        count++
        const bot=raw.signalModelId, t=Number(raw.timestamp ?? raw.transactTime), end=Number(raw.closedAt)
        const pnl=Number(raw.label?.pnl ?? raw.pnl)
        const r=Number(raw.label?.netR)
        botCounts[bot]=(botCounts[bot]||0)+1
        if (raw.entryPrice===0) zeroPrice++
        if (!Number.isFinite(t) || !Number.isFinite(pnl)) { invalid++; continue }
        const key=`${bot}|${raw.symbol}|${t}|${raw.side}`
        if (seen.has(key)) { duplicates++; continue } seen.add(key)
        const stopFraction=Number(raw.configuredStopLossPercent)/100
        const x=inputVector({features:raw.features,botId:bot,side:raw.side,stopFraction})
        if (x) featureRows++
        const row={t,end,bot,symbol:raw.symbol,side:raw.side,regime:raw.marketRegime||'unknown',
          r:Number.isFinite(r)?r:0,pnl,notional:Number(raw.notional)||0,stopFraction,x,split:splitRow(t,end),year:new Date(t).getUTCFullYear()}
        rows.push(row)
        if (source.id==='primary-8bot-5yr' && x && Number.isFinite(r) && !seenPrimary.has(key)) {
          seenPrimary.add(key);primary.push(row);hash.update(JSON.stringify([key,r,x]))
        }
      }
    }
    const v2=rows.filter(r=>r.x && r.split!=='invalid' && r.split!=='purged')
    audit.push({id:source.id,files:source.files.length,rows:count,duplicates,invalid,featureRows,zeroPrice,botCounts,
      first:rows.length?new Date(rows.reduce((s,r)=>Math.min(s,r.t),Infinity)).toISOString():null,
      last:rows.length?new Date(rows.reduce((s,r)=>Math.max(s,r.t),-Infinity)).toISOString():null,
      netPnl:rows.reduce((s,r)=>s+r.pnl,0),wins:rows.filter(r=>r.pnl>0).length,
      usableForFrozenModel:v2.length,
      perBot:Object.fromEntries(Object.keys(botCounts).sort().map(bot=>{
        const bs=rows.filter(r=>r.bot===bot),pnl=bs.reduce((s,r)=>s+r.pnl,0)
        return [bot,{trades:bs.length,wins:bs.filter(r=>r.pnl>0).length,losses:bs.filter(r=>r.pnl<0).length,netPnl:pnl,averagePnl:bs.length?pnl/bs.length:null}]
      }))})
    if(source.id!=='primary-8bot-5yr') experiments.set(source.id,v2)
    console.log(`AUDIT ${source.id}: ${count} rows; ${featureRows} feature-complete; ${duplicates} duplicates`)
  }
  const train=primary.filter(r=>r.split==='train'),validation=primary.filter(r=>r.split==='validation'),holdout=primary.filter(r=>r.split==='holdout')
  if(train.length<2000 || validation.length<500 || holdout.length<500) throw new Error('Insufficient chronological coverage')
  console.log(`SPLIT train=${train.length}, validation=${validation.length}, sealed holdout=${holdout.length}`)
  // Small predeclared search, no holdout-dependent refitting or threshold tuning.
  const trials=[]
  for(const depth of [5,6,7]) {
    const tree=fitTree(train,depth,100)
    for(const threshold of [0,0.1,0.2,0.3]) {
      const selected=selectTrades(validation,tree,threshold), stats=summarize(selected), stressed=summarize(stress(selected))
      trials.push({depth,threshold,tree,stats,stressed,
        merit:stats.trades>=100 && stats.days>=50 ? stressed.lower95R : -Infinity})
    }
  }
  trials.sort((a,b)=> {
    if (a.merit !== b.merit) return a.merit > b.merit ? -1 : 1
    return b.stats.trades-a.stats.trades || a.depth-b.depth || a.threshold-b.threshold
  })
  const chosen=trials[0], tree=chosen.tree
  const trainSelected=selectTrades(train,tree,chosen.threshold)
  const valSelected=selectTrades(validation,tree,chosen.threshold)
  const testSelected=selectTrades(holdout,tree,chosen.threshold)
  const validationStats=summarize(valSelected),holdoutStats=summarize(testSelected),holdoutStress=summarize(stress(testSelected))
  const validated=chosen.merit>0 && holdoutStats.trades>=100 && holdoutStress.lower95R>0
  const artifact={version:CONSOLIDATED_VERSION,generatedAt:new Date().toISOString(),sourceHash:hash.digest('hex'),
    inputKeys:INPUT_KEYS,tree,threshold:chosen.threshold,depth:chosen.depth,
    executionMode:'paper-only',validated, status:validated?'paper-candidate':'research-only',
    split:{trainEnd:new Date(TRAIN_END).toISOString(),validationEnd:new Date(VAL_END).toISOString(),embargoHours:48},
    windows:{entry:301,setup:161,bias:161},
    trainingSource:'primary-8bot-5yr',baselineFeeBpsPerSide:5,baselineSlippageBpsPerSide:2,
    maxHoldHours:48, sourceBots:Array.from({length:8},(_,i)=>`model-${i+1}`)}
  const assessments=[]
  for(const [id,rs] of experiments) {
    // Only the same final calendar period; never train on repeated runs.
    const future=rs.filter(r=>r.split==='holdout')
    const selected=selectTrades(future,tree,chosen.threshold)
    assessments.push({id,eligible:future.length,selected:summarize(selected),
      note:future.length?'Secondary sensitivity check; rows may overlap primary and are not independent evidence.':'No complete features available; cannot evaluate the consolidated selector on this run.'})
  }
  const leaves=[]
  function collect(node,rules=[]) {
    if(node.feature===undefined) {leaves.push({id:node.id,trainingSamples:node.count,expectedR:node.meanR,
      accepted:node.meanR>=chosen.threshold,rules,
      validation:summarize(validation.filter(r=>predictTree(tree,r.x).leafId===node.id))});return}
    collect(node.left,[...rules,`${INPUT_KEYS[node.feature]} <= ${node.threshold}`])
    collect(node.right,[...rules,`${INPUT_KEYS[node.feature]} > ${node.threshold}`])
  }
  collect(tree)
  const importance=new Map()
  function visit(n) {
    if(n.feature===undefined)return
    const key=INPUT_KEYS[n.feature];importance.set(key,(importance.get(key)||0)+n.gain)
    visit(n.left);visit(n.right)
  }
  visit(tree)
  const totalGain=[...importance.values()].reduce((s,v)=>s+v,0)
  const featureImportance=[...importance].sort((a,b)=>b[1]-a[1]).map(([feature,gain])=>({feature,share:gain/totalGain}))
  const featureContrasts=INPUT_KEYS.map((feature,j)=>{
    const wins=train.filter(r=>r.r>0),losses=train.filter(r=>r.r<=0)
    const mean=rs=>rs.reduce((s,r)=>s+r.x[j],0)/rs.length
    const winMean=mean(wins),lossMean=mean(losses),allMean=mean(train)
    const sd=Math.sqrt(train.reduce((s,r)=>s+(r.x[j]-allMean)**2,0)/train.length)
    return {feature,winMean,lossMean,standardizedDifference:sd?(winMean-lossMean)/sd:0}
  }).sort((a,b)=>Math.abs(b.standardizedDifference)-Math.abs(a.standardizedDifference))
  const report={...artifact,tree:undefined,inputKeys:undefined,audit,totalRowsRead:audit.reduce((s,a)=>s+a.rows,0),
    primaryRows:primary.length,excludedPrimary:primary.filter(r=>['purged','invalid'].includes(r.split)).length,
    baseline:{train:summarize(train),validation:summarize(validation),holdout:summarize(holdout)},
    consolidated:{train:summarize(trainSelected),validation:validationStats,holdout:holdoutStats,holdoutStress},
    bots:by(primary,'bot'),holdoutBots:by(holdout,'bot'),selectedHoldoutBots:by(testSelected,'bot'),
    years:by(primary,'year'),regimes:by(primary,'regime'),sides:by(primary,'side'),
    trials:trials.map(({tree,...t})=>({...t,merit:Number.isFinite(t.merit)?t.merit:null})),leaves,assessments,featureImportance,featureContrasts,
    limitations:[
      'Reservoir-sampled opportunities, not a complete bar-by-bar consolidated portfolio replay; returns and drawdown are not deployable portfolio estimates.',
      'Source bot cooldowns suppressed some original opportunities; cross-bot consensus cannot be reconstructed reliably from these samples.',
      'Legacy and repeated validation runs are audited separately, never pooled into training.',
      'One open position globally is enforced in selection; missing unsampled signals can change that sequence.',
      'Bots 1/2 historical order book is a taker-volume proxy. Bot 8 requires genuine historical funding availability.',
      'Stored prices are rounded to two decimals, including zero for some cheap tokens; normalized labels and stop percentages are used instead.',
      'Confidence intervals cluster trades by UTC day, but remain approximate and do not correct every model-selection or serial-dependence effect.',
      'The final year is held out from this training procedure; earlier project work may already have inspected these historical outcomes.',
      'Initial depth-3-to-5 trees with 300-sample leaves admitted no trades. The search was expanded on training/validation to depth 5-7 with 100-sample leaves before any selected holdout trades were evaluated.',
      'No exchange execution or automatic funding is enabled by this model.'
    ]}
  await fs.writeFile(path.join(outDir,'model.json'),JSON.stringify(artifact,null,2))
  await fs.writeFile(path.join(outDir,'report.json'),JSON.stringify(report,null,2))
  const pct=v=>(100*v).toFixed(2)+'%'
  const lines=['# Consolidated bot: empirical signal analysis','',`Generated: ${artifact.generatedAt}`,`Status: ${artifact.status}`,'',
    `Read ${report.totalRowsRead.toLocaleString()} stored rows across ${audit.length} sources. Fit only ${train.length} primary training rows.`,
    '', '| Final-year sample | Trades | Win rate | Mean net R | Profit factor | Lower 95% R |', '|---|---:|---:|---:|---:|---:|',
    ...[['All source opportunities',report.baseline.holdout],['Consolidated one-position selection',holdoutStats],['Additional 16 bps round-trip stress',holdoutStress]].map(([name,s])=>`| ${name} | ${s.trades} | ${pct(s.winRate)} | ${s.meanR.toFixed(4)} | ${s.profitFactor?.toFixed(3)??'n/a'} | ${s.lower95R?.toFixed(4)??'n/a'} |`),
    '', '## Source bots','', '| Bot | Rows | Win rate | Mean net R |','|---|---:|---:|---:|',
    ...Object.entries(report.bots).map(([bot,s])=>`| ${bot} | ${s.trades} | ${pct(s.winRate)} | ${s.meanR.toFixed(4)} |`),
    '', '## Accepted entry rules','',...leaves.filter(l=>l.accepted).flatMap(l=>[
      `### Leaf ${l.id}: ${l.trainingSamples} training samples, expected ${l.expectedR.toFixed(3)} R`,
      ...l.rules.map(r=>`- ${r}`),'']),
    '## Limits of the evidence','',...report.limitations.map(l=>`- ${l}`)]
  await fs.writeFile(path.join(root,'docs/CONSOLIDATED_BOT_ANALYSIS.md'),lines.join('\n')+'\n')
  console.log(JSON.stringify({status:artifact.status,baseline:report.baseline.holdout,consolidated:report.consolidated,leaves:leaves.filter(l=>l.accepted)},null,2))
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e);process.exitCode=1})
