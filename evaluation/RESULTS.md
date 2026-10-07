# Recorded AI vs. deterministic baseline

Reproduce with `npm run evaluate`. No accounts, API calls, or network access are required.

This is **one synthetic scenario**, using a recorded real gpt-5.6-luna response from 2026-10-07T12:27:24.475Z. It is not a user study, forecast backtest, or proof that AI improves business outcomes. The response is replayed, not generated live by this command.

Both approaches receive identical stock, sales, lead times, budget and demand uplift. The baseline orders products by stock-cover minus supplier lead time. AI supplies its recorded ranking. Both use exactly the same round-robin budget allocator and trusted catalog prices.

Budget: $200.00. Full target: $771.00.

| Product | AI quantity | Baseline quantity | Forecast target |
| --- | ---: | ---: | ---: |
| Barista oat milk | 10 | 9 | 95 |
| House blend beans | 9 | 10 | 48 |
| Ceremonial matcha | 9 | 9 | 19 |
| Compostable cups | 10 | 9 | 15 |
| Vanilla syrup | 0 | 0 | 0 |
| Drinking chocolate | 0 | 0 | 0 |

AI spend: **$200.00**. Baseline spend: **$200.00**. Products with different quantities: **3 of 6**.

## Interpretation

Ranking changes some quantities, but a difference is not evidence of a better purchasing outcome. The model adds natural-language explanations and considers owner context; their usefulness still needs user evaluation. Round-robin allocation limits how much ranking can change quantities. No savings, stockout reduction, or revenue uplift has been measured.

The model caution also suggests the supplied stock cover may not include demand uplift, although the server already applies it. Treat model explanations as fallible; numeric budget and purchase constraints are enforced independently.

## Next evaluation

Use held-out daily sales and real supplier lead times, compare against a simple reorder policy, and measure unmet demand, inventory cost and review time. Predefine scenarios and metrics; include unfavorable results. Have café operators judge whether the explanations change a useful decision. Obtain permission before publishing any participant data.
