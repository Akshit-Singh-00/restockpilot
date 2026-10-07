import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { inventoryInput, forecast, allocate, sampleAdvice, validateAdvice, settingsInput, money } from '../lib/domain.mjs';

const fixture = JSON.parse(await readFile(new URL('../evaluation/recorded-ai-plan.json', import.meta.url), 'utf8'));
const settings = settingsInput(fixture.settings);
const signals = forecast(inventoryInput(fixture.inventory), settings);
const ai = allocate(signals, validateAdvice(fixture.advice), settings.budget);
const baseline = allocate(signals, sampleAdvice(signals), settings.budget);
const cost = rows => rows.reduce((sum, row) => sum + row.quantity * row.price, 0);
const differences = signals.filter(s => ai.find(r => r.sku === s.sku).quantity !== baseline.find(r => r.sku === s.sku).quantity).length;
const report = `# Recorded AI vs. deterministic baseline

Reproduce with \`npm run evaluate\`. No accounts, API calls, or network access are required.

This is **one synthetic scenario**, using a recorded real ${fixture.model} response from ${fixture.generatedAt}. It is not a user study, forecast backtest, or proof that AI improves business outcomes. The response is replayed, not generated live by this command.

Both approaches receive identical stock, sales, lead times, budget and demand uplift. The baseline orders products by stock-cover minus supplier lead time. AI supplies its recorded ranking. Both use exactly the same round-robin budget allocator and trusted catalog prices.

Budget: $${money(settings.budget)}. Full target: $${money(signals.reduce((s,r)=>s+r.needed*r.price,0))}.

| Product | AI quantity | Baseline quantity | Forecast target |
| --- | ---: | ---: | ---: |
${signals.map(s => `| ${s.name} | ${ai.find(r=>r.sku===s.sku).quantity} | ${baseline.find(r=>r.sku===s.sku).quantity} | ${s.needed} |`).join('\n')}

AI spend: **$${money(cost(ai))}**. Baseline spend: **$${money(cost(baseline))}**. Products with different quantities: **${differences} of ${signals.length}**.

## Interpretation

${differences === 0 ? 'The allocations are identical. This example does not establish a purchasing advantage from AI.' : 'Ranking changes some quantities, but a difference is not evidence of a better purchasing outcome.'} The model adds natural-language explanations and considers owner context; their usefulness still needs user evaluation. Round-robin allocation limits how much ranking can change quantities. No savings, stockout reduction, or revenue uplift has been measured.

The model caution also suggests the supplied stock cover may not include demand uplift, although the server already applies it. Treat model explanations as fallible; numeric budget and purchase constraints are enforced independently.

## Next evaluation

Use held-out daily sales and real supplier lead times, compare against a simple reorder policy, and measure unmet demand, inventory cost and review time. Predefine scenarios and metrics; include unfavorable results. Have café operators judge whether the explanations change a useful decision. Obtain permission before publishing any participant data.
`;
const output = new URL('../evaluation/RESULTS.md', import.meta.url);
await writeFile(output, report);
console.log(report);
console.log(`Saved ${fileURLToPath(output)}`);
