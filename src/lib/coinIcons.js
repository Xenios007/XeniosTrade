const ICON_CODE_OVERRIDES = {
  '1000PEPE': 'pepe',
  ADA: 'ada',
  APT: 'apt',
  ARB: 'arb',
  AVAX: 'avax',
  BNB: 'bnb',
  BTC: 'btc',
  DEGO: 'dego',
  DOGE: 'doge',
  ENA: 'ena',
  ETH: 'eth',
  FET: 'fet',
  HBAR: 'hbar',
  HUMA: 'huma',
  INJ: 'inj',
  LINK: 'link',
  LTC: 'ltc',
  NEAR: 'near',
  PIXEL: 'pixel',
  RENDER: 'render',
  SOL: 'sol',
  SUI: 'sui',
  TAO: 'tao',
  TRUMP: 'trump',
  TRX: 'trx',
  TURBO: 'turbo',
  WLD: 'wld',
  XRP: 'xrp',
  ZEC: 'zec',
}

const FALLBACK_TONES = [
  'from-sky-500 to-cyan-400',
  'from-emerald-500 to-lime-400',
  'from-fuchsia-500 to-rose-400',
  'from-amber-500 to-orange-400',
  'from-violet-500 to-indigo-400',
  'from-teal-500 to-sky-400',
]

export function normalizeCoinAsset(symbol) {
  let asset = String(symbol || '').toUpperCase().trim()

  if (asset.endsWith('USDT')) {
    asset = asset.slice(0, -4)
  }

  return asset
}

export function getCoinIconCode(symbol) {
  const asset = normalizeCoinAsset(symbol)

  if (!asset) {
    return null
  }

  if (asset in ICON_CODE_OVERRIDES) {
    return ICON_CODE_OVERRIDES[asset]
  }

  return asset.toLowerCase()
}

export function getCoinIconUrl(symbol) {
  const code = getCoinIconCode(symbol)
  if (!code) {
    return null
  }

  return `https://cdn.jsdelivr.net/gh/spothq/cryptocurrency-icons@master/svg/color/${code}.svg`
}

export function getCoinMonogram(symbol) {
  const asset = normalizeCoinAsset(symbol)

  if (!asset) {
    return '?'
  }

  return asset.length <= 4 ? asset.slice(0, 2) : asset.slice(0, 3)
}

export function getCoinFallbackTone(symbol) {
  const asset = normalizeCoinAsset(symbol)
  const hash = asset.split('').reduce((total, char) => total + char.charCodeAt(0), 0)
  return FALLBACK_TONES[hash % FALLBACK_TONES.length]
}
