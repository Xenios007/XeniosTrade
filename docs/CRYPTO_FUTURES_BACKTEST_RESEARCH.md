# Crypto futures backtest research

## Decision standard

The objective is not to manufacture a report with a 50% win rate. The objective is to find a strategy that survives a predeclared test with positive net expectancy, profit factor at least 1.00, and a final untouched holdout after fees, slippage, funding, and a multiple-testing penalty. A high hit rate is secondary: trend-following systems can be profitable with fewer than half of trades winning, while a high hit rate can hide rare, large losses.

The current consolidated result fails that standard. Its five-year final holdout was 298 selected opportunities, 34.2% wins, -0.197 R mean return, and 0.745 profit factor. A new volume-filter review also failed: its best validation rule (`5m relative volume >= 1`) had 81 holdout trades, 29.6% wins, -0.262 R mean return, and 0.674 profit factor. These are rejection results, not settings to deploy.

## What established research supports

Time-series momentum is a credible first benchmark, not a guarantee. Moskowitz, Ooi, and Pedersen documented persistence in own-asset futures returns over one to twelve months across liquid instruments, with longer-horizon partial reversal.¹ Crypto-specific work has reported trend-following potential, but that study is limited to its sample and assumptions.² Liu and Tsyvinski also reported cryptocurrency time-series momentum and attention-related predictability; that does not establish a tradable USDT-perpetual edge after this system's costs.³

Transaction costs are central. A crypto trend-following study explicitly reports that transaction costs materially affect portfolio performance.⁴ This is consistent with the existing Xenios result: the selector degraded sharply under an extra 16-basis-point round-trip stress. A signal must therefore clear costs by a substantial margin, not merely show a small gross return.

The more important lesson is methodological. Bailey and co-authors show that trying many specifications can easily generate attractive backtests that fail out of sample.⁵ The Deflated Sharpe Ratio framework further adjusts performance inference for selection bias, non-normal returns, and repeated trials.⁶ Therefore every attempted signal, volume gate, exit policy, and parameter combination must be counted as a trial, including failures.

## Recommended strategy family: liquid-perpetual trend continuation

The next experiment should be a reproduction-style benchmark rather than another unrestricted classifier search. It should use a liquid, point-in-time 20-symbol USDT-perpetual universe and test a trend-continuation entry, while retaining the current consolidated selector only as a comparison baseline.

### Entry definition — fixed before testing

1. **Point-in-time universe:** each UTC day, rank eligible USDT perpetuals by trailing 30-day quote-volume. Select the top 20 after excluding stablecoin pairs, contracts without at least 180 days of history, suspended contracts, and symbols with missing data. Do not use today’s liquid names throughout historical history.
2. **Trend regime:** require 4-hour EMA(50) above EMA(200) for long or below for short; require 1-hour EMA(20) slope aligned with the 4-hour direction.
3. **Breakout:** enter only after a closed 1-hour 20-bar breakout in the trend direction, not on intrabar price movement.
4. **Actual-volume confirmation:** require 1-hour quote-volume at or above its trailing 20-bar median and direction-aligned taker-buy ratio. The exchange kline schema exposes volume, quote volume, number of trades, and taker-buy base/quote volume, so these can be measured rather than proxied.⁷
5. **Cost-aware gate:** predicted gross edge must exceed a conservative cost floor: taker fees, spread/slippage assumption, expected funding over the maximum hold, and an additional stress buffer.
6. **AI role:** a train-only model may rank valid trend entries, but it may not create entries. Its probability or expected-R buckets must be calibrated out of sample; if higher-score buckets do not outperform lower-score buckets after costs, disable the AI gate.

This is deliberately different from Bot 5's short-horizon mean reversion. The existing Bot 5 / consolidated evidence is negative. The next hypothesis is that larger, liquid trend moves combined with volume confirmation can have a more favorable payoff distribution. It is a hypothesis, not a claim that research proves this implementation will work.

## Exit policies to compare

Use the same entries for each policy and resolve stop/target ambiguity pessimistically from 5-minute OHLC data.

| Policy | Stop | Profit handling | Time stop |
|---|---|---|---|
| Source baseline | Source stop | Source target | 48h |
| 1R | 1 ATR / source-risk stop | Fixed 1R | 48h |
| 1.5R | 1 ATR / source-risk stop | Fixed 1.5R | 48h |
| Breakeven | Initial stop, then entry after 1R | Source target | 48h |
| Trend trail | Chandelier / ATR trail | No fixed target | 48h |
| Time exits | Source brackets | Source target | 12h, 24h, 48h |

The current local replay records the six listed candle-only policies except the Chandelier trail. A trail should only be added as a separate preregistered policy; it must not be adjusted after seeing holdout results.

## Validation design

Use five years minimum, but time separation matters more than a large row count.

| Period | Use |
|---|---|
| First 60% | Fit AI scorer and establish feature transforms only |
| Next 20% | Select one volume gate and one exit policy from the predeclared list |
| Final 20% | Sealed holdout: report once; do not tune after observing it |
| Forward period | Testnet-only confirmation, no strategy edits until a predeclared trade count is reached |

Purge at least the maximum possible holding period at each boundary. Cluster uncertainty by day, because trades on the same market day are correlated. Report results by symbol, side, trend/range regime, funding bucket, volume bucket, AI-score bucket, and market-cap/liquidity tier. The final portfolio simulation must enforce the intended global position cap and concurrent-symbol correlation cap.

## Acceptance gate

The candidate passes only if all conditions hold on the sealed final period:

- At least 100 closed trades and at least 50 trading days.
- Net profit factor >= 1.00 under base costs and >= 1.00 under the declared stress-cost scenario.
- Positive mean net R with a day-clustered 95% lower confidence bound above zero.
- No single symbol, calendar month, or outlier trade contributes more than 20% of total P&L.
- AI-score monotonicity: the selected highest-score bucket has better net expectancy than the lower-score bucket.
- The result remains positive after realistic funding, exchange precision, and conservative same-candle handling.
- Deflated/selection-adjusted Sharpe and the count of every tried configuration are recorded. A pass is still testnet-only until forward results confirm it.

The requested `win rate > 50%` can be reported as an additional gate for short-horizon mean reversion, but it should not veto a trend strategy that has a lower hit rate and a stronger profit factor. For this project, positive expected R, cost-stressed profit factor, and stable cross-section performance are the governing criteria.

## Current local implementation

`statistical-5yr-20sym-v1` completed locally over the 20-symbol research universe and all eight existing source bots. It recorded actual historical kline volume, relative volume, volume z-score, taker-buy flow, real funding where available, six exit-policy outcomes, and a chronological train/validation/holdout label. It does not train a production model, change the deployed server, or alter the active testnet bot.

The result is a rejection, not a candidate. Across 64,000 sampled source rows, no predeclared volume/exit combination met the requested holdout gates. The highest holdout hit rate was 49.1% (all-volume, 1R target), but it had -0.201 R mean return and 0.666 profit factor. The best holdout mean return was still -0.191 R (all-volume, breakeven after 1R), with 0.701 profit factor. No combination achieved more than 50% wins, positive mean R, and profit factor at least 1.00 simultaneously.

When complete, `npm run backtest:statistical-review -- --run-id statistical-5yr-20sym-v1` will evaluate a train-only expected-R score, the predeclared volume rules, exit variants, cost stress, calibration buckets, and one-position sequencing. The report is an evidence artifact, not an authorization to trade.

The independent trend-continuation benchmark also completed locally on the same static 20-symbol cached universe, using closed 1-hour breakouts, true completed 4-hour EMA(50)/EMA(200) trend regime, 1-hour EMA slope, actual kline volume, and taker-buy flow. It generated 5,086 candidates through 2026-07-31. The untouched holdout baseline was 1,024 trades, 32.2% wins, -0.151 R mean return, and 0.786 profit factor. A train-only AI gate produced 141 holdout trades with -0.064 R mean return and 0.907 profit factor; under the declared extra-16bp cost stress it fell to -0.153 R and 0.794 profit factor. This is also a rejection. It is useful evidence that the stricter volume-confirmed trend hypothesis does not validate on this universe and is not robust enough to trade.

## Sources

1. Moskowitz, Tobias J., Yao Hua Ooi, and Lasse Heje Pedersen. “[Time Series Momentum](https://fairmodel.econ.yale.edu/ec439/mosk.pdf).” *Journal of Financial Economics* 104, no. 2 (2012): 228–250.
2. Rozario, Evans, Samuel Holt, James West, and Shaun Ng. “[A Decade of Evidence of Trend Following Investing in Cryptocurrencies](https://arxiv.org/abs/2009.12155).” 2020.
3. Liu, Yukun, and Aleh Tsyvinski. “[Risks and Returns of Cryptocurrency](https://www.nber.org/system/files/working_papers/w24877/w24877.pdf).” NBER Working Paper 24877, 2018.
4. Le, Trinh Hue, and Ummul Ruthbah. “[Trend-following Strategies for Crypto Investors](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4551518).” SSRN, 2023.
5. Bailey, David H., Jonathan M. Borwein, Marcos López de Prado, and Qiji Jim Zhu. “[Pseudo-Mathematics and Financial Charlatanism: The Effects of Backtest Overfitting on Out-of-Sample Performance](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2308659).” 2014.
6. Bailey, David H., and Marcos López de Prado. “[The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting and Non-Normality](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf).” 2014.
7. Binance. “[USDⓈ-M Futures Kline/Candlestick Data](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/market-data/rest-api/Kline-Candlestick-Data).” Accessed September 2026.
