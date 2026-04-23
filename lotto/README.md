# Lotto Service (Standalone)

This is a lightweight standalone backend for Florida Lottery picks and analysis output.

## Endpoints

- `GET /health`
- `GET /api/lottery/picks`

Auth is required on `/api/lottery/*`:

- Header: `x-app-token: YOUR_APP_TOKEN`
- or query string: `?token=YOUR_APP_TOKEN`

Example:

```
/api/lottery/picks?token=YOUR_APP_TOKEN&game=pick3&profile=blended&sets=5
```

## Query parameters

- `game`: `pick2|pick3|pick4|pick5|cashpop`
- `profile`: `blended|alltime|5y|12m`
- `sets`: `1..20`

## Environment variables

Required:

- `APP_TOKEN` - API auth token

Optional:

- `PORT` - service port (Railway provides this automatically)
- `LOTTO_ANALYSIS_FILE` - absolute/relative path to `fl-lottery-analysis.json`
  - defaults to `../backend/data/fl-lottery-analysis.json`
  - if you want fully independent service data, set this to a file inside `lotto/data/`

## Railway setup (separate service)

1. Create a new Railway service from the same GitHub repo.
2. Set **Root Directory** to `lotto`.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add env var:
   - `APP_TOKEN=your_token`
6. Generate domain (port `3000` if prompted).
7. Verify:
   - `/health`
   - `/api/lottery/picks?token=YOUR_APP_TOKEN&game=pick3&profile=blended&sets=5`
