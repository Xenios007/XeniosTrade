export const MANUAL_TRADE_STYLE_PRESET_ID = 'manual'

export const TRADE_STYLE_PRESET_SETTING_KEYS = [
  'marginPerTrade',
  'leverage',
  'maxOpenPositions',
  'stopLossPercent',
  'takeProfitPercent',
  'maxTradesPerDay',
  'maxLossesPerDay',
  'maxLossPerDay',
  'dailyProfitTarget',
]

export const TRADE_STYLE_PRESETS = [
  {
    id: MANUAL_TRADE_STYLE_PRESET_ID,
    name: 'Manual',
    tag: 'Custom',
    description: 'Keep every automatic-trading control editable and manage the numbers yourself.',
    horizon: 'Any horizon',
    executionStyle: 'Uses your current custom values.',
    riskReward: 'Custom',
    values: {},
    sources: [],
  },
  {
    id: 'scalping',
    name: 'Scalping',
    tag: 'Fast',
    description: 'Built for quick intraday rotations with tight stops, smaller targets, and more trade attempts.',
    horizon: 'Minutes to a few hours',
    executionStyle: 'Tight risk, faster turnover, more daily trade allowance.',
    riskReward: '1:2',
    values: {
      marginPerTrade: 200,
      leverage: 10,
      maxOpenPositions: 2,
      stopLossPercent: 0.4,
      takeProfitPercent: 0.8,
      maxTradesPerDay: 12,
      maxLossesPerDay: 4,
      maxLossPerDay: 32,
      dailyProfitTarget: 48,
    },
    sources: [
      {
        label: 'Binance Academy on scalping',
        url: 'https://academy.binance.com/en/articles/a-beginners-guide-to-scalping-in-cryptocurrency',
      },
      {
        label: 'Binance Academy on position sizing',
        url: 'https://academy.binance.com/en/articles/how-to-calculate-position-size-in-trading',
      },
    ],
  },
  {
    id: 'day-trade',
    name: 'Day Trade',
    tag: 'Intraday',
    description: 'Designed for same-day exits with a moderate stop, fewer trades, and a cleaner 1:2 target profile.',
    horizon: 'Hours within one session',
    executionStyle: 'Intraday risk budget with more selective daily trade caps.',
    riskReward: '1:2',
    values: {
      marginPerTrade: 240,
      leverage: 6,
      maxOpenPositions: 2,
      stopLossPercent: 0.7,
      takeProfitPercent: 1.4,
      maxTradesPerDay: 6,
      maxLossesPerDay: 3,
      maxLossPerDay: 30,
      dailyProfitTarget: 40,
    },
    sources: [
      {
        label: 'IG on day trading',
        url: 'https://www.ig.com/en/forex/fx-need-to-knows/forex-day-trading-strategies',
      },
      {
        label: 'Binance Academy on day trading',
        url: 'https://academy.binance.com/en/articles/a-beginners-guide-to-day-trading-cryptocurrency',
      },
    ],
  },
  {
    id: 'swing',
    name: 'Swing',
    tag: 'Slower',
    description: 'Wider stops, lower leverage, and fewer daily entries for trades expected to need more room.',
    horizon: 'Several days to weeks',
    executionStyle: 'Lower leverage with a wider target profile and tighter daily exposure limits.',
    riskReward: '1:3',
    values: {
      marginPerTrade: 220,
      leverage: 3,
      maxOpenPositions: 1,
      stopLossPercent: 1.5,
      takeProfitPercent: 4.5,
      maxTradesPerDay: 2,
      maxLossesPerDay: 1,
      maxLossPerDay: 20,
      dailyProfitTarget: 30,
    },
    sources: [
      {
        label: 'Binance Academy on swing trading',
        url: 'https://academy.binance.com/en/articles/a-beginners-guide-to-swing-trading-cryptocurrency',
      },
      {
        label: 'Binance Academy on leverage risk',
        url: 'https://academy.binance.com/en/articles/what-is-leverage-in-crypto-trading',
      },
    ],
  },
]

export function getTradeStylePreset(presetId) {
  return TRADE_STYLE_PRESETS.find((preset) => preset.id === presetId) || TRADE_STYLE_PRESETS[0]
}

function doesStrategyMatchPreset(strategy = {}, preset = {}) {
  return Object.entries(preset.values || {}).every(([key, value]) => strategy?.[key] === value)
}

export function getMatchingTradeStylePreset(strategy = {}) {
  return TRADE_STYLE_PRESETS.find((preset) => (
    preset.id !== MANUAL_TRADE_STYLE_PRESET_ID
    && doesStrategyMatchPreset(strategy, preset)
  )) || null
}

export function resolveTradeStylePresetId(strategy = {}, preferredPresetId = '') {
  const matchingPreset = getMatchingTradeStylePreset(strategy)
  const storedPresetId = typeof preferredPresetId === 'string' ? preferredPresetId.trim() : ''

  if (storedPresetId) {
    const storedPreset = getTradeStylePreset(storedPresetId)
    if (storedPreset.id !== MANUAL_TRADE_STYLE_PRESET_ID && doesStrategyMatchPreset(strategy, storedPreset)) {
      return storedPreset.id
    }
  }

  return matchingPreset?.id || MANUAL_TRADE_STYLE_PRESET_ID
}

export function applyTradeStylePreset(strategy = {}, presetId = MANUAL_TRADE_STYLE_PRESET_ID) {
  const preset = getTradeStylePreset(presetId)

  if (preset.id === MANUAL_TRADE_STYLE_PRESET_ID) {
    return {
      ...strategy,
      tradeStylePresetId: MANUAL_TRADE_STYLE_PRESET_ID,
    }
  }

  return {
    ...strategy,
    ...preset.values,
    tradeStylePresetId: preset.id,
  }
}
