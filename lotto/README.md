# Lotto Service (Standalone)

This is a lightweight standalone backend for Florida Lottery picks and analysis output.

## Endpoints

- `GET /health`
- `GET /api/lottery/picks`
- `GET /api/lottery/dashboard`
- `GET /api/lottery/dashboard`

Auth is required on `/api/lottery/*`:

- Header: `x-app-token: YOUR_APP_TOKEN`
- or query string: `?token=YOUR_APP_TOKEN`

Examples:

```
/api/lottery/picks?token=YOUR_APP_TOKEN&game=pick3&profile=blended&sets=5
/api/lottery/dashboard?token=YOUR_APP_TOKEN
/api/lottery/dashboard?token=YOUR_APP_TOKEN&format=simple
/api/lottery/dashboard?token=YOUR_APP_TOKEN&format=text
```

Dashboard example (one-tap daily bundle):

```
/api/lottery/dashboard?token=YOUR_APP_TOKEN&sets=5
```

## Query parameters

- `game`: `pick2|pick3|pick4|pick5|cashpop`
- `profile`: `blended|alltime|5y|12m`
- `sets`: `1..20`

Dashboard-specific:

- `format`: `json|simple|text`
  - `json` = full raw response
  - `simple` = easier compact JSON
  - `text` = phone-friendly plain text summary

Dashboard query params:

- `sets`: `1..20` (default `5`)
- `pick3Profile`: profile for Pick 3 (default `blended`)
- `pick4Profile`: profile for Pick 4 (default `12m`)
- `pick5Profile`: profile for Pick 5 (default `5y`)
- `cashpopProfile`: profile for Cash Pop (default `alltime`)

## Environment variables

Required:

- `APP_TOKEN` - API auth token

Optional:

- `PORT` - service port (Railway provides this automatically)
- `LOTTO_ANALYSIS_FILE` - absolute/relative path to `fl-lottery-analysis.json`
  - defaults to `./data/fl-lottery-analysis.json` (inside `lotto/`)
- `LOTTO_ANALYSIS_URL` - URL to JSON (preferred in Railway if file not bundled)
  - defaults to this repo raw file on branch `cursor/exchange-and-bot-setup-3f7d`
  - if you want fully independent service data, set this to a file inside `lotto/data/`

## Railway setup (separate service)

1. Create a new Railway service from the same GitHub repo.
2. Set **Root Directory** to `lotto`.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add env var:
   - `APP_TOKEN=your_token`
6. (Recommended) Add:
   - `LOTTO_ANALYSIS_URL=https://raw.githubusercontent.com/ooverstreet/Owen/cursor/exchange-and-bot-setup-3f7d/backend/data/fl-lottery-analysis.json`
7. Generate domain (port `3000` if prompted).
8. Verify:
   - `/health`
   - `/api/lottery/picks?token=YOUR_APP_TOKEN&game=pick3&profile=blended&sets=5`
   - `/api/lottery/dashboard?token=YOUR_APP_TOKEN&sets=5`
