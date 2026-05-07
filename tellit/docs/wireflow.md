# Tellit Web MVP Wireflow (Jacksonville)

This wireflow is optimized for web-first usage on mobile browsers and desktop.

## 0) Entry

1. User lands on `/`
2. If not authenticated:
   - show map feed in read-only mode
   - CTA: `Sign in to report`
3. If authenticated:
   - map + report actions available

## 1) Main map screen (`/`)

Primary UI elements:

- Top bar: city selector (default Jacksonville), filter button, profile menu
- Map viewport: clustered active incidents
- Bottom sheet/list: nearest incidents sorted by recency + confirmations
- Floating action button: `Report Issue`

Tap on incident pin/list item opens report details drawer.

## 2) Report details drawer

Fields shown:

- Category + severity badge
- Description
- Reporter label (`Anonymous` or display name)
- Confirm count
- Time ago + expiry timer
- Optional photo preview

Actions:

- `Confirm report` / `Remove confirmation`
- `Share`
- `Flag` (spam/abuse)

## 3) Create report flow (`/report/new`)

Step A: location
- Auto GPS pin
- Drag pin to adjust
- Optional location note

Step B: issue details
- Category selector
- Severity selector
- Description text area
- Optional photo upload

Step C: privacy
- Toggle `Post anonymously`
- Inline note:
  - Public sees alias or anonymous
  - Tellit stores account linkage for moderation/legal requests

Step D: submit
- Confirmation screen with countdown to auto-expiry window
- Button: `View on map`

## 4) My reports (`/me/reports`)

Cards with:
- status (open/resolved/hidden/expired)
- created time
- confirmation count
- resolution note (if any)

Actions:
- Edit text while status is open
- Mark resolved (self)

## 5) Profile/settings (`/me`)

- Display name
- Optional profile photo
- Home city (default Jacksonville)
- Notification preferences
- Privacy text for anonymous posting

## 6) Moderator panel (`/admin`)

Access: moderator role only

Views:
- queue of flagged/recent reports
- duplicate candidates (same area + time + type)
- status action buttons: resolve/hide/reject/expire
- audit trail panel

## UX rules

- Reports default to **open** and auto-expire by issue type
- Optional photos only; no blocking upload failures from report submission
- Degrade gracefully on denied geolocation (manual pin still works)
- Keep report creation under 4 required inputs:
  - category
  - severity
  - description
  - location
