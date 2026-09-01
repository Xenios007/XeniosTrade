export const STARTING_RUNNING_BALANCE_USDT = 1000

export const VOLATILE_MARKET_SYMBOL_LIMIT = 60

// --- 8-bot 5-year backtest universe (see server/backtest/EXPANSION-PLAN.md) ---
// The primary run's symbol set. CORE = longer-history majors used as the
// robustness benchmark; EXTENDED = shorter-history / higher-volatility names
// kept tagged separately so they cannot dominate the training data.
export const BACKTEST_CORE_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT', 'ADAUSDT',
  'DOGEUSDT', 'LINKUSDT', 'LTCUSDT', 'TRXUSDT', 'DOTUSDT', 'AVAXUSDT',
]
export const BACKTEST_EXTENDED_SYMBOLS = [
  'NEARUSDT', 'APTUSDT', 'ARBUSDT', 'INJUSDT', 'SUIUSDT', 'FETUSDT',
  'HBARUSDT', '1000PEPEUSDT',
]
export const BACKTEST_UNIVERSE = [...BACKTEST_CORE_SYMBOLS, ...BACKTEST_EXTENDED_SYMBOLS]
export const isExtendedBacktestSymbol = (symbol) => BACKTEST_EXTENDED_SYMBOLS.includes(String(symbol || '').toUpperCase())

export const DEFAULT_PREFERRED_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'BNBUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'LTCUSDT',
  'SUIUSDT',
  'TRXUSDT',
  'DOTUSDT',
  'NEARUSDT',
  'TAOUSDT',
  'FETUSDT',
  '1000PEPEUSDT',
  'PIXELUSDT',
  'TURBOUSDT',
  'TRUMPUSDT',
  'APTUSDT',
  'ARBUSDT',
  'INJUSDT',
  'WLDUSDT',
  'HBARUSDT',
]
