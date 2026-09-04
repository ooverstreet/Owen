#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const WINDOW_KEYS = ['allTime', 'last5Years', 'last12Months'];
const WEIGHT_PROFILES = {
  alltime: { allTime: 1, last5Years: 0, last12Months: 0 },
  '5y': { allTime: 0, last5Years: 1, last12Months: 0 },
  '12m': { allTime: 0, last5Years: 0, last12Months: 1 },
  blended: { allTime: 0.2, last5Years: 0.35, last12Months: 0.45 },
};

function parseArgs(argv) {
  const out = {
    input: 'data/fl-lottery-analysis.json',
    game: 'pick3',
    profile: 'blended',
    sets: 5,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input' && argv[i + 1]) {
      out.input = argv[i + 1];
      i += 1;
    } else if (arg === '--game' && argv[i + 1]) {
      out.game = argv[i + 1].trim().toLowerCase();
      i += 1;
    } else if (arg === '--profile' && argv[i + 1]) {
      out.profile = argv[i + 1].trim().toLowerCase();
      i += 1;
    } else if (arg === '--sets' && argv[i + 1]) {
      out.sets = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    } else {
      printHelpAndExit(1, `Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(out.sets) || out.sets <= 0) out.sets = 5;
  out.sets = Math.min(Math.max(out.sets, 1), 20);
  return out;
}

function printHelpAndExit(code, msg) {
  if (msg) console.error(msg);
  console.log(
    'Usage: node scripts/fl-lottery-picker.js [--input data/fl-lottery-analysis.json] [--game pick3] [--profile blended|alltime|5y|12m] [--sets 5]'
  );
  process.exit(code);
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeDistribution(obj) {
  const entries = Object.entries(obj)
    .map(([k, v]) => ({ value: toInt(k), weight: Number(v) || 0 }))
    .filter((r) => Number.isInteger(r.value) && r.weight > 0);
  const total = entries.reduce((acc, r) => acc + r.weight, 0);
  if (total <= 0) return [];
  return entries.map((r) => ({ value: r.value, weight: r.weight / total }));
}

function mergeDistributions(weighted) {
  const acc = {};
  for (const { distribution, factor } of weighted) {
    if (!distribution || factor <= 0) continue;
    for (const row of distribution) {
      acc[row.value] = (acc[row.value] || 0) + row.weight * factor;
    }
  }
  return normalizeDistribution(acc);
}

function fallbackUniformDistribution(gameCode) {
  if (gameCode === 'cashpop') {
    const out = {};
    for (let i = 1; i <= 15; i += 1) out[i] = 1;
    return normalizeDistribution(out);
  }
  const out = {};
  for (let i = 0; i <= 9; i += 1) out[i] = 1;
  return normalizeDistribution(out);
}

function sampleOne(distribution, used) {
  const filtered = distribution.filter((d) => !used.has(d.value));
  const total = filtered.reduce((acc, d) => acc + d.weight, 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const row of filtered) {
    r -= row.weight;
    if (r <= 0) return row.value;
  }
  return filtered[filtered.length - 1].value;
}

function makeSets(gameEntry, profile, setsCount) {
  const weights = WEIGHT_PROFILES[profile];
  if (!weights) throw new Error(`Unknown profile "${profile}". Use blended|alltime|5y|12m.`);

  const windows = gameEntry.windows || {};
  const mainCount = Number(gameEntry.mainCount || gameEntry?.meta?.mainCount || 0) || null;
  const inferredMainCount =
    mainCount ||
    (gameEntry.game === 'pick2'
      ? 2
      : gameEntry.game === 'pick3'
      ? 3
      : gameEntry.game === 'pick4'
      ? 4
      : gameEntry.game === 'pick5'
      ? 5
      : 1);

  const positionMerged = [];
  for (let i = 0; i < inferredMainCount; i += 1) {
    const weighted = [];
    for (const wk of WINDOW_KEYS) {
      const w = weights[wk] || 0;
      const posObj = windows[wk]?.positionFrequency?.[i];
      if (!posObj) continue;
      weighted.push({ distribution: normalizeDistribution(posObj), factor: w });
    }
    positionMerged.push(mergeDistributions(weighted));
  }

  const numberMerged = mergeDistributions(
    WINDOW_KEYS.map((wk) => ({
      distribution: normalizeDistribution(windows[wk]?.numberFrequency || {}),
      factor: weights[wk] || 0,
    }))
  );
  const fallbackBase = fallbackUniformDistribution(gameEntry.game);
  const baseNumbers = numberMerged.length ? numberMerged : fallbackBase;

  const picks = [];
  for (let s = 0; s < setsCount; s += 1) {
    const used = new Set();
    const numbers = [];
    for (let i = 0; i < inferredMainCount; i += 1) {
      const candidate = sampleOne(positionMerged[i].length ? positionMerged[i] : baseNumbers, used);
      if (candidate === null) break;
      numbers.push(candidate);
      if (gameEntry.game === 'cashpop') used.add(candidate);
    }
    if (numbers.length < inferredMainCount) {
      while (numbers.length < inferredMainCount) {
        const candidate = sampleOne(baseNumbers, used);
        if (candidate === null) break;
        numbers.push(candidate);
        if (gameEntry.game === 'cashpop') used.add(candidate);
      }
    }
    if (numbers.length === inferredMainCount) picks.push(numbers);
  }

  return {
    profile,
    weights,
    game: gameEntry.game,
    name: gameEntry.name,
    coverage: gameEntry.coverage,
    picks,
    topWeightedNumbers: baseNumbers
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 10)
      .map((r) => ({ value: r.value, score: Number(r.weight.toFixed(6)) })),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const inputPath = path.isAbsolute(args.input) ? args.input : path.resolve(process.cwd(), args.input);
  const raw = await fs.readFile(inputPath, 'utf8');
  const analysis = JSON.parse(raw);
  const gameEntry = (analysis.games || []).find((g) => String(g.game).toLowerCase() === args.game);
  if (!gameEntry) {
    const known = (analysis.games || []).map((g) => g.game).join(', ');
    throw new Error(`Game "${args.game}" not found. Available: ${known}`);
  }

  const result = makeSets(gameEntry, args.profile, args.sets);
  console.log(JSON.stringify(result, null, 2));
}

async function generatePicksFromFile(inputPath, options = {}) {
  const absInput = path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
  const raw = await fs.readFile(absInput, 'utf8');
  const analysis = JSON.parse(raw);
  const game = String(options.game || 'pick3').toLowerCase();
  const profile = String(options.profile || 'blended').toLowerCase();
  const setsNum = Number.parseInt(options.sets, 10);
  const sets = Number.isFinite(setsNum) ? Math.min(Math.max(setsNum, 1), 20) : 5;
  const gameEntry = (analysis.games || []).find((g) => String(g.game).toLowerCase() === game);
  if (!gameEntry) {
    const known = (analysis.games || []).map((g) => g.game).join(', ');
    throw new Error(`Game "${game}" not found. Available: ${known}`);
  }
  return makeSets(gameEntry, profile, sets);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  });
}

module.exports = {
  generatePicksFromFile,
};

