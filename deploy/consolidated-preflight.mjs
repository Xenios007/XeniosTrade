import fs from 'node:fs/promises'
import { createConsolidatedTestnet } from '../server/consolidated-testnet.js'

const settings=JSON.parse(await fs.readFile('/home/xenios/app/server/data/settings.json','utf8'))
const envText=await fs.readFile('/home/xenios/app/.env','utf8')
const env=Object.fromEntries(envText.split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{
  const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).trim().replace(/^['"]|['"]$/g,'')]
}))
const getCredentials=async()=>({apiKey:settings.apiKey||env.BINANCE_TESTNET_API_KEY,secretKey:settings.secretKey||env.BINANCE_TESTNET_SECRET_KEY})
const adapter=createConsolidatedTestnet({dataDir:'/home/xenios/app/server/data',getCredentials})
console.log(JSON.stringify({credentialsPresent:!!((await getCredentials()).apiKey&&(await getCredentials()).secretKey),
  account:await adapter.connection()},null,2))
