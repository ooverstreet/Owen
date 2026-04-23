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

function formatPick(game, numbers) {
  if (!Array.isArray(numbers)) return '';
  if (game === 'cashpop') return String(numbers[0] ?? '');
  return numbers.map((n) => String(n)).join('');
}

function buildPrettyDashboard(dashboards) {
  return dashboards.map((row) => ({
    game: row.game,
    profile: row.profile,
    sets: row.sets,
    picks: row.picks.map((p) => formatPick(row.game, p)),
    topNumbers: row.topWeightedNumbers.slice(0, 5).map((n) => n.value),
    coverage: row.coverage,
  }));
}

function buildTextDashboard(dashboards) {
  const lines = [];
  lines.push(`Lottery dashboard @ ${new Date().toISOString()}`);
  lines.push('');
  for (const row of dashboards) {
    lines.push(`${row.game.toUpperCase()}  (${row.profile}, sets=${row.sets})`);
    lines.push(`Picks: ${row.picks.map((p) => formatPick(row.game, p)).join(', ')}`);
    lines.push(`Top numbers: ${row.topWeightedNumbers.slice(0, 5).map((n) => n.value).join(', ')}`);
    lines.push(`Coverage: ${row.coverage.from} -> ${row.coverage.to}`);
    lines.push('');
  }
  return lines.join('\n');
}

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
    const format = String(req.query.format || 'json').toLowerCase();
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
    if (format === 'pretty') {
      return res.json({
        generatedAt: new Date().toISOString(),
        dashboard: buildPrettyDashboard(dashboards),
      });
    }
    if (format === 'text') {
      return res.type('text/plain').send(buildTextDashboard(dashboards));
    }
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
