# Tellit (Jacksonville MVP)

Tellit is a web-first traffic issue reporting app for Jacksonville, FL.

Users can quickly report road/traffic problems, view nearby issues, and confirm reports from other locals. Reports can be posted anonymously to the public while still retaining internal user linkage for moderation/legal workflows.

## Product goals (MVP)

- Fast reporting (`< 20s`) for incidents on the road
- Public map feed of active nearby reports
- Trust signals via confirmations from other users
- Spam/abuse controls and moderator tooling
- Data export path for local authority pilots

## MVP scope

### Included

- Anonymous-or-named report posting
- Optional report photo upload
- Category + severity + location + timestamps
- Nearby map feed and list feed
- Confirm/upvote report
- Auto-expiry by incident type
- Moderator resolve/hide actions

### Deferred

- Native Android app (planned after web launch)
- Authority integrations (311/DOT APIs)
- Advanced ML duplicate detection
- Route-aware push notifications

## Stack

- Frontend: React (web/PWA)
- Backend: Node.js + Express (or Supabase Edge Functions)
- Database/Auth/Storage: Supabase
- Maps: Google Maps JavaScript API
- Hosting: Railway (API), Vercel/Netlify (web)

## Required accounts and keys

1. Supabase project (auth + postgres + storage)
2. Google Maps API key (restricted by referrer/API)
3. Hosting targets (Railway + Vercel/Netlify)

> Security note: never commit raw API keys. Use environment variables only.

## Files in this starter pack

- `docs/supabase/schema.sql` — tables, RLS policies, view, helper functions
- `docs/api/openapi.yaml` — API contract for web + mobile clients
- `docs/wireflow.md` — screen-by-screen UX flow
- `docs/implementation-checklist.md` — phased build checklist

## Environment variables (suggested)

### Frontend

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_GOOGLE_MAPS_API_KEY`
- `VITE_DEFAULT_CITY=Jacksonville,FL`

### Backend

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_JWT_SECRET` (if validating JWT server-side)
- `GOOGLE_MAPS_API_KEY_SERVER` (separate restricted server key)
- `APP_ENV=development|staging|production`

## Next implementation step

Use `docs/supabase/schema.sql` to initialize database objects, then scaffold endpoints from `docs/api/openapi.yaml`.
