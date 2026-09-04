# Tellit API (Runnable Backend)

Express + Supabase backend for Tellit.

## Endpoints

- `GET /health`
- `GET /v1/reports` (public feed)
- `GET /v1/reports/:reportId` (public report detail)
- `POST /v1/reports` (auth required)
- `POST /v1/reports/:reportId/confirm` (auth required)
- `DELETE /v1/reports/:reportId/confirm` (auth required)
- `GET /v1/me/reports` (auth required)
- `POST /v1/reports/:reportId/resolve` (moderator only)
- `POST /v1/uploads/report-photo-url` (auth required)

## Auth

Use Supabase access token in Authorization header:

`Authorization: Bearer <access_token>`

## Required env vars

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional:

- `PORT` (defaults to 3000)
- `REPORT_PHOTOS_BUCKET` (defaults to `report-photos`)

## Local run

```bash
npm install
npm start
```

## Railway deploy

1. Create new service from GitHub repository
2. Branch: `cursor/exchange-and-bot-setup-3f7d` (or `main` after merge)
3. Root Directory: `tellit-api`
4. Build command: `npm install`
5. Start command: `npm start`
6. Add env vars above
