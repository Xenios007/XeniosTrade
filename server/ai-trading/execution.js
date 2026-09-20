// Pure rules for opening AI Trading decisions on the AI wallets (testnet / real
// money). No I/O here: mock-trading-server.js feeds in the run, the config, the
// ledger, the live price and the exchange balance, and does the exchange calls.
// Keeping the rules pure is what lets test/ai-trading-execution.test.js pin down
// the real-money safety gates.
//
// The pipeline itself still never places an order. A trade only opens when this
// module lets an *approved* run through:
//   - testnet: automatically (config.execution.autoExecuteTestnet) or on demand
//   - real money: ONLY on demand, ONLY while armed, ONLY with the symbol typed
//     back as confirmation, and always scaled down to a hard margin cap.

import { summarizeAccount } from '../../src/lib/accountMetrics.js'
import { buildEntryContext } from './position-manager.js'

export const AI_TRADE_SOURCE = 'AI_TRADING'
export const AI_MODEL_ID = 'ai-trading'
export const AI_MODEL_NAME = 'AI Trading'

export const AI_WALLET_IDS = { testnet: 'wallet-ai-testnet', real: 'wallet-ai-real' }
export const AI_WALLET_NAMES = { testnet: 'AI Testnet Wallet', real: 'AI Real Money Wallet' }

// A plan is priced off the candle at run time; the older it is, the less it
// describes the market you would actually enter.
export const MAX_PLAN_AGE_MS = { testnet: 30 * 60_000, real: 10 * 60_000 }
export const MAX_ENTRY_DRIFT_PCT = { testnet: 1.5, real: 0.5 }
export const MAX_OPEN_POSITIONS = { testnet: 5, real: 1 }
// Never commit more than this share of the available balance as margin on one trade.
export const AVAILABLE_BALANCE_USAGE = 0.9

export class AiExecutionError extends Error {
  constructor(message, status = 409) {
    super(message)
    this.name = 'AiExecutionError'
    this.status = status
  }
}

const isFinitePositive = (value) => Number.isFinite(Number(value)) && Number(value) > 0

export function isOpenAiTrade(trade) {
  return trade?.status === 'OPEN'
}

/** BUY/SELL as the rest of the app (and Binance) spells it. */
export function toExchangeSide(side) {
  if (side === 'LONG') return 'BUY'
  if (side === 'SHORT') return 'SELL'
  return null
}

/**
 * Throws AiExecutionError unless `run` may be opened in `mode` right now. Returns the trade plan.
 * `livePrice` is a fresh ticker price; `now` is injectable for tests.
 */
export function assertCanExecute({ run, mode, config, trades = [], livePrice, now = Date.now(), confirm = '', auto = false }) {
  if (mode !== 'testnet' && mode !== 'real') {
    throw new AiExecutionError('Mode must be "testnet" or "real".', 400)
  }
  if (!run) {
    throw new AiExecutionError('Run not found.', 404)
  }
  const execution = config?.execution || {}
  if (execution.mode !== mode) {
    throw new AiExecutionError(`AI Trading is in ${execution.mode || 'testnet'} mode, not ${mode}. Switch the mode on the AI Settings page first.`)
  }

  const final = run.final || {}
  const plan = final.trade
  const side = toExchangeSide(final.action)
  if (!final.approved || !plan || !side) {
    throw new AiExecutionError('Only an approved LONG/SHORT decision can be traded. This run did not approve a trade.')
  }
  if (plan.side !== final.action) {
    throw new AiExecutionError('The run\'s trade plan does not match its decision; refusing to trade it.')
  }
  if (![plan.entryPrice, plan.stopLoss, plan.takeProfit, plan.quantity, plan.notionalUsdt, plan.marginUsdt, plan.leverage].every(isFinitePositive)) {
    throw new AiExecutionError('The run\'s trade plan is incomplete; refusing to trade it.')
  }
  const isLong = final.action === 'LONG'
  if (isLong ? !(plan.stopLoss < plan.entryPrice && plan.takeProfit > plan.entryPrice) : !(plan.stopLoss > plan.entryPrice && plan.takeProfit < plan.entryPrice)) {
    throw new AiExecutionError('The stop-loss / take-profit are on the wrong side of the entry; refusing to trade it.')
  }

  if (trades.some((trade) => trade.aiRunId === run.id)) {
    throw new AiExecutionError('This run has already been executed.')
  }

  if (mode === 'real') {
    if (execution.realArmed !== true) {
      throw new AiExecutionError('Real money trading is not armed. Arm it on the AI Settings page first.', 403)
    }
    if (auto) {
      // Armed is not enough: automatic real-money entries are their own switch (config.execution.autoExecuteReal).
      if (execution.autoExecuteReal !== true) {
        throw new AiExecutionError('Real money auto-execute is off. Turn it on in AI Settings, or execute this run yourself.', 403)
      }
    } else if (String(confirm).trim().toUpperCase() !== run.symbol) {
      throw new AiExecutionError(`Type ${run.symbol} to confirm this real money trade.`, 400)
    }
  }

  const ageMs = now - Number(run.finishedAt || run.startedAt || 0)
  if (!(ageMs >= -60_000) || ageMs > MAX_PLAN_AGE_MS[mode]) {
    throw new AiExecutionError(`This run is ${Math.round(ageMs / 60_000)} min old; the plan is only tradable for ${MAX_PLAN_AGE_MS[mode] / 60_000} min. Run the pipeline again.`)
  }
  if (!isFinitePositive(livePrice)) {
    throw new AiExecutionError('No live price is available to check the plan against; not trading blind.', 502)
  }
  const driftPct = (Math.abs(Number(livePrice) - plan.entryPrice) / plan.entryPrice) * 100
  if (driftPct > MAX_ENTRY_DRIFT_PCT[mode]) {
    throw new AiExecutionError(`Price has moved ${driftPct.toFixed(2)}% since the run (limit ${MAX_ENTRY_DRIFT_PCT[mode]}%). Run the pipeline again.`)
  }
  // The market may already be through the stop or target.
  if (isLong ? (livePrice <= plan.stopLoss || livePrice >= plan.takeProfit) : (livePrice >= plan.stopLoss || livePrice <= plan.takeProfit)) {
    throw new AiExecutionError('Price is already beyond the plan\'s stop-loss or take-profit. Run the pipeline again.')
  }

  const openInMode = trades.filter((trade) => isOpenAiTrade(trade) && trade.aiTradingMode === mode)
  if (openInMode.some((trade) => trade.symbol === run.symbol)) {
    throw new AiExecutionError(`There is already an open ${mode} AI trade on ${run.symbol}.`)
  }
  if (openInMode.length >= MAX_OPEN_POSITIONS[mode]) {
    throw new AiExecutionError(`The ${mode} wallet is limited to ${MAX_OPEN_POSITIONS[mode]} open AI position(s); close one first.`)
  }

  return { plan, side }
}

/**
 * Scales the Risk Manager's plan down (never up) to fit the wallet:
 *   - real money: margin <= config.execution.realMaxMarginUsdt and <= 90% of available balance
 *   - testnet:    margin <= 90% of available balance
 * Stops and targets are untouched, so scaling only ever shrinks the loss (and the gain).
 */
export function scalePlanToWallet({ plan, mode, config, availableUsdt }) {
  const notes = []
  if (!(Number(availableUsdt) > 0)) {
    throw new AiExecutionError(`The ${mode} wallet has no available balance to use as margin.`)
  }
  let marginCap = availableUsdt * AVAILABLE_BALANCE_USAGE
  if (mode === 'real') {
    marginCap = Math.min(marginCap, config?.execution?.realMaxMarginUsdt ?? 0)
  }
  if (!(marginCap > 0)) {
    throw new AiExecutionError('No margin is allowed for this trade.')
  }
  const scale = Math.min(1, marginCap / plan.marginUsdt)
  if (scale < 1) {
    notes.push(`Position scaled to ${(scale * 100).toFixed(1)}% of the Risk Manager's size to fit ${marginCap.toFixed(2)} USDT of margin${mode === 'real' ? ' (real money cap / available balance)' : ''}.`)
  }
  return {
    scale,
    notes,
    notional: plan.notionalUsdt * scale,
    margin: plan.marginUsdt * scale,
    maxLoss: plan.maxLossUsdt * scale,
    quantityHint: plan.quantity * scale,
  }
}

const shorten = (value, max) => String(value || '').slice(0, max)

/** The ledger row for an opened AI trade — the same shape the bot trade-history/journal components read. */
export function buildAiTradeRecord({ run, plan, mode, scaled, execution, marginMode, leverage, now = Date.now(), dateKey }) {
  const wallet = AI_WALLET_IDS[mode]
  const stop = plan.stopLoss
  return {
    id: `ai-${run.id}`,
    symbol: run.symbol,
    side: toExchangeSide(plan.side),
    type: 'MARKET',
    quantity: Number(execution.quantity || scaled.quantityHint),
    stopLoss: Number(execution.stopLoss || stop),
    takeProfit: Number(execution.takeProfit || plan.takeProfit),
    // What the entry agents set. The Position Manager may move the live stop / target later; these stay for its R maths and the report.
    initialStopLoss: Number(execution.stopLoss || stop),
    initialTakeProfit: Number(execution.takeProfit || plan.takeProfit),
    initialQuantity: Number(execution.quantity || scaled.quantityHint),
    // Why the trade was taken, kept here so the Position Manager still has the thesis after the run history rolls over.
    entryContext: buildEntryContext(run),
    managerReviews: [],
    entryPrice: Number(execution.entryPrice || plan.entryPrice),
    notional: Number(execution.notional || scaled.notional),
    margin: Number(scaled.margin.toFixed(4)),
    marginMode,
    leverage,
    status: 'OPEN',
    validationStatus: execution.validationStatus,
    mode: execution.mode,
    source: AI_TRADE_SOURCE,
    signalSummary: shorten(run.final?.reason, 600),
    signalModelId: AI_MODEL_ID,
    signalModelName: AI_MODEL_NAME,
    aiRunId: run.id,
    aiTradingMode: mode,
    aiConfidence: run.final?.confidence ?? null,
    aiScaleNotes: scaled.notes,
    walletId: wallet,
    walletName: AI_WALLET_NAMES[mode],
    transactTime: now,
    tradeDateKey: dateKey,
    journalDateKey: dateKey,
    maxLossPerTrade: Number(scaled.maxLoss.toFixed(4)),
    configuredStopLossPercent: plan.stopLossPct,
    exchangeEntryOrderId: execution.exchangeEntryOrderId || null,
    exchangeEntryClientOrderId: execution.exchangeEntryClientOrderId || null,
    exchangeStopOrderId: execution.exchangeStopOrderId || null,
    exchangeStopClientOrderId: execution.exchangeStopClientOrderId || null,
    exchangeTakeProfitOrderId: execution.exchangeTakeProfitOrderId || null,
    exchangeTakeProfitClientOrderId: execution.exchangeTakeProfitClientOrderId || null,
    exchangeStopAlgoId: execution.exchangeStopAlgoId || null,
    exchangeStopAlgoClientId: execution.exchangeStopAlgoClientId || null,
    exchangeTakeProfitAlgoId: execution.exchangeTakeProfitAlgoId || null,
    exchangeTakeProfitAlgoClientId: execution.exchangeTakeProfitAlgoClientId || null,
  }
}

/** Local paper trades (testnet mode without exchange keys) settle against the live price. */
export function settlePaperTrade(trade, price) {
  if (!isOpenAiTrade(trade) || !isFinitePositive(price)) return null
  const isLong = trade.side === 'BUY'
  if (isLong ? price <= trade.stopLoss : price >= trade.stopLoss) {
    return { exitPrice: trade.stopLoss, status: 'CLOSED_SL', result: 'SL' }
  }
  // An open-ended trade (the Position Manager removed the target) has no take profit to hit; `price >= null` would read as 0.
  if (isFinitePositive(trade.takeProfit) && (isLong ? price >= trade.takeProfit : price <= trade.takeProfit)) {
    return { exitPrice: trade.takeProfit, status: 'CLOSED_TP', result: 'TP' }
  }
  return null
}

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100

/**
 * One wallet's numbers. `exchange` is the read-only account snapshot summary for
 * the wallet's environment (or null when there are no keys / it could not be read).
 * Testnet uses the configured starting balance; the real wallet's baseline is the
 * synced exchange balance minus what the AI itself has realised, so its running
 * balance lines up with the exchange.
 */
export function summarizeAiWallet({ mode, trades, config, livePrices = {}, exchange = null }) {
  const own = trades.filter((trade) => trade.aiTradingMode === mode)
  const realized = summarizeAccount({ trades: own, livePrices, startingBalance: 0 }).realizedPnl
  const startingBalance = mode === 'real'
    ? (exchange?.walletBalance != null ? round2(exchange.walletBalance - realized) : 0)
    : Number(config?.execution?.testnetStartingBalance || 0)
  const account = summarizeAccount({ trades: own, livePrices, startingBalance })
  return {
    id: AI_WALLET_IDS[mode],
    mode,
    name: AI_WALLET_NAMES[mode],
    environment: mode === 'real' ? 'REAL_MONEY' : 'TESTNET',
    startingBalance,
    startingBalanceDerived: mode === 'real',
    ledger: {
      realizedPnl: account.realizedPnl,
      unrealizedPnl: account.unrealizedPnl,
      runningBalance: account.runningBalance,
      reservedMargin: account.reservedMargin,
      availableBalance: account.availableBalance,
      openTrades: account.openTradeCount ?? own.filter(isOpenAiTrade).length,
      closedTrades: account.closedTradeCount,
      wins: account.wins,
      losses: account.losses,
    },
    exchange,
  }
}
