import fs from 'node:fs/promises'
const envText=await fs.readFile('/home/xenios/app/.env','utf8')
const env=Object.fromEntries(envText.split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]}))
let cookie=''
async function api(endpoint,body) {
  const response=await fetch(`http://127.0.0.1:3001${endpoint}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',cookie},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(120000)})
  const next=response.headers.get('set-cookie');if(next)cookie=next.split(';')[0]
  const result=await response.json();if(!response.ok)throw new Error(`${endpoint}: ${JSON.stringify(result)}`);return result
}
await api('/api/auth/login',{password:env.APP_LOGIN_PASSWORD||env.XENIOS_LOGIN_PASSWORD})
const before=await api('/api/consolidated')
console.log(JSON.stringify({phase:'before',enabled:before.testnet.enabled,sourceHash:before.report.sourceHash,rows:before.report.totalRowsRead}))
console.log(JSON.stringify({phase:'connection',...(await api('/api/consolidated/testnet/check',{}))}))
if(process.argv.includes('--scan')) {
  const scan=await api('/api/consolidated/scan',{})
  console.log(JSON.stringify({phase:'scan',signals:scan.state.signals.length,accepted:scan.state.signals.filter(s=>s.selection.accepted).length,errors:scan.errors}))
  if(scan.errors.length)throw new Error('Scan errors; refusing automatic activation')
}
if(process.argv.includes('--enable'))await api('/api/consolidated/testnet',{enabled:true})
const result=await api('/api/consolidated')
console.log(JSON.stringify({phase:'verified',enabled:result.testnet.enabled,position:result.testnet.position,pending:result.testnet.pending,trades:result.testnet.trades.length,error:result.testnet.error,lastScanAt:result.state.lastScanAt}))
