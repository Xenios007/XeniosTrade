# AI Trading — cost per complete trade (notes, 2026-09-20)

Notes only. Nothing in the app reads this file. Re-check prices before relying on them.

## How it was measured

- Ran the real pipeline (`runAiTradingPipeline`) with a stub model and synthetic candles (120 x 1h/15m/5m, same shape as live) and captured the five prompts (measured before the Decision Agent was retired on 2026-09-20; see the Position Manager note below). No model was called and no keys were used.
- Prompt characters per stage (system + user): Analyst 2,988 · Market Flow 2,194 · Critic 3,488 · Risk Manager 4,279 · Decision 1,615 (retired) = 14,564 chars. Entry is now the first four only (12,949 chars, about 11% less); the Risk Manager prompt is slightly longer now that it also asks for a confidence.
- Tokens are **estimated at 3.6 chars/token**: ~4,046 input tokens and ~321 visible output tokens per complete trade (all five stages run, trade approved: the old five-stage figure; entry is now four calls). Real counts can differ by roughly ±20%, and more on Claude Opus (its tokenizer uses more tokens).
- Prices: Claude API reference (cached 2026-06-24) and OpenRouter's public catalog (`https://openrouter.ai/api/v1/models`, fetched 2026-09-20). The Claude prices matched in both.

## Cost of one complete trade (table below is the OLD 5-call figure; entry is now 4 calls, so it is an upper bound)

| Model | $ per 1M in / out | No hidden thinking | With ~1,000 thinking tokens per stage |
|---|---|---|---|
| Claude Opus 5 | 5 / 25 | $0.028 | $0.153 |
| Claude Sonnet 5 | 2 / 10 | $0.011 | $0.061 |
| Claude Haiku 4.5 | 1 / 5 | $0.006 | n/a (no thinking unless asked) |
| GPT-5.5 | 5 / 30 | $0.030 | $0.180 |
| GPT-5.4 | 2.5 / 15 | $0.015 | $0.090 |
| GPT-5.4 mini | 0.75 / 4.5 | $0.0045 | $0.027 |
| GPT-5.4 nano | 0.20 / 1.25 | $0.0012 | $0.008 |
| GPT-4.1 | 2 / 8 | $0.011 | n/a |
| GPT-4o | 2.5 / 10 | $0.013 | n/a |
| GPT-4o mini | 0.15 / 0.60 | $0.0008 | n/a |
| o4-mini | 1.1 / 4.4 | $0.006 | $0.028 |
| Gemini 3.5 Flash (current default for Flow/Critic/Risk/Decision) | 1.5 / 9 | $0.009 | $0.054 |
| Gemini 3.5 Flash-Lite | 0.3 / 2.5 | $0.002 | $0.015 |
| Gemini 3.1 Flash-Lite | 0.25 / 1.5 | $0.0015 | $0.009 |
| Gemini 2.5 Flash | 0.3 / 2.5 | $0.002 | $0.015 |
| Gemini 2.5 Pro | 1.25 / 10 | $0.008 | $0.058 |
| Grok 4.3 | 1.25 / 2.5 | $0.006 | $0.018 |
| Nemotron 550B (paid) | 0.6 / 2.4 | $0.003 | $0.015 |
| Nemotron 550B `:free` (current Analyst) | 0 / 0 | $0 | $0 |

The thinking column is an **assumption** (1,000 hidden tokens per stage); real thinking varies a lot by model.

## Things to remember

- `callAnthropic` in `server/ai-trading/llm.js` sets no `thinking`. Claude Opus 5 and Sonnet 5 run adaptive thinking when it is omitted, and thinking tokens bill as output, so use the right-hand column for them. Haiku 4.5 does not think unless asked.
- Worst case per trade: each call may output up to 4,096 tokens (`MAX_OUTPUT_TOKENS`), i.e. ~20,480 output tokens for five calls: ~$0.53 on Opus 5, ~$0.63 on GPT-5.5, ~$0.11 on Haiku 4.5.
- Auto-scan cost is dominated by Analyst-only runs (one call, ~830 in / ~100 out tokens). 3 symbols every 5 min for 24 h = ~864 such calls: ~$0.16 GPT-4o mini, ~$0.31 Gemini 3.1 Flash-Lite, ~$1.15 Haiku 4.5, ~$5.77 Opus 5, if none went past the Analyst. Later stages only run when the Analyst says LONG/SHORT.
- The five AI roles can use different models. Idea: a cheap fast model for the Analyst (the only stage called on every scan), a stronger one for the Risk Manager (rare, and it sets stop/size/leverage and the entry confidence).
- **Position Manager (added 2026-09-20):** one call per open trade every 5 minutes (12 an hour per open trade, at most 5 open on testnet, 1 real). Its prompt is much larger than the retired Decision prompt: measured with a test fixture, about 10,000 chars (~2,800 tokens) for the first review and about 15,000 chars (~4,200 tokens) once six previous reviews are included, plus a few hundred output tokens; real prompts carry the full flow data and run a little larger. So a trade held for an hour costs roughly 12 x ~3,500 = ~42,000 input tokens on the Position Manager's model, more than the whole entry pipeline. On a login provider (Claude/Codex) this counts against the plan's limits, not a per-token bill.
- The Analyst's 45 s timeout (`DEFAULT_LLM_TIMEOUT_MS`) rules out slow models: the free Nemotron 550B took 43.9 s and then timed out.

## Current goal (owner, 2026-09-20)

Before any tuning or model changes for cost: **get one successful AI trade** (testnet) and check how effective the pipeline is. Every real run so far was HOLD, so a full model-originated LONG/SHORT through all five real stages has never been seen. Cost optimisation comes after that.
