# Tellit Implementation Checklist (MVP)

## Phase 1 — Foundation

- [ ] Create Supabase project
- [ ] Run `docs/supabase/schema.sql`
- [ ] Enable storage bucket (`report-photos`, `profile-photos`)
- [ ] Configure auth providers (email magic link to start)
- [ ] Restrict Google Maps web API key by HTTP referrer

## Phase 2 — Backend API

- [ ] Scaffold Node/Express API service
- [ ] Implement JWT auth middleware (Supabase bearer token)
- [ ] Implement `GET /v1/reports`
- [ ] Implement `POST /v1/reports`
- [ ] Implement confirm/unconfirm endpoints
- [ ] Implement signed upload endpoint
- [ ] Implement moderator status endpoint
- [ ] Add rate limit for report creation + confirmations
- [ ] Add request logging (with redaction)

## Phase 3 — Web app

- [ ] Build map feed screen
- [ ] Build report details drawer
- [ ] Build create report multi-step modal
- [ ] Build my reports screen
- [ ] Build profile/settings screen
- [ ] Wire filters (type, severity, recency)
- [ ] Implement anonymous toggle UX text

## Phase 4 — Moderation + trust

- [ ] Add report flag endpoint + UI
- [ ] Add moderator web panel
- [ ] Add duplicate heuristics (geo + time + category)
- [ ] Add auto-expiry background task

## Phase 5 — Launch readiness

- [ ] Privacy policy page
- [ ] Terms / acceptable-use page
- [ ] Abuse/report escalation process documented
- [ ] CSV export endpoint for pilot stakeholders
- [ ] Basic analytics (reports/day, confirms/day, median time-to-resolve)

## “Done for MVP” criteria

- [ ] Users can report issues in Jacksonville from phone browser
- [ ] Public feed updates in near-real-time
- [ ] Confirmations influence issue confidence
- [ ] Moderators can suppress abuse quickly
- [ ] Incident records are anonymous publicly, attributable internally
