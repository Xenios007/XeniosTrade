import { useCallback, useEffect, useState } from 'react'
import { Bot, FlaskConical, RefreshCw, Play, Pause, ChevronDown, GitBranch } from 'lucide-react'
import { PageHeader } from './ui/PageHeader'
import { Panel } from './Panel'

const number=(v,d=3)=>Number.isFinite(v)?v.toLocaleString(undefined,{maximumFractionDigits:d}):'—'
const percent=v=>Number.isFinite(v)?`${(v*100).toFixed(2)}%`:'—'
const time=v=>v?new Date(v).toLocaleString():'Not scanned yet'
const button='inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-200 hover:bg-white/10 disabled:opacity-40'
async function request(url,body) {
  const response=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined)
  const data=await response.json()
  if(!response.ok) throw new Error(data.error||`Request failed (${response.status})`)
  return data
}
function Metric({label,value,detail}) {
  return <div className='rounded-2xl border border-white/10 bg-slate-950/40 p-5'>
    <p className='text-xs uppercase tracking-widest text-slate-400'>{label}</p>
    <p className='mt-3 text-3xl font-semibold tabular-nums text-white'>{value}</p>
    <p className='mt-2 text-xs leading-5 text-slate-500'>{detail}</p>
  </div>
}
function StatsRow({label,stats}) {
  return <tr className='border-t border-white/5'><td className='py-3 pr-4 text-slate-300'>{label}</td>
    <td>{number(stats?.trades,0)}</td><td>{percent(stats?.winRate)}</td>
    <td className={stats?.meanR>0?'text-emerald-300':'text-rose-300'}>{number(stats?.meanR)} R</td>
    <td>{number(stats?.profitFactor)}</td><td>{number(stats?.lower95R)} to {number(stats?.upper95R)} R</td></tr>
}
export function ConsolidatedBotPage() {
  const [data,setData]=useState(null),[error,setError]=useState(''),[working,setWorking]=useState(false),[tab,setTab]=useState('evidence')
  const refresh=useCallback(async()=>{
    try {setData(await request('/api/consolidated'));setError('')} catch(e){setError(e.message)}
  },[])
  useEffect(()=>{refresh();const timer=setInterval(refresh,10000);return()=>clearInterval(timer)},[refresh])
  async function act(url,body) {
    setWorking(true);setError('')
    try {await request(url,body);await refresh()} catch(e){setError(e.message)} finally {setWorking(false)}
  }
  if(!data) return <div><PageHeader title='Bot 10 · Consolidated Knowledge' description='Loading the frozen evidence selector built from Bots 1–8.'/>
    {error?<p role='alert' className='text-rose-300'>{error}</p>:<p className='text-slate-400'>Loading…</p>}
    <button className={`${button} mt-4`} onClick={refresh}>Retry</button></div>
  const {report:r,state:s}=data, disabled=working||data.busy
  const approved=(r.leaves||[]).filter(l=>l.accepted)
  return <div className='space-y-6'>
    <PageHeader title='Bot 10 · Consolidated Knowledge' description='Bots 1–8 supply setups. Bot 10 applies the frozen evidence selector and owns its separate testnet ledger.' actions={<>
      <button className={button} disabled={disabled} onClick={()=>act('/api/consolidated/scan',{})}><RefreshCw size={15} className={disabled?'animate-spin':''}/>Scan signals</button>
      <button className={button} disabled={disabled} onClick={()=>act('/api/consolidated/paper',{enabled:!s.enabled})}>
        {s.enabled?<Pause size={15}/>:<Play size={15}/>} {s.enabled?'Pause paper entries':'Start paper research'}</button>
    </>}/>
    {error||data.error?<p role='alert' className='rounded-xl border border-rose-400/20 bg-rose-400/5 p-4 text-sm text-rose-200'>{error||data.error}</p>:null}
    <div className={`flex gap-4 rounded-2xl border p-5 ${r.validated?'border-emerald-400/20 bg-emerald-400/5':'border-amber-400/20 bg-amber-400/5'}`}>
      <FlaskConical className='mt-1 shrink-0 text-amber-300' size={22}/><div>
        <h2 className='font-medium text-white'>{r.validated?'Eligible for further paper validation':'Research only · profitability not established'}</h2>
        <p className='mt-1 text-sm leading-6 text-slate-300'>The frozen selector {r.validated?'passed':'did not pass'} the out-of-sample and cost-stress gates. Paper research is simulated. The separate testnet control sends actual Binance demo futures orders only. Real-money trading is unavailable.</p>
      </div>
    </div>
    <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
      <Metric label='Historical rows audited' value={number(r.totalRowsRead,0)} detail={`${r.audit.length} sources · ${number(r.primaryRows,0)} feature-complete primary rows`}/>
      <Metric label='Final-year win rate' value={percent(r.consolidated.holdout.winRate)} detail={`${number(r.consolidated.holdout.trades,0)} selected opportunities · sampled history`}/>
      <Metric label='Final-year profit factor' value={number(r.consolidated.holdout.profitFactor)} detail='Net R gains ÷ net R losses. Above 1 is positive.'/>
      <Metric label='Paper balance' value={`${number(s.balance,2)} USDT`} detail={`${s.enabled?'Research enabled':'Entries paused'} · $1 risk including modeled costs · $100 notional cap`}/>
    </div>
    <div className='flex gap-2 border-b border-white/10 pb-3'>
      {['evidence','signals','rules','paper'].map(t=><button key={t} onClick={()=>setTab(t)} className={`rounded-xl px-4 py-2 text-sm capitalize ${tab===t?'bg-sky-400/15 text-sky-200':'text-slate-400 hover:text-white'}`}>{t}</button>)}
    </div>
    {tab==='evidence'&&<>
      <Panel title='Out-of-sample evidence'>
        <p className='mb-4 text-sm leading-6 text-slate-400'>Fit before September 2024. Select thresholds through August 2025. Evaluate from September 2025 onward. A 48-hour gap separates periods. The selector permits one position at a time; the source baseline includes every sampled opportunity.</p>
        <div className='overflow-x-auto'><table className='w-full min-w-[680px] text-left text-sm tabular-nums text-slate-400'>
          <thead className='text-xs text-slate-500'><tr><th className='pb-3'>Sample</th><th>Trades</th><th>Win rate</th><th>Mean net R</th><th>Profit factor</th><th>Approx. 95% interval</th></tr></thead>
          <tbody><StatsRow label='All source opportunities · final year' stats={r.baseline.holdout}/>
            <StatsRow label='Bot 10 · validation' stats={r.consolidated.validation}/>
            <StatsRow label='Bot 10 · final year' stats={r.consolidated.holdout}/>
            <StatsRow label='Bot 10 · higher trading costs' stats={r.consolidated.holdoutStress}/></tbody>
        </table></div>
        <p className='mt-4 text-xs leading-5 text-slate-500'>R measures return per unit of original stop risk. Stress adds 16 basis points of round-trip cost. Day-clustered intervals account for some correlated outcomes. These are sampled signal results, not a complete portfolio equity curve.</p>
      </Panel>
      <Panel title='What each source bot contributed'>
        <div className='overflow-x-auto'><table className='w-full min-w-[640px] text-left text-sm tabular-nums text-slate-400'>
          <thead className='text-xs text-slate-500'><tr><th className='pb-3'>Primary sample</th><th>Trades</th><th>Win rate</th><th>Mean net R</th><th>Profit factor</th><th>Approx. 95% interval</th></tr></thead>
          <tbody>{Object.entries(r.bots).map(([id,stats])=><StatsRow key={id} label={`Bot ${id.split('-')[1]}`} stats={stats}/>)}</tbody>
        </table></div>
      </Panel>
      <Panel title='Which inputs mattered in training'>
        <p className='mb-5 text-sm leading-6 text-slate-400'>These inputs most reduced prediction error in the fitted tree. Importance describes the model, not causation or proof of profitability. Stop distance matters partly because the same trading fee consumes more of a tight stop.</p>
        <div className='grid gap-4 sm:grid-cols-2'>{r.featureImportance?.slice(0,10).map(f=><div key={f.feature}>
          <div className='mb-2 flex justify-between gap-3 text-xs'><span className='font-mono text-slate-300'>{f.feature}</span><span className='text-slate-500'>{percent(f.share)}</span></div>
          <div className='h-1.5 overflow-hidden rounded-full bg-white/5'><div className='h-full rounded-full bg-sky-400/60' style={{width:`${f.share*100}%`}}/></div>
        </div>)}</div>
        <details className='mt-5 text-sm text-slate-400'><summary className='cursor-pointer'>Winning versus losing entries · training sample</summary>
          <div className='mt-4 overflow-x-auto'><table className='w-full text-left text-xs tabular-nums'>
            <thead><tr><th className='pb-3'>Feature</th><th>Win mean</th><th>Loss mean</th><th>Standardized difference</th></tr></thead>
            <tbody>{r.featureContrasts?.slice(0,15).map(f=><tr key={f.feature} className='border-t border-white/5'><td className='py-2 font-mono'>{f.feature}</td><td>{number(f.winMean,5)}</td><td>{number(f.lossMean,5)}</td><td>{number(f.standardizedDifference)}</td></tr>)}</tbody>
          </table></div>
        </details>
      </Panel>
      <Panel title='Data coverage and limitations'>
        <div className='space-y-3'>{r.audit.map(a=><div key={a.id} className='flex flex-wrap justify-between gap-2 border-b border-white/5 pb-3 text-sm'>
          <span className='break-all text-slate-300'>{a.id}</span><span className='text-slate-500'>{number(a.rows,0)} rows · {number(a.featureRows,0)} complete features</span>
        </div>)}</div>
        <ul className='mt-5 list-disc space-y-2 pl-5 text-xs leading-6 text-slate-400'>{r.limitations.map(l=><li key={l}>{l}</li>)}</ul>
        <details className='mt-5 text-sm text-slate-400'><summary className='cursor-pointer'>Secondary run checks</summary>
          {r.assessments.map(a=><div className='mt-4 border-t border-white/5 pt-3' key={a.id}><p className='break-all text-xs text-slate-300'>{a.id}</p>
            <p className='mt-1 text-xs leading-5'>{a.eligible?`${a.selected.trades} selected · ${percent(a.selected.winRate)} win rate · ${number(a.selected.meanR)} R average. `:''}{a.note}</p></div>)}
        </details>
      </Panel>
    </>}
    {tab==='signals'&&<Panel title='Current source signals' action={<span className='text-xs text-slate-500'>{time(s.lastScanAt)}</span>}>
      <p className='mb-5 text-sm text-slate-400'>Scanning {s.symbols.join(', ')} with the original eight signal engines and training-matched closed candle windows. Bot 10 does not replace them: it ranks their valid setups. Missing funding disables funding-dependent setups. Each pattern score is a training estimate, not a guaranteed return.</p>
      {!s.signals.length&&<div className='py-10 text-center text-slate-500'><Bot className='mx-auto mb-3'/>Run a scan to inspect the eight Bot 10 source engines.</div>}
      <div className='grid gap-3 lg:grid-cols-2'>{s.signals.map(c=><details key={`${c.symbol}-${c.sourceBot}`} className='rounded-xl border border-white/10 bg-slate-950/30 p-4'>
        <summary className='flex cursor-pointer list-none items-center justify-between gap-3'><span className='text-sm text-white'>{c.symbol} · Bot {c.sourceBot.split('-')[1]}</span>
          <span className={`text-xs ${c.selection.accepted?'text-emerald-300':'text-slate-500'}`}>{c.selection.accepted?`${c.direction} · paper candidate`:'WAIT'} <ChevronDown className='inline' size={14}/></span></summary>
        <p className='mt-3 text-xs leading-5 text-slate-400'>{c.selection.reason}</p>
        {c.selection.expectedR!=null&&<p className='mt-2 text-xs text-sky-300'>Training estimate {number(c.selection.expectedR)} R · {c.selection.trainingSamples} samples · leaf {c.selection.leafId}</p>}
        <ul className='mt-3 space-y-1 font-mono text-xs text-slate-500'>{c.selection.trace?.map((t,i)=><li key={i}>{t.feature}: {number(t.value,6)} {t.operator} {number(t.threshold,6)}</li>)}</ul>
      </details>)}</div>
      {s.errors?.map(e=><p key={e.symbol} className='mt-3 text-sm text-amber-300'>{e.symbol}: {e.error}</p>)}
    </Panel>}
    {tab==='rules'&&<Panel title='Bot 10 frozen entry rules' action={<GitBranch size={18} className='text-sky-300'/>}>
      <p className='mb-5 text-sm leading-6 text-slate-400'>An original bot must first produce a valid setup. Its source identity, stop distance, and closed 5M / 15M / 1H features then pass through this tree. A pattern must exceed {number(r.threshold)} expected R in training. These rules remain experimental because the combined selector failed validation.</p>
      <div className='space-y-4'>{approved.map(l=><details key={l.id} className='rounded-xl border border-white/10 p-4'>
        <summary className='cursor-pointer text-sm text-white'>Pattern {l.id} · {l.trainingSamples} training samples · {number(l.expectedR)} expected R</summary>
        <ul className='mt-4 list-disc space-y-2 pl-5 font-mono text-xs text-slate-400'>{l.rules.map(rule=><li key={rule}>{rule}</li>)}</ul>
        <p className='mt-4 text-xs text-amber-200'>Validation: {l.validation.trades} opportunities · {percent(l.validation.winRate)} wins · {number(l.validation.meanR)} R average</p>
      </details>)}</div>
      <p className='mt-5 break-all font-mono text-xs text-slate-600'>Source fingerprint: {r.sourceHash}</p>
    </Panel>}
    {data.testnet&&<Panel title='Bot 10 · Actual Binance Futures testnet trades'>
      <p className='mb-4 text-sm leading-6 text-slate-400'>One position, 1x isolated leverage, 100 USDT maximum notional, 1 USDT modeled stop risk. At most three trades and 3 USDT realized losses per UTC day. Gaps can exceed the risk estimate. Existing symbol exposure blocks entry. Pausing retains position monitoring. Enabled testnet entries resume after restart.</p>
      <button className={button} disabled={disabled||data.testnet.busy} onClick={()=>act('/api/consolidated/testnet',{enabled:!data.testnet.enabled})}>{data.testnet.enabled?'Pause testnet entries':'Enable actual testnet trades'}</button>
      <p className='mt-4 text-sm text-sky-200'>{data.testnet.enabled?'Enabled — awaiting qualifying signals':'Entries paused'} · {data.testnet.endpoint}</p>
      {data.testnet.error&&<p role='alert' className='mt-3 text-sm text-amber-300'>{data.testnet.error}</p>}
      {data.testnet.pending&&<p className='mt-3 text-amber-300'>Entry awaiting exchange reconciliation; new entries blocked.</p>}
      {data.testnet.position?<div className='mt-4 text-sm text-slate-300'>
        <p>{data.testnet.position.side} {data.testnet.position.symbol} · Quantity {number(data.testnet.position.quantity,8)}</p>
        <p>Fill {number(data.testnet.position.entryPrice,8)} · Stop {number(data.testnet.position.stopLoss,8)} · Target {number(data.testnet.position.takeProfit,8)}</p>
        <p>Protection: {data.testnet.position.protection} · Unrealized {number(data.testnet.position.unrealizedPnl,4)} USDT</p>
      </div>:<p className='mt-4 text-slate-500'>No open Bot 10 testnet position.</p>}
      <div className='mt-5 overflow-x-auto'><table className='w-full text-left text-sm text-slate-400'>
        <thead><tr><th>Closed</th><th>Symbol</th><th>Source</th><th>Status</th><th>Exchange net P&amp;L</th></tr></thead>
        <tbody>{data.testnet.trades.slice(0,100).map(t=><tr key={t.clientId} className='border-t border-white/5'><td className='py-3'>{time(t.closedAt)}</td><td>{t.symbol}</td><td>{t.sourceBot}</td><td>{t.status}</td><td>{number(t.netPnl,4)} USDT</td></tr>)}</tbody>
      </table></div><p className='mt-3 text-xs text-slate-500'>Exchange realized P&amp;L minus USDT commissions; excludes funding and non-USDT commissions. Separate from the paper ledger.</p>
    </Panel>}
    {tab==='paper'&&<Panel title='Separate paper account'>
      <p className='mb-5 text-sm leading-6 text-slate-400'>One position at a time. Simulated entry at a fresh bar open, protective stop and target inherited from the source bot, 48-hour maximum hold, modeled costs on both sides. Pausing stops new entries; an existing position continues to be monitored. The paper account is separate from your eight wallets.</p>
      {s.position?<div className='rounded-xl border border-sky-400/20 bg-sky-400/5 p-4 text-sm text-slate-300'>
        <p className='font-medium text-white'>{s.position.side} {s.position.symbol} · {number(s.position.notional,2)} USDT notional</p>
        <p className='mt-2'>Entry {number(s.position.entryPrice,8)} · stop {number(s.position.stopLoss,8)} · target {number(s.position.takeProfit,8)}</p>
      </div>:<p className='py-5 text-slate-500'>No open paper position.</p>}
      <div className='mt-5 overflow-x-auto'><table className='w-full text-left text-sm text-slate-400'>
        <thead className='text-xs text-slate-500'><tr><th className='pb-3'>Closed</th><th>Symbol</th><th>Source</th><th>Exit</th><th>Net P&amp;L</th></tr></thead>
        <tbody>{s.trades.slice(0,100).map(t=><tr className='border-t border-white/5' key={t.id}><td className='py-3'>{time(t.closedAt)}</td><td>{t.symbol}</td><td>{t.sourceBot}</td><td>{t.status}</td><td className={t.netPnl>0?'text-emerald-300':'text-rose-300'}>{number(t.netPnl,4)} USDT</td></tr>)}</tbody>
      </table></div>
    </Panel>}
  </div>
}
