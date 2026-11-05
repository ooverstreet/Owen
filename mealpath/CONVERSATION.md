# Mealpath — conversation save (2026-07-25)

Saved for Owen so we don’t lose the decisions from this thread.

## People
- Owen (user)
- Chief (assistant)

## Where we came from
- Crypto paper bot was the focus earlier (Railway: `https://owen-production-f9ff.up.railway.app`, token `Owen_Bot`).
- There was a strong paper stretch (~49 trades, ~+$7 realized, high win rate), then resets, stricter guards, realistic fees, long-only + profit-only exits, and capital getting stuck in red bags.
- Goal of easy **$5/day** (and friends’ claims of **$50/day**) was honest-checked: not easy on ~$1000 with fees; markets ≠ “smarter bot = free money.”
- Owen was disappointed but open to pivoting to something that helps people and can sustain itself without months of no-profit testing.

## Decision: park the trading bot as the money plan
- Bot software was **not** a failed build; the failed expectation was easy daily market profit.
- Crypto paper trading left **paused** (`tradingEnabled: false`) so focus can move.
- Do not keep grinding months of crypto tuning as the primary plan.

## Decision: no charity crypto coin (for now)
- New “charity coins” have terrible trust, legal fog, and often don’t move real help.
- Software + transparent giving is the starting point — not a token.

## Decision: hunger first → Mealpath
- Priority cause: **hunger** (oceans / deforestation / shark-fin can come later under the same honesty rules).
- Product name: **Mealpath**
- Tagline direction: hunger help you can follow.
- Start local: **Jacksonville / North Florida**
- Model: people pay / donate through clear rails later; until then, deep-link to real nonprofits so help isn’t blocked on us.

### Money split (when on-platform giving is live)
- **80%** verified hunger-relief partners
- **15%** ops & product (sustainable growth)
- **5%** reserve

### Honesty rule
- Public ledger stays at **$0** until the first real dollar moves through Mealpath.
- Direct gifts on partner sites still help today.

### v1 partner / help links
- Second Harvest North Florida / We Nourish Hope — https://www.wenourishhope.org — (904) 353-3663
- Feeding Northeast Florida — https://www.feedingnefl.org
- Need food: dial **211** / https://www.nefl211.org

## What was built
- Repo folder: `mealpath/`
- `mealpath/index.html` — landing, split, Jax actions, 211 help, ledger placeholder
- `mealpath/README.md` — run notes + short partner outreach script
- Branch: `cursor/nourish-hunger-app-6cbb`
- PR: https://github.com/ooverstreet/Owen/pull/80

## Next steps (when Owen is ready)
1. Deploy Mealpath (static host or Railway)
2. One partner call using the README script (list + link accuracy — not asking for funding yet)
3. Add Stripe/PayPal → auto ledger entries
4. Optional sponsor tier for local businesses
5. Later: oceans / forests as separate paths, same transparency

## Tone / working agreement to keep
- Be direct; prefer real help over hype
- Prefer products where a person pays or a verified org receives money
- Don’t pretend impact; show the trail
