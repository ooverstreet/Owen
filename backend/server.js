'use strict';
// ═══════════════════════════════════════════════════════════════
//  Crypto Signal Bot v2.0 — Coinbase Advanced Trade API
//  Deploy to Railway: https://railway.app
// ═══════════════════════════════════════════════════════════════
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const jwt      = require('jsonwebtoken');
const fetch    = (...args) => globalThis.fetch(...args);

const app  = express();
app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════════════════════════════
// CONFIGURATION (from Railway environment variables)
// ══════════════════════════════════════════════════════════════════
const CFG = {
  appToken:       process.env.APP_TOKEN       || 'changeme',
  paperMode:      process.env.PAPER_MODE      !== 'false',
  paperBalance:   parseFloat(process.env.PAPER_BALANCE)    || 1000,
  tradeSize:      parseFloat(process.env.TRADE_SIZE)       || 50,
  maxPositions:   parseInt(process.env.MAX_POSITIONS)      || 2,
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT) || 50,
  timeframe:      process.env.TIMEFRAME       || '15m',
  watchedCoins:   (process.env.WATCHED_COINS  || 'BTC-USD,ETH-USD,SOL-USD').split(',').map(s => s.trim()),
  activeMode:     process.env.ACTIVE_MODE     !== 'false',
  minConfidence:  parseInt(process.env.MIN_CONFIDENCE)     || 35,
  entryCooldownMin: parseInt(process.env.ENTRY_COOLDOWN_MIN) || 8,
  regimeFilter:   process.env.REGIME_FILTER   !== 'false',
  minEmaGapPct:   parseFloat(process.env.MIN_EMA_GAP_PCT)  || 0.12,
  minAtrPct:      parseFloat(process.env.MIN_ATR_PCT)      || 0.35,
  longOnlyLive:   process.env.LONG_ONLY_LIVE  !== 'false',
  cbKeyName:      process.env.CB_KEY_NAME     || '',
  cbPrivateKey:   (process.env.CB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
};

const TF_GRAN = { '1m':60, '5m':300, '15m':900, '1h':3600, '4h':21600 };
const RISK    = {
  '1m':{ tp:.008, sl:.004 }, '5m':{ tp:.015, sl:.007 },
  '15m':{ tp:.025, sl:.012 }, '1h':{ tp:.04, sl:.02 }, '4h':{ tp:.07, sl:.035 },
};

// ══════════════════════════════════════════════════════════════════
// STATE  (persisted to disk on every trade)
// ══════════════════════════════════════════════════════════════════
const STATE_FILE = path.join(__dirname, 'state.json');

let ST = {
  paperBalance:   CFG.paperBalance,
  startBalance:   CFG.paperBalance,
  positions:      {},   // { 'BTC-USD': { side, size, entry, tp, sl, opened, reason } }
  trades:         [],   // completed trade objects
  signals:        {},   // latest signal per coin
  lastEntryAt:    {},   // timestamp by coin for cooldown throttling
  dailyLoss:      0,
  dailyStart:     new Date().toDateString(),
  tradingEnabled: false,
  lastCycleAt:    null,
  errors:         [],
};

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(ST, null, 2)); } catch(e) {}
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      ST = { ...ST, ...saved };
    }
  } catch(e) { console.warn('Could not load state:', e.message); }
}
loadState();

function checkDailyReset() {
  const today = new Date().toDateString();
  if (ST.dailyStart !== today) { ST.dailyLoss = 0; ST.dailyStart = today; }
}

// ══════════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ══════════════════════════════════════════════════════════════════
function auth(req, res, next) {
  const tok = req.headers['x-app-token'] || req.query.token;
  if (tok !== CFG.appToken) return res.status(401).json({ error: 'Unauthorized — check your APP_TOKEN' });
  next();
}

// ══════════════════════════════════════════════════════════════════
// COINBASE PUBLIC API  (no auth — for price data)
// ══════════════════════════════════════════════════════════════════
const CB_PUB = 'https://api.exchange.coinbase.com';
const CB_ADV = 'https://api.coinbase.com';

async function fetchCandles(productId, tf) {
  const gran = TF_GRAN[tf] || 900;
  const end  = new Date();
  const start = new Date(end.getTime() - gran * 280 * 1000);
  const url  = `${CB_PUB}/products/${productId}/candles?granularity=${gran}&start=${start.toISOString()}&end=${end.toISOString()}`;
  const res  = await fetch(url);
  if (!res.ok) throw new Error(`Candles fetch failed: HTTP ${res.status}`);
  const raw  = await res.json();
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('Insufficient candle data');
  // Coinbase returns newest first → reverse to oldest first
  return raw.reverse().map(c => ({
    time:c[0], low:+c[1], high:+c[2], open:+c[3], close:+c[4], volume:+c[5],
  }));
}

async function fetchPrice(productId) {
  const res = await fetch(`${CB_PUB}/products/${productId}/ticker`);
  const d   = await res.json();
  if (!d.price) throw new Error(`No price data for ${productId}`);
  return +d.price;
}

// ══════════════════════════════════════════════════════════════════
// COINBASE ADVANCED TRADE API  (authenticated — for placing orders)
// ══════════════════════════════════════════════════════════════════
function makeCBJWT(method, path) {
  if (!CFG.cbKeyName || !CFG.cbPrivateKey) throw new Error('Coinbase API key not configured');
  try {
    return jwt.sign(
      {
        sub: CFG.cbKeyName,
        iss: 'cdp',
        nbf: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 120,
        uri: `${method} api.coinbase.com${path}`,
      },
      CFG.cbPrivateKey,
      {
        algorithm: 'ES256',
        header: { kid: CFG.cbKeyName, nonce: crypto.randomBytes(16).toString('hex') },
      }
    );
  } catch(e) {
    throw new Error(`JWT signing failed: ${e.message}. Check your CB_PRIVATE_KEY format.`);
  }
}

async function cbRequest(method, path, body) {
  const token = makeCBJWT(method, path);
  const res   = await fetch(`${CB_ADV}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await res.json();
  if (!res.ok) throw new Error(d.message || d.error_details || `HTTP ${res.status}`);
  return d;
}

async function getCBBalance(currency = 'USD') {
  const d = await cbRequest('GET', '/api/v3/brokerage/accounts');
  const account = (d.accounts || []).find(a => a.currency === currency);
  return account ? +account.available_balance.value : 0;
}

async function placeCBOrder(productId, side, usdSize) {
  const orderId = crypto.randomBytes(8).toString('hex');
  const config  = side === 'BUY'
    ? { market_market_ioc: { quote_size: usdSize.toFixed(2) } }
    : { market_market_ioc: { base_size:  (usdSize / await fetchPrice(productId)).toFixed(8) } };

  return cbRequest('POST', '/api/v3/brokerage/orders', {
    client_order_id:     orderId,
    product_id:          productId,
    side:                side,
    order_configuration: config,
  });
}

// ══════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS  (matches frontend calculations)
// ══════════════════════════════════════════════════════════════════
function calcEMA(closes, p) {
  if (closes.length < p) return [];
  const k = 2 / (p + 1);
  let ema = closes.slice(0, p).reduce((a, b) => a + b) / p;
  const r = [ema];
  for (let i = p; i < closes.length; i++) { ema = closes[i] * k + ema * (1 - k); r.push(ema); }
  return r;
}

function calcRSI(closes, p = 14) {
  if (closes.length < p + 2) return null;
  let g = 0, l = 0;
  for (let i = closes.length - p; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / p, al = l / p;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcMACD(closes) {
  if (closes.length < 35) return null;
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  const ml  = e12.slice(e12.length - e26.length).map((v, i) => v - e26[i]);
  const sig = calcEMA(ml, 9);
  if (!sig.length) return null;
  const lh = ml[ml.length - 1] - sig[sig.length - 1];
  const ph = ml.length > 1 && sig.length > 1 ? ml[ml.length - 2] - sig[sig.length - 2] : 0;
  return { hist: lh, prevHist: ph, cross: lh > 0 && ph <= 0 ? 'bull' : lh < 0 && ph >= 0 ? 'bear' : null };
}

function calcBBPos(closes, p = 20) {
  if (closes.length < p) return null;
  const sl = closes.slice(-p), m = sl.reduce((a, b) => a + b) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  const range = 2 * std * 2;
  return range > 0 ? (closes[closes.length - 1] - (m - 2 * std)) / range : 0.5;
}

function calcVWAP(candles) {
  const now = new Date();
  const ds  = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000;
  const dc  = candles.filter(c => c.time >= ds);
  if (!dc.length) return null;
  let ct = 0, cv = 0;
  dc.forEach(c => { const tp = (c.high + c.low + c.close) / 3; ct += tp * c.volume; cv += c.volume; });
  return cv > 0 ? ct / cv : null;
}

function calcATRPercent(candles, p = 14) {
  if (candles.length < p + 1) return null;
  let sumTr = 0;
  for (let i = candles.length - p; i < candles.length; i++) {
    const c = candles[i], prev = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - prev.close),
      Math.abs(c.low - prev.close)
    );
    sumTr += tr;
  }
  const atr = sumTr / p;
  const cur = candles[candles.length - 1].close;
  return cur > 0 ? (atr / cur) * 100 : null;
}

function passRegimeFilter(signal) {
  if (!CFG.regimeFilter) return { ok: true, reason: 'disabled' };
  const ind = signal.indicators || {};
  const emaGapPct = ind.emaGapPct ?? 0;
  const atrPct = ind.atrPct ?? 0;
  const side = signal.label.includes('BUY') ? 'BUY' : signal.label.includes('SELL') ? 'SELL' : 'HOLD';

  if (emaGapPct < CFG.minEmaGapPct) {
    return { ok: false, reason: `emaGap ${emaGapPct.toFixed(3)}% < ${CFG.minEmaGapPct}%` };
  }
  if (atrPct < CFG.minAtrPct) {
    return { ok: false, reason: `atr ${atrPct.toFixed(3)}% < ${CFG.minAtrPct}%` };
  }
  if (side === 'BUY' && !(ind.ema9 > ind.ema21)) {
    return { ok: false, reason: 'BUY signal not aligned with EMA trend' };
  }
  if (side === 'SELL' && !(ind.ema9 < ind.ema21)) {
    return { ok: false, reason: 'SELL signal not aligned with EMA trend' };
  }
  return { ok: true, reason: 'ok' };
}

function generateSignal(candles) {
  if (candles.length < 35) return null;
  const closes = candles.map(c => c.close), cur = closes[closes.length - 1];
  const rsi = calcRSI(closes), macd = calcMACD(closes), bbPos = calcBBPos(closes);
  const vwap = calcVWAP(candles);
  const atrPct = calcATRPercent(candles);
  const e9 = calcEMA(closes, 9), e21 = calcEMA(closes, 21);
  const ema9 = e9[e9.length - 1], ema21 = e21[e21.length - 1];
  const ema9p = e9[e9.length - 2] || ema9, ema21p = e21[e21.length - 2] || ema21;
  const emaCross = ema9 > ema21 && ema9p <= ema21p ? 'golden' : ema9 < ema21 && ema9p >= ema21p ? 'death' : null;
  const emaGapPct = cur > 0 ? Math.abs((ema9 - ema21) / cur) * 100 : 0;

  let score = 0;
  if (rsi !== null) {
    if (rsi < 25) score += 2.5; else if (rsi < 35) score += 1.8; else if (rsi < 45) score += 0.8;
    else if (rsi > 75) score -= 2.5; else if (rsi > 65) score -= 1.8; else if (rsi > 55) score -= 0.8;
  }
  if (macd) {
    if (macd.cross === 'bull') score += 2; else if (macd.cross === 'bear') score -= 2;
    else if (macd.hist > 0) score += macd.hist > macd.prevHist ? 0.8 : 0.3;
    else score -= Math.abs(macd.hist) > Math.abs(macd.prevHist) ? 0.8 : 0.3;
  }
  if (bbPos !== null) {
    if (bbPos < 0.1) score += 1.8; else if (bbPos < 0.25) score += 1;
    else if (bbPos > 0.9) score -= 1.8; else if (bbPos > 0.75) score -= 1;
  }
  if (emaCross === 'golden') score += 1.5; else if (emaCross === 'death') score -= 1.5;
  else score += ema9 > ema21 ? 0.5 : -0.5;
  if (vwap && cur) score += cur > vwap ? 0.6 : -0.6;

  const norm = Math.max(-1, Math.min(1, score / 9));
  const risk = RISK[CFG.timeframe] || RISK['15m'];
  const label = norm > 0.55 ? 'STRONG_BUY' : norm > 0.28 ? 'BUY'
              : norm < -0.55 ? 'STRONG_SELL' : norm < -0.28 ? 'SELL' : 'HOLD';
  return {
    label,
    confidence: Math.round(Math.abs(norm) * 100),
    score:  +norm.toFixed(3),
    price:  cur,
    tp: label.includes('BUY') ? +(cur * (1 + risk.tp)).toFixed(6) : +(cur * (1 - risk.tp)).toFixed(6),
    sl: label.includes('BUY') ? +(cur * (1 - risk.sl)).toFixed(6) : +(cur * (1 + risk.sl)).toFixed(6),
    indicators: {
      rsi: rsi ? +rsi.toFixed(1) : null,
      macdHist: macd ? +macd.hist.toFixed(4) : null,
      bbPos: bbPos !== null ? +bbPos.toFixed(3) : null,
      emaCross,
      ema9,
      ema21,
      emaGapPct: +emaGapPct.toFixed(4),
      atrPct: atrPct !== null ? +atrPct.toFixed(4) : null,
      vwap: vwap ? +vwap.toFixed(4) : null,
    },
  };
}

// ══════════════════════════════════════════════════════════════════
// POSITION MANAGEMENT
// ══════════════════════════════════════════════════════════════════
async function openPosition(coin, signal) {
  if (Object.keys(ST.positions).length >= CFG.maxPositions) return false;
  if (ST.positions[coin]) return false;

  const price = await fetchPrice(coin);
  const side  = signal.label.includes('BUY') ? 'BUY' : 'SELL';
  if (!CFG.paperMode && CFG.longOnlyLive && side === 'SELL') {
    console.log(`ℹ️  Skipping ${coin} SELL entry in live mode (LONG_ONLY_LIVE=true)`);
    return false;
  }
  const risk  = RISK[CFG.timeframe] || RISK['15m'];
  const tp    = side === 'BUY' ? price * (1 + risk.tp) : price * (1 - risk.tp);
  const sl    = side === 'BUY' ? price * (1 - risk.sl) : price * (1 + risk.sl);

  if (CFG.paperMode) {
    if (ST.paperBalance < CFG.tradeSize) {
      console.log(`⚠️  Insufficient paper balance ($${ST.paperBalance.toFixed(2)}) for $${CFG.tradeSize} trade`);
      return false;
    }
    ST.paperBalance -= CFG.tradeSize;
  } else {
    try { await placeCBOrder(coin, side, CFG.tradeSize); }
    catch(e) {
      console.error(`❌ Order failed for ${coin}:`, e.message);
      ST.errors.push({ time: Date.now(), coin, msg: e.message });
      return false;
    }
  }

  ST.positions[coin] = {
    coin, side, size: CFG.tradeSize, entry: price, tp: +tp.toFixed(6), sl: +sl.toFixed(6),
    signal: signal.label, confidence: signal.confidence, opened: Date.now(),
  };
  const mode = CFG.paperMode ? '📄 PAPER' : '💰 LIVE';
  console.log(`${mode} OPEN  ${side.padEnd(4)} ${coin} @ $${price.toFixed(4)} | TP:$${tp.toFixed(4)} SL:$${sl.toFixed(4)}`);
  saveState();
  return true;
}

async function closePosition(coin, reason) {
  const pos = ST.positions[coin];
  if (!pos) return;

  const price = await fetchPrice(coin);
  const pnl   = pos.side === 'BUY'
    ? (price - pos.entry) / pos.entry * pos.size
    : (pos.entry - price) / pos.entry * pos.size;

  if (CFG.paperMode) {
    ST.paperBalance += pos.size + pnl;
  } else {
    try {
      const exitSide = pos.side === 'BUY' ? 'SELL' : 'BUY';
      await placeCBOrder(coin, exitSide, pos.size);
    } catch(e) {
      console.error(`❌ Close order failed for ${coin}:`, e.message);
      ST.errors.push({ time: Date.now(), coin, msg: e.message });
      return;
    }
  }

  if (pnl < 0) ST.dailyLoss += Math.abs(pnl);

  const trade = { ...pos, exit: price, pnl: +pnl.toFixed(4), pnlPct: +((pnl / pos.size) * 100).toFixed(2), reason, closed: Date.now() };
  ST.trades.unshift(trade);
  if (ST.trades.length > 100) ST.trades.pop();
  delete ST.positions[coin];

  const sign = pnl >= 0 ? '+' : '';
  console.log(`${CFG.paperMode ? '📄 PAPER' : '💰 LIVE'} CLOSE ${pos.side.padEnd(4)} ${coin} @ $${price.toFixed(4)} | PnL: ${sign}$${pnl.toFixed(2)} (${reason})`);
  saveState();
}

async function checkExits(coin) {
  const pos = ST.positions[coin];
  if (!pos) return;
  const price = await fetchPrice(coin);
  if (pos.side === 'BUY') {
    if (price >= pos.tp) { await closePosition(coin, 'TAKE_PROFIT'); return; }
    if (price <= pos.sl) { await closePosition(coin, 'STOP_LOSS');   return; }
  } else {
    if (price <= pos.tp) { await closePosition(coin, 'TAKE_PROFIT'); return; }
    if (price >= pos.sl) { await closePosition(coin, 'STOP_LOSS');   return; }
  }
}

// ══════════════════════════════════════════════════════════════════
// MONITOR LOOP  (runs every 60 seconds)
// ══════════════════════════════════════════════════════════════════
let monitorTimer = null;

async function runCycle() {
  checkDailyReset();
  ST.lastCycleAt = Date.now();

  // Hard stop if daily loss limit is hit
  if (ST.dailyLoss >= CFG.dailyLossLimit && ST.tradingEnabled) {
    ST.tradingEnabled = false;
    console.log(`🛑 Daily loss limit ($${CFG.dailyLossLimit}) reached — auto-trading paused`);
    saveState();
  }

  for (const coin of CFG.watchedCoins) {
    try {
      // Always check exits regardless of trading toggle
      if (ST.positions[coin]) await checkExits(coin);

      // Fetch fresh signal
      const candles = await fetchCandles(coin, CFG.timeframe);
      const signal  = generateSignal(candles);
      const regime = signal ? passRegimeFilter(signal) : { ok: true, reason: 'n/a' };
      if (signal) ST.signals[coin] = { ...signal, regime, updatedAt: Date.now() };

      // Entry logic — only when auto-trading is on
      if (ST.tradingEnabled && signal) {
        const hasPos = !!ST.positions[coin];
        const isStrong = signal.label === 'STRONG_BUY' || signal.label === 'STRONG_SELL';
        const isDirectional = signal.label === 'BUY' || signal.label === 'SELL' || isStrong;
        const confidenceOk = signal.confidence >= CFG.minConfidence;
        const cooldownMs = Math.max(0, CFG.entryCooldownMin) * 60 * 1000;
        const lastEntryAt = ST.lastEntryAt[coin] || 0;
        const cooledDown = Date.now() - lastEntryAt >= cooldownMs;

        const shouldOpen = !hasPos && (
          CFG.activeMode
            ? (isDirectional && confidenceOk && cooledDown && regime.ok)
            : (isStrong && regime.ok)
        );

        if (shouldOpen) {
          const opened = await openPosition(coin, signal);
          if (opened) ST.lastEntryAt[coin] = Date.now();
        } else if (hasPos) {
          const pos = ST.positions[coin];
          const shouldClose = (pos.side === 'BUY'  && (signal.label === 'STRONG_SELL' || signal.label === 'SELL'))
                           || (pos.side === 'SELL' && (signal.label === 'STRONG_BUY'  || signal.label === 'BUY'));
          if (shouldClose) await closePosition(coin, 'SIGNAL_REVERSAL');
        }
      }
    } catch(e) {
      console.error(`⚠️  Cycle error [${coin}]:`, e.message);
      ST.errors.push({ time: Date.now(), coin, msg: e.message });
      if (ST.errors.length > 25) ST.errors.shift();
    }
  }
}

function startMonitor() {
  if (monitorTimer) return;
  console.log(`🔄 Monitor starting — checking every 60s on [${CFG.watchedCoins.join(', ')}]`);
  runCycle(); // immediate first run
  monitorTimer = setInterval(runCycle, 60 * 1000);
}
startMonitor();

// ══════════════════════════════════════════════════════════════════
// PORTFOLIO P&L HELPER
// ══════════════════════════════════════════════════════════════════
async function getLivePnL() {
  let unrealized = 0;
  for (const [coin, pos] of Object.entries(ST.positions)) {
    try {
      const price = await fetchPrice(coin);
      unrealized += pos.side === 'BUY'
        ? (price - pos.entry) / pos.entry * pos.size
        : (pos.entry - price) / pos.entry * pos.size;
    } catch(e) {}
  }
  const realized = ST.trades.reduce((a, t) => a + (t.pnl || 0), 0);
  const wins     = ST.trades.filter(t => t.pnl > 0).length;
  const total    = ST.trades.length;
  return {
    unrealized: +unrealized.toFixed(2),
    realized:   +realized.toFixed(2),
    total:      +(unrealized + realized).toFixed(2),
    winRate:    total > 0 ? +((wins / total) * 100).toFixed(1) : null,
    tradeCount: total,
  };
}

function getReservedCapital() {
  return Object.values(ST.positions).reduce((sum, pos) => sum + (+pos.size || 0), 0);
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (!/[",\n]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function tradesToCSV(trades) {
  const cols = [
    'closedAt',
    'openedAt',
    'coin',
    'side',
    'signal',
    'reason',
    'sizeUsd',
    'entry',
    'exit',
    'pnlUsd',
    'pnlPct',
    'confidence',
    'durationMin',
  ];
  const lines = [cols.join(',')];

  for (const t of trades) {
    const durationMin = (t.closed && t.opened) ? ((t.closed - t.opened) / 60000) : null;
    const row = [
      t.closed ? new Date(t.closed).toISOString() : '',
      t.opened ? new Date(t.opened).toISOString() : '',
      t.coin || '',
      t.side || '',
      t.signal || '',
      t.reason || '',
      t.size,
      t.entry,
      t.exit,
      t.pnl,
      t.pnlPct,
      t.confidence,
      durationMin != null ? +durationMin.toFixed(2) : '',
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ══════════════════════════════════════════════════════════════════

// ── Public (no auth — for Railway health checks) ──────────────────
app.get('/',       (_, res) => res.json({ service: 'Crypto Signal Bot', version: '2.0.0', paperMode: CFG.paperMode, ok: true }));
app.get('/health', (_, res) => res.json({ ok: true, uptime: Math.floor(process.uptime()) }));

// ── Status ────────────────────────────────────────────────────────
app.get('/api/status', auth, async (req, res) => {
  const pnl = await getLivePnL();
  const reservedCapital = getReservedCapital();
  const equity = CFG.paperMode ? +(ST.startBalance + (pnl.total || 0)).toFixed(2) : null;
  res.json({
    paperMode:      CFG.paperMode,
    tradingEnabled: ST.tradingEnabled,
    activeMode:     CFG.activeMode,
    minConfidence:  CFG.minConfidence,
    entryCooldownMin: CFG.entryCooldownMin,
    regimeFilter:   CFG.regimeFilter,
    minEmaGapPct:   CFG.minEmaGapPct,
    minAtrPct:      CFG.minAtrPct,
    longOnlyLive:   CFG.longOnlyLive,
    watchedCoins:   CFG.watchedCoins,
    timeframe:      CFG.timeframe,
    tradeSize:      CFG.tradeSize,
    paperBalance:   +ST.paperBalance.toFixed(2),
    reservedCapital: +reservedCapital.toFixed(2),
    startBalance:   ST.startBalance,
    equity,
    dailyLoss:      +ST.dailyLoss.toFixed(2),
    dailyLossLimit: CFG.dailyLossLimit,
    lastCycleAt:    ST.lastCycleAt,
    positionCount:  Object.keys(ST.positions).length,
    errorCount:     ST.errors.length,
    pnl,
  });
});

// ── Signals ───────────────────────────────────────────────────────
app.get('/api/signals', auth, (_, res) => res.json(ST.signals));

// ── Positions (with live P&L) ─────────────────────────────────────
app.get('/api/positions', auth, async (_, res) => {
  const enriched = {};
  for (const [coin, pos] of Object.entries(ST.positions)) {
    try {
      const price = await fetchPrice(coin);
      const pnl   = pos.side === 'BUY'
        ? (price - pos.entry) / pos.entry * pos.size
        : (pos.entry - price) / pos.entry * pos.size;
      enriched[coin] = { ...pos, currentPrice: price, pnl: +pnl.toFixed(2), pnlPct: +((pnl / pos.size) * 100).toFixed(2) };
    } catch(e) { enriched[coin] = pos; }
  }
  res.json(enriched);
});

// ── Trade history ─────────────────────────────────────────────────
app.get('/api/trades', auth, (_, res) => res.json(ST.trades.slice(0, 50)));

// ── Trade history CSV export ──────────────────────────────────────
app.get('/api/trades.csv', auth, (req, res) => {
  const qLimit = parseInt(req.query.limit, 10);
  const limit = Number.isFinite(qLimit) ? Math.min(Math.max(qLimit, 1), 1000) : 200;
  const csv = tradesToCSV(ST.trades.slice(0, limit));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="trades-${stamp}.csv"`);
  res.send(csv);
});

// ── Recent errors ─────────────────────────────────────────────────
app.get('/api/errors', auth, (_, res) => res.json(ST.errors.slice(0, 20)));

// ── Toggle auto-trading ───────────────────────────────────────────
app.post('/api/toggle', auth, (_, res) => {
  ST.tradingEnabled = !ST.tradingEnabled;
  console.log(`🔀 Auto-trading ${ST.tradingEnabled ? '✅ ENABLED' : '⏸  DISABLED'}`);
  saveState();
  res.json({ tradingEnabled: ST.tradingEnabled });
});

// ── Emergency kill switch — close ALL positions immediately ───────
app.post('/api/kill', auth, async (_, res) => {
  ST.tradingEnabled = false;
  const closed = [];
  for (const coin of Object.keys(ST.positions)) {
    try { await closePosition(coin, 'KILL_SWITCH'); closed.push(coin); } catch(e) {}
  }
  console.log(`🛑 KILL SWITCH — closed: [${closed.join(', ')}]`);
  saveState();
  res.json({ ok: true, closed });
});

// ── Manual close single position ──────────────────────────────────
app.post('/api/close/:coin', auth, async (req, res) => {
  const coin = req.params.coin;
  if (!ST.positions[coin]) return res.status(404).json({ error: 'No open position for ' + coin });
  await closePosition(coin, 'MANUAL');
  res.json({ ok: true, coin });
});

// ── Reset paper trading ───────────────────────────────────────────
app.post('/api/reset-paper', auth, (_, res) => {
  if (!CFG.paperMode) return res.status(400).json({ error: 'Not in paper mode' });
  ST.paperBalance = CFG.paperBalance;
  ST.startBalance = CFG.paperBalance;
  ST.trades = [];
  ST.positions = {};
  ST.dailyLoss = 0;
  saveState();
  console.log('📄 Paper balance reset to $' + CFG.paperBalance);
  res.json({ ok: true, paperBalance: ST.paperBalance });
});

// ── Coinbase balance (live mode only) ─────────────────────────────
app.get('/api/cb-balance', auth, async (_, res) => {
  if (CFG.paperMode) return res.json({ paper: true, balance: ST.paperBalance });
  try {
    const bal = await getCBBalance('USD');
    res.json({ paper: false, balance: bal });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Update config at runtime ──────────────────────────────────────
app.post('/api/config', auth, (req, res) => {
  const {
    tradeSize, maxPositions, dailyLossLimit, watchedCoins, timeframe,
    activeMode, minConfidence, entryCooldownMin, regimeFilter, minEmaGapPct, minAtrPct, longOnlyLive,
  } = req.body;
  if (tradeSize      !== undefined) CFG.tradeSize      = +tradeSize;
  if (maxPositions   !== undefined) CFG.maxPositions   = +maxPositions;
  if (dailyLossLimit !== undefined) CFG.dailyLossLimit = +dailyLossLimit;
  if (watchedCoins   !== undefined) CFG.watchedCoins   = watchedCoins;
  if (timeframe      !== undefined) CFG.timeframe      = timeframe;
  if (activeMode     !== undefined) CFG.activeMode     = !!activeMode;
  if (minConfidence  !== undefined) CFG.minConfidence  = +minConfidence;
  if (entryCooldownMin !== undefined) CFG.entryCooldownMin = +entryCooldownMin;
  if (regimeFilter   !== undefined) CFG.regimeFilter   = !!regimeFilter;
  if (minEmaGapPct   !== undefined) CFG.minEmaGapPct   = +minEmaGapPct;
  if (minAtrPct      !== undefined) CFG.minAtrPct      = +minAtrPct;
  if (longOnlyLive   !== undefined) CFG.longOnlyLive   = !!longOnlyLive;
  res.json({
    ok: true,
    tradeSize: CFG.tradeSize,
    maxPositions: CFG.maxPositions,
    dailyLossLimit: CFG.dailyLossLimit,
    watchedCoins: CFG.watchedCoins,
    timeframe: CFG.timeframe,
    activeMode: CFG.activeMode,
    minConfidence: CFG.minConfidence,
    entryCooldownMin: CFG.entryCooldownMin,
    regimeFilter: CFG.regimeFilter,
    minEmaGapPct: CFG.minEmaGapPct,
    minAtrPct: CFG.minAtrPct,
    longOnlyLive: CFG.longOnlyLive,
  });
});

// ══════════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('\n════════════════════════════════════════');
  console.log(`🤖  Crypto Signal Bot v2.0`);
  console.log(`📡  Listening on port ${PORT}`);
  console.log(`📊  Mode:       ${CFG.paperMode ? '📄 PAPER TRADING (safe)' : '💰 LIVE TRADING'}`);
  console.log(`👁   Watching:   ${CFG.watchedCoins.join(', ')}`);
  console.log(`⏱   Timeframe:  ${CFG.timeframe} | Trade size: $${CFG.tradeSize}`);
  console.log(`🛡   Daily loss limit: $${CFG.dailyLossLimit}`);
  console.log(`⚙️   Active mode: ${CFG.activeMode ? 'ON' : 'OFF'} | Min confidence: ${CFG.minConfidence}% | Cooldown: ${CFG.entryCooldownMin}m`);
  console.log(`🧭  Regime filter: ${CFG.regimeFilter ? 'ON' : 'OFF'} | EMA gap >= ${CFG.minEmaGapPct}% | ATR >= ${CFG.minAtrPct}%`);
  console.log(`📌  Live mode policy: ${CFG.longOnlyLive ? 'LONG ONLY (no fresh SELL entries)' : 'ALLOW BUY/SELL entries'}`);
  console.log('════════════════════════════════════════\n');
});
