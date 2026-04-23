#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const GAME_DEFS = {
  pick2: {
    code: 'pick2',
    name: 'Pick 2',
    url: 'https://files.floridalottery.com/exptkt/p2.pdf',
    kind: 'pick',
    mainCount: 2,
    domain: [...Array(10)].map((_, i) => i),
  },
  pick3: {
    code: 'pick3',
    name: 'Pick 3',
    url: 'https://files.floridalottery.com/exptkt/p3.pdf',
    kind: 'pick',
    mainCount: 3,
    domain: [...Array(10)].map((_, i) => i),
  },
  pick4: {
    code: 'pick4',
    name: 'Pick 4',
    url: 'https://files.floridalottery.com/exptkt/p4.pdf',
    kind: 'pick',
    mainCount: 4,
    domain: [...Array(10)].map((_, i) => i),
  },
  pick5: {
    code: 'pick5',
    name: 'Pick 5',
    url: 'https://files.floridalottery.com/exptkt/p5.pdf',
    kind: 'pick',
    mainCount: 5,
    domain: [...Array(10)].map((_, i) => i),
  },
  cashpop: {
    code: 'cashpop',
    name: 'Cash Pop',
    url: 'https://files.floridalottery.com/exptkt/cp.pdf',
    kind: 'cash-pop',
    mainCount: 1,
    domain: [...Array(15)].map((_, i) => i + 1),
  },
};

const DEFAULT_GAMES = ['pick2', 'pick3', 'pick4', 'pick5', 'cashpop'];
const PICK_DATE_RE = /^\d{2}\/\d{2}\/\d{2}$/;

function parseArgs(argv) {
  const out = {
    games: [...DEFAULT_GAMES],
    output: null,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--games' && argv[i + 1]) {
      out.games = argv[i + 1]
        .split(',')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
    } else if (arg === '--output' && argv[i + 1]) {
      out.output = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit(0);
    } else {
      printHelpAndExit(1, `Unknown argument: ${arg}`);
    }
  }
  return out;
}

function printHelpAndExit(code, msg) {
  if (msg) console.error(msg);
  console.log('Usage: node scripts/fl-lottery-analyzer.js [--games pick3,pick4] [--output path]');
  console.log(`Known games: ${Object.keys(GAME_DEFS).join(', ')}`);
  process.exit(code);
}

function parseDateToken(token) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(token);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) {
    const nowYY = new Date().getUTCFullYear() % 100;
    year = year <= nowYY + 1 ? 2000 + year : 1900 + year;
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function normalizePickDate(d) {
  const year = d.getUTCFullYear();
  if (year >= 2090) {
    return new Date(Date.UTC(year - 100, d.getUTCMonth(), d.getUTCDate()));
  }
  return d;
}

function topEntries(mapObj, limit = 10, direction = 'desc') {
  const rows = Object.entries(mapObj);
  rows.sort((a, b) => {
    if (direction === 'asc') return a[1] - b[1] || Number(a[0]) - Number(b[0]);
    return b[1] - a[1] || Number(a[0]) - Number(b[0]);
  });
  return rows.slice(0, limit).map(([value, count]) => ({ value, count }));
}

function addCount(target, key, inc = 1) {
  target[key] = (target[key] || 0) + inc;
}

function rangeDomainFrequency(domain, freq) {
  const out = {};
  for (const v of domain) out[v] = freq[v] || 0;
  return out;
}

function setToKey(values) {
  return [...new Set(values.filter(Boolean))].sort().join(',');
}

function sortedUniqueStrings(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function dateMinusYears(anchor, years) {
  return new Date(Date.UTC(anchor.getUTCFullYear() - years, anchor.getUTCMonth(), anchor.getUTCDate()));
}

function dateMinusMonths(anchor, months) {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const d = anchor.getUTCDate();
  return new Date(Date.UTC(y, m - months, d));
}

function filterByDate(draws, fromDate) {
  const t = fromDate.getTime();
  return draws.filter((d) => d.dateObj.getTime() >= t);
}

function calcRepeatRate(draws) {
  if (draws.length < 2) return null;
  let repeatAny = 0;
  for (let i = 1; i < draws.length; i += 1) {
    const prev = new Set(draws[i - 1].numbers);
    const curr = draws[i].numbers;
    if (curr.some((n) => prev.has(n))) repeatAny += 1;
  }
  return Number(((repeatAny / (draws.length - 1)) * 100).toFixed(2));
}

function calcWindowStats(draws, game) {
  if (!draws.length) {
    return {
      count: 0,
      from: null,
      to: null,
      uniqueDates: 0,
      avgDrawsPerDate: 0,
      repeatFromPriorPct: null,
      topNumbers: [],
      coldNumbers: [],
      topCombos: [],
      topSums: [],
      positionFrequencies: [],
    };
  }

  const numberFreq = {};
  const comboFreq = {};
  const sumFreq = {};
  const dates = new Set();
  const drawTypeFreq = {};

  const positionFreq = [...Array(game.mainCount)].map(() => ({}));

  for (const d of draws) {
    dates.add(d.date);
    addCount(comboFreq, d.comboKey);
    addCount(sumFreq, d.numbers.reduce((acc, v) => acc + v, 0));
    addCount(drawTypeFreq, d.drawType || 'UNSPECIFIED');
    d.numbers.forEach((n, idx) => {
      addCount(numberFreq, n);
      addCount(positionFreq[idx], n);
    });
  }

  const withDomain = rangeDomainFrequency(game.domain, numberFreq);
  const uniqueDates = dates.size;

  return {
    count: draws.length,
    from: draws[0].date,
    to: draws[draws.length - 1].date,
    uniqueDates,
    avgDrawsPerDate: Number((draws.length / Math.max(uniqueDates, 1)).toFixed(3)),
    repeatFromPriorPct: calcRepeatRate(draws),
    numberFrequency: withDomain,
    topNumbers: topEntries(withDomain, 10, 'desc'),
    coldNumbers: topEntries(withDomain, 10, 'asc'),
    topCombos: topEntries(comboFreq, 10, 'desc'),
    topSums: topEntries(sumFreq, 10, 'desc'),
    drawTypeDistribution: topEntries(drawTypeFreq, 10, 'desc'),
    positionFrequency: positionFreq.map((pf) => rangeDomainFrequency(game.domain, pf)),
    positionFrequencies: positionFreq.map((pf) => topEntries(rangeDomainFrequency(game.domain, pf), 10, 'desc')),
  };
}

function detectFormatTransitions(draws) {
  if (draws.length < 1200) return [];
  const transitions = [];
  const window = Math.min(500, Math.max(180, Math.floor(draws.length / 12)));
  const step = 25;

  const isExtra = (d) => d.extraNumbers.length > 0 || d.bonusTags.length > 0;

  for (let i = window; i < draws.length - window; i += step) {
    const before = draws.slice(i - window, i);
    const after = draws.slice(i, i + window);

    const beforeExtra = before.filter(isExtra).length / before.length;
    const afterExtra = after.filter(isExtra).length / after.length;
    const beforeLabels = setToKey(before.map((d) => d.drawType || ''));
    const afterLabels = setToKey(after.map((d) => d.drawType || ''));

    const extraFlip = Math.abs(beforeExtra - afterExtra) >= 0.7;
    const labelsFlip = beforeLabels !== afterLabels;
    if (!extraFlip && !labelsFlip) continue;

    const date = draws[i].date;
    const reason = [];
    if (extraFlip) reason.push(`bonus-rate ${beforeExtra.toFixed(2)} -> ${afterExtra.toFixed(2)}`);
    if (labelsFlip) reason.push(`draw-labels ${beforeLabels || 'none'} -> ${afterLabels || 'none'}`);
    transitions.push({
      date,
      reason: reason.join('; '),
    });
  }

  const dedup = [];
  for (const t of transitions) {
    const prev = dedup[dedup.length - 1];
    if (!prev) {
      dedup.push(t);
      continue;
    }
    const prevTime = new Date(`${prev.date}T00:00:00Z`).getTime();
    const currTime = new Date(`${t.date}T00:00:00Z`).getTime();
    const dayDiff = Math.abs(currTime - prevTime) / (1000 * 60 * 60 * 24);
    if (dayDiff < 120) continue;
    dedup.push(t);
  }
  return dedup;
}

function buildFormatSegments(draws, transitions) {
  if (!draws.length) return [];
  const bounds = [draws[0].date, ...transitions.map((t) => t.date), draws[draws.length - 1].date];
  const segments = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const from = bounds[i];
    const to = bounds[i + 1];
    const inclusiveTo = i === bounds.length - 2;
    const segDraws = draws.filter((d) => {
      if (inclusiveTo) return d.date >= from && d.date <= to;
      return d.date >= from && d.date < to;
    });
    segments.push({
      segment: `segment-${i + 1}`,
      from,
      to,
      inclusiveTo,
      count: segDraws.length,
    });
  }
  return segments;
}

async function loadPdfDoc(url) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const data = await res.arrayBuffer();
  const fontDir = path.resolve(__dirname, '..', 'node_modules', 'pdfjs-dist', 'standard_fonts');
  const standardFontDataUrl = `${fontDir}${path.sep}`;
  const task = pdfjs.getDocument({ data, standardFontDataUrl });
  const doc = await task.promise;
  return doc;
}

function clusterDateColumns(dateItems) {
  const sortedX = [...dateItems.map((d) => d.x)].sort((a, b) => a - b);
  const centers = [];
  for (const x of sortedX) {
    const last = centers[centers.length - 1];
    if (!last || Math.abs(last - x) > 24) centers.push(x);
  }
  return centers;
}

function parsePickRow(rowItems, game) {
  const drawTypeToken = rowItems.find((it) => /^[A-Z]$/.test(it.str));
  const drawType = drawTypeToken ? drawTypeToken.str : null;
  const numericTokens = rowItems.filter((it) => /^\d{1,2}$/.test(it.str)).map((it) => Number(it.str));
  if (numericTokens.length < game.mainCount) return null;

  const numbers = numericTokens.slice(0, game.mainCount);
  const extraNumbers = numericTokens.slice(game.mainCount);
  const bonusTags = rowItems
    .map((it) => it.str)
    .filter((s) => /^[A-Z]{2,}$/.test(s));

  return {
    drawType,
    numbers,
    extraNumbers,
    bonusTags,
  };
}

function drawTypeOrderValue(drawType) {
  if (!drawType) return 99;
  if (drawType === 'M') return 0;
  if (drawType === 'E') return 1;
  return 10;
}

async function parsePickGame(game) {
  const doc = await loadPdfDoc(game.url);
  const draws = [];
  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const items = content.items
        .map((it) => ({
          str: (it.str || '').trim(),
          x: it.transform[4],
          y: it.transform[5],
        }))
        .filter((it) => it.str);

      const dateItems = items.filter((it) => PICK_DATE_RE.test(it.str));
      if (!dateItems.length) continue;
      const colCenters = clusterDateColumns(dateItems);

      for (const dateItem of dateItems) {
        const dateObjRaw = parseDateToken(dateItem.str);
        const dateObj = dateObjRaw ? normalizePickDate(dateObjRaw) : null;
        if (!dateObj) continue;

        const colIndex = colCenters.findIndex((cx) => Math.abs(cx - dateItem.x) <= 24);
        const nextCol = colCenters[colIndex + 1] || 9999;
        const rowItems = items
          .filter(
            (it) =>
              Math.abs(it.y - dateItem.y) <= 0.95 && it.x >= dateItem.x + 18 && it.x < nextCol - 6
          )
          .sort((a, b) => a.x - b.x);

        const parsedRow = parsePickRow(rowItems, game);
        if (!parsedRow) continue;

        const comboKey = parsedRow.numbers
          .map((n) => String(n).padStart(1, '0'))
          .join('');
        draws.push({
          date: fmtDate(dateObj),
          dateObj,
          drawType: parsedRow.drawType,
          numbers: parsedRow.numbers,
          extraNumbers: parsedRow.extraNumbers,
          bonusTags: parsedRow.bonusTags,
          comboKey,
        });
      }
    }
  } finally {
    await doc.destroy();
  }
  return dedupeAndSortDraws(draws);
}

async function parseCashPop(game) {
  const doc = await loadPdfDoc(game.url);
  const draws = [];
  const drawTypes = ['Morning', 'Matinee', 'Afternoon', 'Evening', 'LateNight'];

  try {
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum += 1) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      const items = content.items
        .map((it) => ({
          str: (it.str || '').trim(),
          x: it.transform[4],
          y: it.transform[5],
        }))
        .filter((it) => it.str);

      const dateItems = items.filter((it) => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(it.str));
      for (const dateItem of dateItems) {
        const dateObj = parseDateToken(dateItem.str);
        if (!dateObj) continue;
        const rowItems = items
          .filter((it) => Math.abs(it.y - dateItem.y) <= 0.95 && it.x > dateItem.x + 22)
          .sort((a, b) => a.x - b.x);
        const numbers = rowItems
          .filter((it) => /^\d{1,2}$/.test(it.str))
          .map((it) => Number(it.str))
          .slice(0, 5);
        if (numbers.length !== 5) continue;

        const date = fmtDate(dateObj);
        for (let i = 0; i < drawTypes.length; i += 1) {
          draws.push({
            date,
            dateObj,
            drawType: drawTypes[i],
            numbers: [numbers[i]],
            extraNumbers: [],
            bonusTags: [],
            comboKey: String(numbers[i]),
          });
        }
      }
    }
  } finally {
    await doc.destroy();
  }

  return dedupeAndSortDraws(draws);
}

function dedupeAndSortDraws(draws) {
  const map = new Map();
  for (const d of draws) {
    const key = `${d.date}|${d.drawType || ''}|${d.comboKey}|${d.extraNumbers.join(',')}|${d.bonusTags.join(',')}`;
    map.set(key, d);
  }
  const out = [...map.values()];
  out.sort((a, b) => {
    const dt = a.dateObj.getTime() - b.dateObj.getTime();
    if (dt !== 0) return dt;
    return drawTypeOrderValue(a.drawType) - drawTypeOrderValue(b.drawType);
  });
  return out;
}

async function parseGame(game) {
  if (game.kind === 'pick') return parsePickGame(game);
  if (game.kind === 'cash-pop') return parseCashPop(game);
  throw new Error(`Unsupported parser kind: ${game.kind}`);
}

function summarizeGame(game, draws) {
  if (!draws.length) {
    return {
      game: game.code,
      name: game.name,
      sourceUrl: game.url,
      drawCount: 0,
      coverage: { from: null, to: null },
      windows: {
        allTime: calcWindowStats([], game),
        last5Years: calcWindowStats([], game),
        last12Months: calcWindowStats([], game),
      },
      detectedFormatTransitions: [],
      formatSegments: [],
    };
  }

  const latest = draws[draws.length - 1].dateObj;
  const last5 = filterByDate(draws, dateMinusYears(latest, 5));
  const last12 = filterByDate(draws, dateMinusMonths(latest, 12));
  const transitions = detectFormatTransitions(draws);
  const rawSegments = buildFormatSegments(draws, transitions);

  return {
    game: game.code,
    name: game.name,
    sourceUrl: game.url,
    drawCount: draws.length,
    coverage: { from: draws[0].date, to: draws[draws.length - 1].date },
    windows: {
      allTime: calcWindowStats(draws, game),
      last5Years: calcWindowStats(last5, game),
      last12Months: calcWindowStats(last12, game),
    },
    detectedFormatTransitions: transitions,
    formatSegments: rawSegments.map((s) => {
      const segDraws = draws.filter((d) => {
        if (s.inclusiveTo) return d.date >= s.from && d.date <= s.to;
        return d.date >= s.from && d.date < s.to;
      });
      return {
        segment: s.segment,
        from: s.from,
        to: s.to,
        count: s.count,
        labelsSeen: sortedUniqueStrings(segDraws.map((d) => d.drawType)),
        bonusRatePct: Number(
          (
            (segDraws.filter((d) => d.extraNumbers.length > 0 || d.bonusTags.length > 0).length /
              Math.max(segDraws.length, 1)) *
            100
          ).toFixed(2)
        ),
      };
    }),
  };
}

async function writeOutput(outputPath, payload) {
  const abs = path.isAbsolute(outputPath) ? outputPath : path.resolve(process.cwd(), outputPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return abs;
}

async function main() {
  const args = parseArgs(process.argv);
  const selected = args.games.map((g) => GAME_DEFS[g]).filter(Boolean);
  if (!selected.length) {
    throw new Error(`No valid games selected. Known games: ${Object.keys(GAME_DEFS).join(', ')}`);
  }

  const unknown = args.games.filter((g) => !GAME_DEFS[g]);
  if (unknown.length) {
    console.warn(`Ignoring unknown games: ${unknown.join(', ')}`);
  }

  const summaries = [];
  for (const game of selected) {
    // Keep this output simple for phone users running manually.
    console.log(`Analyzing ${game.name}...`);
    const draws = await parseGame(game);
    summaries.push(summarizeGame(game, draws));
    console.log(
      `  ${game.name}: ${draws.length} draws (${draws[0]?.date || 'n/a'} -> ${
        draws[draws.length - 1]?.date || 'n/a'
      })`
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'Official Florida Lottery history PDFs',
    windows: ['allTime', 'last5Years', 'last12Months'],
    games: summaries,
  };

  if (args.output) {
    const abs = await writeOutput(args.output, payload);
    console.log(`Saved analysis JSON to ${abs}`);
  } else {
    console.log(JSON.stringify(payload, null, 2));
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
