# Consolidated bot: empirical signal analysis

Generated: 2026-09-13T12:41:58.824Z
Status: research-only

Read 949,661 stored rows across 10 sources. Fit only 43256 primary training rows.

| Final-year sample | Trades | Win rate | Mean net R | Profit factor | Lower 95% R |
|---|---:|---:|---:|---:|---:|
| All source opportunities | 16683 | 34.66% | -0.3064 | 0.637 | -0.3325 |
| Consolidated one-position selection | 298 | 34.23% | -0.1968 | 0.745 | -0.3543 |
| Additional 16 bps round-trip stress | 298 | 34.23% | -0.3992 | 0.557 | -0.5583 |

## Source bots

| Bot | Rows | Win rate | Mean net R |
|---|---:|---:|---:|
| model-1 | 9999 | 32.68% | -0.1852 |
| model-2 | 10000 | 31.99% | -0.2121 |
| model-3 | 9998 | 31.93% | -0.2220 |
| model-4 | 9998 | 31.90% | -0.7431 |
| model-5 | 10000 | 43.81% | -0.2305 |
| model-6 | 10000 | 29.48% | -0.3473 |
| model-7 | 10000 | 39.89% | -0.2831 |
| model-8 | 10000 | 30.96% | -0.2070 |

## Accepted entry rules

### Leaf 54: 121 training samples, expected 0.284 R
- stopFraction > 0.002
- stopFraction <= 0.006
- stopFraction <= 0.004095
- b1h_lower_wick <= 0.19318182
- b1h_vol_percentile <= 0.01666667
- e5_body_range <= 0.63195009
- e5_taker_buy_ratio <= 0.50486919

### Leaf 117: 351 training samples, expected 0.115 R
- stopFraction > 0.002
- stopFraction > 0.006
- s15_rsi_slope <= 0.00152461
- s15_range_pos <= 0.86666667
- s15_bb_width > 0.01368578
- e5_ret3 > 0.00639575
- b1h_vwap_dist <= -0.02406382

### Leaf 128: 110 training samples, expected 0.188 R
- stopFraction > 0.002
- stopFraction > 0.006
- s15_rsi_slope <= 0.00152461
- s15_range_pos > 0.86666667
- b1h_rel_volume > 1.57158085
- b1h_taker_delta_proxy <= 0.03576705

### Leaf 134: 195 training samples, expected 0.136 R
- stopFraction > 0.002
- stopFraction > 0.006
- s15_rsi_slope > 0.00152461
- s15_bb_width <= 0.01777016
- e5_close_pos <= 0.71428571
- e5_bb_width <= 0.01550493
- b1h_lower_wick <= 0.22580645

### Leaf 146: 125 training samples, expected 0.287 R
- stopFraction > 0.002
- stopFraction > 0.006
- s15_rsi_slope > 0.00152461
- s15_bb_width > 0.01777016
- b1h_trend_strength <= 0.17267824
- b1h_taker_buy_ratio <= 0.48097339
- b1h_body_range > 0.59534314

### Leaf 148: 112 training samples, expected 0.133 R
- stopFraction > 0.002
- stopFraction > 0.006
- s15_rsi_slope > 0.00152461
- s15_bb_width > 0.01777016
- b1h_trend_strength <= 0.17267824
- b1h_taker_buy_ratio > 0.48097339
- b1h_bb_width <= 0.02467729

## Limits of the evidence

- Reservoir-sampled opportunities, not a complete bar-by-bar consolidated portfolio replay; returns and drawdown are not deployable portfolio estimates.
- Source bot cooldowns suppressed some original opportunities; cross-bot consensus cannot be reconstructed reliably from these samples.
- Legacy and repeated validation runs are audited separately, never pooled into training.
- One open position globally is enforced in selection; missing unsampled signals can change that sequence.
- Bots 1/2 historical order book is a taker-volume proxy. Bot 8 requires genuine historical funding availability.
- Stored prices are rounded to two decimals, including zero for some cheap tokens; normalized labels and stop percentages are used instead.
- Confidence intervals cluster trades by UTC day, but remain approximate and do not correct every model-selection or serial-dependence effect.
- The final year is held out from this training procedure; earlier project work may already have inspected these historical outcomes.
- Initial depth-3-to-5 trees with 300-sample leaves admitted no trades. The search was expanded on training/validation to depth 5-7 with 100-sample leaves before any selected holdout trades were evaluated.
- No exchange execution or automatic funding is enabled by this model.
