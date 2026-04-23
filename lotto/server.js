'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('node:path');
const { generatePicksFromFile, generatePicksFromUrl } = require('./picker');

const app = express();
app.use(cors());
app.use(express.json());

const APP_TOKEN = process.env.APP_TOKEN || 'changeme';
const ANALYSIS_URL = process.env.LOTTO_ANALYSIS_URL || '';
const ANALYSIS_FILE = process.env.LOTTO_ANALYSIS_FILE
  ? path.resolve(process.cwd(), process.env.LOTTO_ANALYSIS_FILE)
  : path.join(__dirname, 'fl-lottery-analysis.json');
const DEFAULT_DASHBOARD = [
  { game: 'pick3', profile: 'blended', sets: 5 },
  { game: 'pick4', profile: '12m', sets: 6 },
  { game: 'pick5', profile: '5y', sets: 5 },
  { game: 'cashpop', profile: 'alltime', sets: 8 },
];

async function generatePicks(input, opts) {
  if (ANALYSIS_URL) return generatePicksFromUrl(ANALYSIS_URL, opts);
  return generatePicksFromFile(input, opts);
}

function auth(req, res, next) {
  const tok = req.headers['x-app-token'] || req.query.token;
  if (tok !== APP_TOKEN) return res.status(401).json({ error: 'Unauthorized — check your APP_TOKEN' });
  next();
}

app.get('/', (_req, res) => {
  res.json({ service: 'Florida Lottery Picker', ok: true });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()) });
});

app.get('/api/lottery/picks', auth, async (req, res) => {
  try {
    const game = String(req.query.game || 'pick3').toLowerCase();
    const profile = String(req.query.profile || 'blended').toLowerCase();
    const sets = Number.parseInt(req.query.sets, 10);
    const payload = await generatePicks(ANALYSIS_FILE, { game, profile, sets });
    res.json(payload);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/lottery/dashboard', auth, async (req, res) => {
  try {
    const dashboards = await Promise.all(
      DEFAULT_DASHBOARD.map(async (cfg) => {
        const payload = await generatePicks(ANALYSIS_FILE, cfg);
        return {
          key: `${cfg.game}-${cfg.profile}`,
          game: cfg.game,
          profile: cfg.profile,
          sets: cfg.sets,
          picks: payload.picks,
          topWeightedNumbers: payload.topWeightedNumbers,
          coverage: payload.coverage,
        };
      })
    );
    res.json({
      generatedAt: new Date().toISOString(),
      dashboard: dashboards,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🎯  Lotto app listening on port ${PORT}`);
});
