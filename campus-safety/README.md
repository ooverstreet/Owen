# Beacon — Campus Safety MVP

Single-campus pilot for **tip reporting**, **parent alerts**, and **authority heads-up**.

Beacon does **not** tap private cameras. It helps schools:

1. Collect safety tips quickly  
2. Triage with a human safety admin  
3. Send clear official alerts to parents/staff  
4. Give SROs / PD a one-click heads-up packet  

## Quick start

```bash
cd campus-safety
node server.mjs
```

Open [http://localhost:8787](http://localhost:8787)

All demo passwords: `demo1234`

| Role | Email | Purpose |
|---|---|---|
| Parent | `parent@demo.com` | See campus status + official alerts |
| Safety admin | `safety@lincoln-hs.demo` | Triage tips, send alerts, notify authorities |
| Authority liaison | `sro@citypd.demo` | Receive/ack heads-up |
| Staff | `teacher@lincoln-hs.demo` | Report tips + receive staff alerts |
| Student | `student@demo.com` | Report tips (optional anonymous) |

## Suggested demo path

1. Sign in as **student** → submit a “happening now” tip  
2. Sign in as **safety admin** → claim tip in Triage  
3. Send a **shelter-in-place** or **lockdown** alert to parents  
4. Use **Notify authorities** to send a heads-up  
5. Sign in as **parent** → see status + guidance  
6. Sign in as **SRO** → acknowledge the incident  

Use **Reset demo data** on the login screen anytime.

## API (local)

- `POST /api/login`
- `POST /api/tips`
- `GET /api/admin/tips`
- `POST /api/admin/alerts`
- `POST /api/admin/escalate`
- `GET /api/authority/incidents`
- `GET /api/campus/status`
- `GET /api/inbox` (simulated SMS/push/email deliveries)

Data is stored in `campus-safety/data/store.json` (created on first run).

## Privacy notes for pilots

- Parents see official status/alerts only — not the raw tip queue  
- Anonymous tips are supported for students/staff  
- Emergency UI always prioritizes **Call 911**  
- No continuous student tracking and no unauthorized camera access  
- Before a real school deployment: district legal review, FERPA/state privacy review, retention policy, and written authority partnerships  

## Stack

- Zero-dependency Node.js HTTP server (`server.mjs`)  
- JSON file database (`db.mjs`)  
- Single-page UI (`index.html`) for parent / staff / admin / authority roles  
