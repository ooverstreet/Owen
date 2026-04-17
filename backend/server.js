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
  tradingEnabledOnStartup: process.env.TRADING_ENABLED_ON_STARTUP !== 'false',
  paperBalance:   parseFloat(process.env.PAPER_BALANCE)    || 1000,
  tradeSize:      parseFloat(process.env.TRADE_SIZE)       || 50,
  tradeSizePct:   parseFloat(process.env.TRADE_SIZE_PCT)   || 0,
  tradeSizeMinUsd: parseFloat(process.env.TRADE_SIZE_MIN_USD) || 0,
  tradeSizeMaxUsd: parseFloat(process.env.TRADE_SIZE_MAX_USD) || 0,
  maxPositions:   parseInt(process.env.MAX_POSITIONS)      || 2,
  dailyLossLimit: parseFloat(process.env.DAILY_LOSS_LIMIT) || 50,
  timeframe:      process.env.TIMEFRAME       || '15m',
  watchedCoins:   (process.env.WATCHED_COINS  || 'BTC-USD,ETH-USD,SOL-USD').split(',').map(s => s.trim()),
  activeMode:     process.env.ACTIVE_MODE     !== 'false',
  minConfidence:  parseInt(process.env.MIN_CONFIDENCE)     || 35,
  entryCooldownMin: parseInt(process.env.ENTRY_COOLDOWN_MIN) || 8,
  buyScoreThreshold: parseFloat(process.env.BUY_SCORE_THRESHOLD) || 0.28,
  strongScoreThreshold: parseFloat(process.env.STRONG_SCORE_THRESHOLD) || 0.55,
  dipBuyEnabled:  process.env.DIP_BUY_ENABLED === 'true',
  dipLookbackCandles: parseInt(process.env.DIP_LOOKBACK_CANDLES) || 6,
  minDipPct:      parseFloat(process.env.MIN_DIP_PCT)      || 0.25,
  minTakeProfitUsd: parseFloat(process.env.MIN_TAKE_PROFIT_USD) || 0,
  signalCloseMinProfitUsd: parseFloat(process.env.SIGNAL_CLOSE_MIN_PROFIT_USD) || 0,
  paperDisableStopLoss: process.env.PAPER_DISABLE_STOP_LOSS === 'true',
  walletSignalEnabled: process.env.WALLET_SIGNAL_ENABLED === 'true',
  walletSignalMode:    process.env.WALLET_SIGNAL_MODE || 'off', // off | filter | boost
  walletSignalThreshold: parseFloat(process.env.WALLET_SIGNAL_THRESHOLD) || 0.2,
  walletSignalBoostPct: parseFloat(process.env.WALLET_SIGNAL_BOOST_PCT) || 20,
  feeBps:          parseFloat(process.env.FEE_BPS) || 10,
  slippageEntryBps: parseFloat(process.env.SLIPPAGE_BPS_ENTRY) || 3,
  slippageExitBps:  parseFloat(process.env.SLIPPAGE_BPS_EXIT) || 3,
  atrTrailEnabled: process.env.ATR_TRAIL_ENABLED !== 'false',
  atrTrailMult:    parseFloat(process.env.ATR_TRAIL_MULT) || 1.2,
  breakEvenTriggerR: parseFloat(process.env.BREAK_EVEN_TRIGGER_R) || 0.6,
  breakEvenOffsetBps: parseFloat(process.env.BREAK_EVEN_OFFSET_BPS) || 2,
  loopIntervalSec: parseInt(process.env.LOOP_INTERVAL_SEC, 10) || 60,
  regimeFilter:   process.env.REGIME_FILTER   !== 'false',
  minEmaGapPct:   parseFloat(process.env.MIN_EMA_GAP_PCT)  || 0.12,
  minAtrPct:      parseFloat(process.env.MIN_ATR_PCT)      || 0.35,
  regimeRequireEmaAlignment: process.env.REGIME_REQUIRE_EMA_ALIGNMENT !== 'false',
  longOnlyPaper:  process.env.LONG_ONLY_PAPER === 'true',
  longOnlyLive:   process.env.LONG_ONLY_LIVE  !== 'false',
  cbKeyName:      process.env.CB_KEY_NAME     || '',
  cbPrivateKey:   (process.env.CB_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
};

function clamp(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

CFG.feeBps = clamp(CFG.feeBps, 0, 1000, 10);
CFG.slippageEntryBps = clamp(CFG.slippageEntryBps, 0, 1000, 3);
CFG.slippageExitBps = clamp(CFG.slippageExitBps, 0, 1000, 3);
CFG.atrTrailMult = clamp(CFG.atrTrailMult, 0, 10, 1.2);
CFG.breakEvenTriggerR = clamp(CFG.breakEvenTriggerR, 0, 10, 0.6);
CFG.breakEvenOffsetBps = clamp(CFG.breakEvenOffsetBps, 0, 500, 2);
CFG.loopIntervalSec = Math.round(clamp(CFG.loopIntervalSec, 5, 300, 60));

const TF_GRAN = { '1m':60, '5m':300, '15m':900, '1h':3600, '4h':21600 };
const RISK    = {
  '1m':{ tp:.008, sl:.004 }, '5m':{ tp:.015, sl:.007 },
  '15m':{ tp:.025, sl:.012 }, '1h':{ tp:.04, sl:.02 }, '4h':{ tp:.07, sl:.035 },
};
const BACKTEST_MAX_DAYS_BY_TF = { '1m': 10, '5m': 60, '15m': 180, '1h': 730, '4h': 1460 };

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
  lastTradeAt:    null, // last open/close event time
  lastBlocked:    null, // latest blocked-entry explanation
  dailyLoss:      0,
  dailyStart:     new Date().toDateString(),
  tradingEnabled: false,
  lastCycleAt:    null,
  errors:         [],
};

if (!ST.walletSignals || typeof ST.walletSignals !== 'object') {
  ST.walletSignals = { updatedAt: null, coins: {} };
}

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
if (CFG.tradingEnabledOnStartup) {
  ST.tradingEnabled = true;
}

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJSONWithRetry(url, opts = {}) {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const timeoutMs = Math.max(1000, opts.timeoutMs ?? 10000);
  const method = opts.method || 'GET';
  let lastErr = null;

  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: opts.headers,
        body: opts.body,
        signal: ctl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch (e) {}
      if (!res.ok) {
        const msg = json?.error || json?.message || json?.error_details || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return json;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (i < attempts - 1) await sleep(250 * (i + 1));
    }
  }
  throw lastErr || new Error('fetch failed');
}

async function fetchCandles(productId, tf) {
  const gran = TF_GRAN[tf] || 900;
  const end  = new Date();
  const start = new Date(end.getTime() - gran * 280 * 1000);
  const url  = `${CB_PUB}/products/${productId}/candles?granularity=${gran}&start=${start.toISOString()}&end=${end.toISOString()}`;
  const raw  = await fetchJSONWithRetry(url, { attempts: 3, timeoutMs: 12000 });
  if (!Array.isArray(raw) || raw.length < 2) throw new Error('Insufficient candle data');
  // Coinbase returns newest first → reverse to oldest first
  return raw.reverse().map(c => ({
    time:c[0], low:+c[1], high:+c[2], open:+c[3], close:+c[4], volume:+c[5],
  }));
}

async function fetchPrice(productId) {
  const d   = await fetchJSONWithRetry(`${CB_PUB}/products/${productId}/ticker`, { attempts: 3, timeoutMs: 9000 });
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
  return fetchJSONWithRetry(`${CB_ADV}${path}`, {
    method,
    attempts: 2,
    timeoutMs: 12000,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
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
  if (CFG.regimeRequireEmaAlignment) {
    if (side === 'BUY' && !(ind.ema9 > ind.ema21)) {
      return { ok: false, reason: 'BUY signal not aligned with EMA trend' };
    }
    if (side === 'SELL' && !(ind.ema9 < ind.ema21)) {
      return { ok: false, reason: 'SELL signal not aligned with EMA trend' };
    }
  }
  return { ok: true, reason: 'ok' };
}

function passDipFilter(candles, side) {
  if (!CFG.dipBuyEnabled) return { ok: true, reason: 'disabled', movePct: null };
  const lb = Math.max(2, CFG.dipLookbackCandles || 2);
  if (!candles || candles.length < lb + 1) return { ok: false, reason: 'insufficient candles', movePct: null };

  // Compare current close against prior lookback window (excluding current candle).
  const hist = candles.slice(-(lb + 1), -1);
  const closes = hist.map(c => c.close);
  const cur = candles[candles.length - 1].close;
  const windowHigh = Math.max(...closes);
  const windowLow = Math.min(...closes);

  if (side === 'BUY') {
    const dipPct = windowHigh > 0 ? ((windowHigh - cur) / windowHigh) * 100 : 0;
    if (dipPct < CFG.minDipPct) {
      return { ok: false, reason: `dip ${dipPct.toFixed(3)}% < ${CFG.minDipPct}%`, movePct: +dipPct.toFixed(4) };
    }
    return { ok: true, reason: 'ok', movePct: +dipPct.toFixed(4) };
  }

  if (side === 'SELL') {
    const rallyPct = windowLow > 0 ? ((cur - windowLow) / windowLow) * 100 : 0;
    if (rallyPct < CFG.minDipPct) {
      return { ok: false, reason: `rally ${rallyPct.toFixed(3)}% < ${CFG.minDipPct}%`, movePct: +rallyPct.toFixed(4) };
    }
    return { ok: true, reason: 'ok', movePct: +rallyPct.toFixed(4) };
  }

  return { ok: true, reason: 'n/a', movePct: null };
}

function passWalletFlowGate(coin, signal) {
  if (!CFG.walletSignalEnabled) return { ok: true, reason: 'disabled', score: null };
  const rec = ST.walletSignals?.coins?.[coin];
  if (!rec) return { ok: false, reason: 'no wallet signal for coin', score: null };
  const score = Number(rec.score);
  if (!Number.isFinite(score)) return { ok: false, reason: 'wallet score missing/invalid', score: null };
  const side = signal.label.includes('BUY') ? 'BUY' : signal.label.includes('SELL') ? 'SELL' : 'HOLD';
  if (side === 'BUY' && score < CFG.walletSignalThreshold) {
    return { ok: false, reason: `wallet score ${score.toFixed(3)} < ${CFG.walletSignalThreshold}`, score };
  }
  if (side === 'SELL' && score > -CFG.walletSignalThreshold) {
    return { ok: false, reason: `wallet score ${score.toFixed(3)} > -${CFG.walletSignalThreshold}`, score };
  }
  return { ok: true, reason: 'ok', score };
}

function bpsToFraction(bps) {
  return Math.max(0, Number(bps) || 0) / 10000;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function applySlippagePrice(markPrice, side, bps, phase) {
  const frac = bpsToFraction(bps);
  const adverse = (
    (phase === 'entry' && side === 'BUY') ||
    (phase === 'exit' && side === 'SELL')
  );
  return adverse ? markPrice * (1 + frac) : markPrice * (1 - frac);
}

function estimatePositionPnl(pos, exitMarkPrice, exitSlippageBps = CFG.slippageExitBps) {
  if (!pos || !Number.isFinite(+pos.entry) || !Number.isFinite(+pos.size) || !Number.isFinite(exitMarkPrice)) {
    return { gross: 0, fees: 0, net: 0, exitPrice: null };
  }
  const side = pos.side === 'SELL' ? 'SELL' : 'BUY';
  const entry = +pos.entry;
  const size = +pos.size;
  const exitPrice = applySlippagePrice(exitMarkPrice, side, exitSlippageBps, 'exit');
  const gross = side === 'BUY'
    ? ((exitPrice - entry) / entry) * size
    : ((entry - exitPrice) / entry) * size;
  const entryFee = safeNum(pos.feeEntryUsd, 0);
  const exitFee = size * bpsToFraction(CFG.feeBps);
  const fees = entryFee + exitFee;
  const net = gross - fees;
  return { gross, fees, net, exitPrice };
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
  const buyT = Math.max(0.01, Math.min(0.95, Math.abs(CFG.buyScoreThreshold)));
  const strongT = Math.max(buyT + 0.01, Math.min(0.99, Math.abs(CFG.strongScoreThreshold)));
  const label = norm > strongT ? 'STRONG_BUY' : norm > buyT ? 'BUY'
              : norm < -strongT ? 'STRONG_SELL' : norm < -buyT ? 'SELL' : 'HOLD';
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

  const usdSize = await resolveTradeSizeUsd();
  if (!Number.isFinite(usdSize) || usdSize <= 0) {
    ST.lastBlocked = { coin, label: signal.label, confidence: signal.confidence, reason: 'Computed trade size is invalid', at: Date.now() };
    return false;
  }

  const markPrice = await fetchPrice(coin);
  const side  = signal.label.includes('BUY') ? 'BUY' : 'SELL';
  const sellBlocked = side === 'SELL' && (
    (CFG.paperMode && CFG.longOnlyPaper) ||
    (!CFG.paperMode && CFG.longOnlyLive)
  );
  if (sellBlocked) {
    const policyVar = CFG.paperMode ? 'LONG_ONLY_PAPER' : 'LONG_ONLY_LIVE';
    const modeLabel = CFG.paperMode ? 'paper' : 'live';
    const reason = `${policyVar}=true blocks new SELL entries`;
    ST.lastBlocked = { coin, label: signal.label, confidence: signal.confidence, reason, at: Date.now() };
    console.log(`ℹ️  Skipping ${coin} SELL entry in ${modeLabel} mode (${policyVar}=true)`);
    return false;
  }
  const risk = RISK[CFG.timeframe] || RISK['15m'];
  const entry = applySlippagePrice(markPrice, side, CFG.slippageEntryBps, 'entry');
  let tp = side === 'BUY' ? entry * (1 + risk.tp) : entry * (1 - risk.tp);
  let sl = side === 'BUY' ? entry * (1 - risk.sl) : entry * (1 + risk.sl);
  if (CFG.minTakeProfitUsd > 0 && usdSize > 0) {
    const minMovePct = CFG.minTakeProfitUsd / usdSize;
    if (side === 'BUY') {
      tp = Math.max(tp, entry * (1 + minMovePct));
    } else {
      tp = Math.min(tp, entry * (1 - minMovePct));
    }
  }

  if (CFG.paperMode) {
    if (ST.paperBalance < usdSize) {
      console.log(`⚠️  Insufficient paper balance ($${ST.paperBalance.toFixed(2)}) for $${usdSize.toFixed(2)} trade`);
      return false;
    }
    ST.paperBalance -= usdSize;
  } else {
    try { await placeCBOrder(coin, side, usdSize); }
    catch(e) {
      console.error(`❌ Order failed for ${coin}:`, e.message);
      ST.errors.push({ time: Date.now(), coin, msg: e.message });
      return false;
    }
  }

  const feeEntryUsd = usdSize * bpsToFraction(CFG.feeBps);
  ST.positions[coin] = {
    coin,
    side,
    size: +usdSize.toFixed(2),
    entry: +entry.toFixed(6),
    entryMark: +markPrice.toFixed(6),
    tp: +tp.toFixed(6),
    sl: +sl.toFixed(6),
    signal: signal.label,
    confidence: signal.confidence,
    opened: Date.now(),
    atrPctAtEntry: Number(signal?.indicators?.atrPct) || null,
    initialRiskPct: +(Math.abs(entry - sl) / entry).toFixed(6),
    peakPrice: +entry.toFixed(6),
    troughPrice: +entry.toFixed(6),
    breakEvenArmed: false,
    trailStopUpdates: 0,
    feeEntryUsd: +feeEntryUsd.toFixed(6),
    feesPaidUsd: +feeEntryUsd.toFixed(6),
    slippageEntryBps: CFG.slippageEntryBps,
  };
  ST.lastTradeAt = Date.now();
  ST.lastBlocked = null;
  const mode = CFG.paperMode ? '📄 PAPER' : '💰 LIVE';
  console.log(`${mode} OPEN  ${side.padEnd(4)} ${coin} @ fill $${entry.toFixed(4)} (mark $${markPrice.toFixed(4)}) | Size:$${usdSize.toFixed(2)} TP:$${tp.toFixed(4)} SL:$${sl.toFixed(4)}`);
  saveState();
  return true;
}

async function closePosition(coin, reason) {
  const pos = ST.positions[coin];
  if (!pos) return;

  const markPrice = await fetchPrice(coin);
  const pnlBreakdown = estimatePositionPnl(pos, markPrice, CFG.slippageExitBps);
  const grossPnl = pnlBreakdown.gross;
  const totalFees = pnlBreakdown.fees;
  const pnl = pnlBreakdown.net;
  const exit = pnlBreakdown.exitPrice || markPrice;

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

  const trade = {
    ...pos,
    exit: +exit.toFixed(6),
    exitMark: +markPrice.toFixed(6),
    grossPnl: +grossPnl.toFixed(4),
    feesUsd: +totalFees.toFixed(4),
    pnl: +pnl.toFixed(4),
    pnlPct: +((pnl / pos.size) * 100).toFixed(2),
    feeBps: CFG.feeBps,
    slippageExitBps: CFG.slippageExitBps,
    reason,
    closed: Date.now(),
  };
  ST.trades.unshift(trade);
  if (ST.trades.length > 100) ST.trades.pop();
  delete ST.positions[coin];
  ST.lastTradeAt = Date.now();

  const sign = pnl >= 0 ? '+' : '';
  console.log(`${CFG.paperMode ? '📄 PAPER' : '💰 LIVE'} CLOSE ${pos.side.padEnd(4)} ${coin} @ fill $${exit.toFixed(4)} (mark $${markPrice.toFixed(4)}) | Gross:${grossPnl >= 0 ? '+' : ''}$${grossPnl.toFixed(2)} Fees:$${totalFees.toFixed(2)} Net:${sign}$${pnl.toFixed(2)} (${reason})`);
  saveState();
}

function updateDynamicStops(pos, markPrice) {
  if (!pos || !Number.isFinite(+pos.entry) || !Number.isFinite(markPrice)) return false;
  let changed = false;
  const side = pos.side === 'SELL' ? 'SELL' : 'BUY';

  if (CFG.atrTrailEnabled && Number(pos.atrPctAtEntry) > 0 && CFG.atrTrailMult > 0) {
    const trailPct = (Number(pos.atrPctAtEntry) / 100) * CFG.atrTrailMult;
    if (trailPct > 0) {
      if (side === 'BUY') {
        const peak = Math.max(Number(pos.peakPrice || pos.entry), markPrice);
        if (!Number.isFinite(pos.peakPrice) || peak !== pos.peakPrice) {
          pos.peakPrice = +peak.toFixed(6);
          changed = true;
        }
        const trailSl = peak * (1 - trailPct);
        if (trailSl > pos.sl) {
          pos.sl = +trailSl.toFixed(6);
          pos.trailStopUpdates = (pos.trailStopUpdates || 0) + 1;
          changed = true;
        }
      } else {
        const trough = Math.min(Number(pos.troughPrice || pos.entry), markPrice);
        if (!Number.isFinite(pos.troughPrice) || trough !== pos.troughPrice) {
          pos.troughPrice = +trough.toFixed(6);
          changed = true;
        }
        const trailSl = trough * (1 + trailPct);
        if (trailSl < pos.sl) {
          pos.sl = +trailSl.toFixed(6);
          pos.trailStopUpdates = (pos.trailStopUpdates || 0) + 1;
          changed = true;
        }
      }
    }
  }

  if (!pos.breakEvenArmed && Number(pos.initialRiskPct) > 0 && CFG.breakEvenTriggerR > 0) {
    const movePct = side === 'BUY'
      ? (markPrice - pos.entry) / pos.entry
      : (pos.entry - markPrice) / pos.entry;
    const rNow = movePct / Number(pos.initialRiskPct);
    if (rNow >= CFG.breakEvenTriggerR) {
      const beOffset = bpsToFraction(CFG.breakEvenOffsetBps);
      const beSl = side === 'BUY'
        ? pos.entry * (1 + beOffset)
        : pos.entry * (1 - beOffset);
      if ((side === 'BUY' && beSl > pos.sl) || (side === 'SELL' && beSl < pos.sl)) {
        pos.sl = +beSl.toFixed(6);
        changed = true;
      }
      pos.breakEvenArmed = true;
      changed = true;
    }
  }

  return changed;
}

async function checkExits(coin) {
  const pos = ST.positions[coin];
  if (!pos) return;
  const price = await fetchPrice(coin);
  if (updateDynamicStops(pos, price)) saveState();
  const stopLossDisabled = CFG.paperMode && CFG.paperDisableStopLoss;
  if (pos.side === 'BUY') {
    if (price >= pos.tp) { await closePosition(coin, 'TAKE_PROFIT'); return; }
    if (!stopLossDisabled && price <= pos.sl) { await closePosition(coin, 'STOP_LOSS'); return; }
  } else {
    if (price <= pos.tp) { await closePosition(coin, 'TAKE_PROFIT'); return; }
    if (!stopLossDisabled && price >= pos.sl) { await closePosition(coin, 'STOP_LOSS'); return; }
  }
}

// ══════════════════════════════════════════════════════════════════
// MONITOR LOOP  (runs every LOOP_INTERVAL_SEC)
// ══════════════════════════════════════════════════════════════════
let monitorTimer = null;
let runCycleInProgress = false;

async function runCycle() {
  if (runCycleInProgress) return;
  runCycleInProgress = true;
  try {
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
        const sideHint = signal ? (signal.label.includes('BUY') ? 'BUY' : signal.label.includes('SELL') ? 'SELL' : 'HOLD') : 'HOLD';
        const dip = signal ? passDipFilter(candles, sideHint) : { ok: true, reason: 'n/a', movePct: null };
        if (signal) ST.signals[coin] = { ...signal, regime, dip, updatedAt: Date.now() };

        // Entry logic — only when auto-trading is on
        if (ST.tradingEnabled && signal) {
          const hasPos = !!ST.positions[coin];
          const isStrong = signal.label === 'STRONG_BUY' || signal.label === 'STRONG_SELL';
          const isDirectional = signal.label === 'BUY' || signal.label === 'SELL' || isStrong;
          const confidenceOk = signal.confidence >= CFG.minConfidence;
          const flowGate = passWalletFlowGate(coin, signal);
          const cooldownMs = Math.max(0, CFG.entryCooldownMin) * 60 * 1000;
          const lastEntryAt = ST.lastEntryAt[coin] || 0;
          const cooledDown = Date.now() - lastEntryAt >= cooldownMs;
          let blockReason = null;

          const shouldOpen = !hasPos && (
            CFG.activeMode
              ? (isDirectional && confidenceOk && cooledDown && regime.ok && dip.ok && flowGate.ok)
              : (isStrong && regime.ok && dip.ok && flowGate.ok)
          );

          if (shouldOpen) {
            const opened = await openPosition(coin, signal);
            if (opened) ST.lastEntryAt[coin] = Date.now();
          } else if (hasPos) {
            const pos = ST.positions[coin];
            const shouldClose = (pos.side === 'BUY'  && (signal.label === 'STRONG_SELL' || signal.label === 'SELL'))
                             || (pos.side === 'SELL' && (signal.label === 'STRONG_BUY'  || signal.label === 'BUY'));
            if (shouldClose) {
              const mark = signal.price || pos.entry;
              const pnlPreview = estimatePositionPnl(pos, mark, CFG.slippageExitBps);
              const pnlUsd = pnlPreview.net;
              if (CFG.signalCloseMinProfitUsd > 0 && pnlUsd < CFG.signalCloseMinProfitUsd) {
                ST.lastBlocked = {
                  coin,
                  label: signal.label,
                  confidence: signal.confidence,
                  reason: `Signal close blocked: net pnl $${pnlUsd.toFixed(2)} < $${CFG.signalCloseMinProfitUsd.toFixed(2)}`,
                  at: Date.now(),
                };
              } else {
                await closePosition(coin, 'SIGNAL_REVERSAL');
              }
            }
          } else {
            if (CFG.activeMode) {
              if (!isDirectional) blockReason = `Signal ${signal.label} (needs BUY/SELL)`;
              else if (!confidenceOk) blockReason = `Confidence ${signal.confidence}% < ${CFG.minConfidence}%`;
              else if (!cooledDown) {
                const msRemaining = Math.max(0, cooldownMs - (Date.now() - lastEntryAt));
                const minsRemaining = Math.max(1, Math.ceil(msRemaining / 60000));
                blockReason = `Cooldown active (${minsRemaining}m remaining)`;
              } else if (!dip.ok) blockReason = `Dip filter: ${dip.reason}`;
              else if (!flowGate.ok) blockReason = `Wallet flow: ${flowGate.reason}`;
              else if (!regime.ok) blockReason = `Regime blocked: ${regime.reason}`;
            } else {
              if (!isStrong) blockReason = `Classic mode: waiting STRONG_* (got ${signal.label})`;
              else if (!dip.ok) blockReason = `Dip filter: ${dip.reason}`;
              else if (!flowGate.ok) blockReason = `Wallet flow: ${flowGate.reason}`;
              else if (!regime.ok) blockReason = `Regime blocked: ${regime.reason}`;
            }
            if (blockReason) {
              ST.lastBlocked = {
                coin,
                label: signal.label,
                confidence: signal.confidence,
                reason: blockReason,
                at: Date.now(),
              };
            }
          }
        }
      } catch(e) {
        console.error(`⚠️  Cycle error [${coin}]:`, e.message);
        ST.errors.push({ time: Date.now(), coin, msg: e.message });
        if (ST.errors.length > 25) ST.errors.shift();
      }
    }
  } finally {
    runCycleInProgress = false;
  }
}

function startMonitor() {
  if (monitorTimer) return;
  console.log(`🔄 Monitor starting — checking every ${CFG.loopIntervalSec}s on [${CFG.watchedCoins.join(', ')}]`);
  runCycle(); // immediate first run
  monitorTimer = setInterval(runCycle, CFG.loopIntervalSec * 1000);
}

function restartMonitorInterval() {
  if (!monitorTimer) return;
  clearInterval(monitorTimer);
  monitorTimer = setInterval(runCycle, CFG.loopIntervalSec * 1000);
  console.log(`🔁 Monitor interval updated to ${CFG.loopIntervalSec}s`);
}
startMonitor();

// ══════════════════════════════════════════════════════════════════
// PORTFOLIO P&L HELPER
// ══════════════════════════════════════════════════════════════════
async function getLivePnL() {
  let unrealized = 0;
  let unrealizedGross = 0;
  let unrealizedFees = 0;
  for (const [coin, pos] of Object.entries(ST.positions)) {
    try {
      const price = await fetchPrice(coin);
      const est = estimatePositionPnl(pos, price, CFG.slippageExitBps);
      unrealized += est.net;
      unrealizedGross += est.gross;
      unrealizedFees += est.fees;
    } catch(e) {}
  }
  const realized = ST.trades.reduce((a, t) => a + safeNum(t.pnl, 0), 0);
  const realizedGross = ST.trades.reduce((a, t) => a + safeNum(t.grossPnl, safeNum(t.pnl, 0)), 0);
  const realizedFees = ST.trades.reduce((a, t) => a + safeNum(t.feesUsd, 0), 0);
  const wins     = ST.trades.filter(t => t.pnl > 0).length;
  const total    = ST.trades.length;
  const totalGross = unrealizedGross + realizedGross;
  const totalFees = unrealizedFees + realizedFees;
  return {
    unrealized: +unrealized.toFixed(2),
    unrealizedGross: +unrealizedGross.toFixed(2),
    unrealizedFees: +unrealizedFees.toFixed(2),
    realized:   +realized.toFixed(2),
    realizedGross: +realizedGross.toFixed(2),
    realizedFees: +realizedFees.toFixed(2),
    total:      +(unrealized + realized).toFixed(2),
    totalGross: +totalGross.toFixed(2),
    totalFees: +totalFees.toFixed(2),
    winRate:    total > 0 ? +((wins / total) * 100).toFixed(1) : null,
    tradeCount: total,
  };
}

function getRuntimeSettings() {
  return {
    feeBps: CFG.feeBps,
    slippageEntryBps: CFG.slippageEntryBps,
    slippageExitBps: CFG.slippageExitBps,
    atrTrailEnabled: CFG.atrTrailEnabled,
    atrTrailMult: CFG.atrTrailMult,
    breakEvenTriggerR: CFG.breakEvenTriggerR,
    breakEvenOffsetBps: CFG.breakEvenOffsetBps,
    loopIntervalSec: CFG.loopIntervalSec,
  };
}

function getReservedCapital() {
  return Object.values(ST.positions).reduce((sum, pos) => sum + (+pos.size || 0), 0);
}

async function resolveTradeSizeUsd() {
  // Percent-based sizing takes precedence when configured.
  if (CFG.tradeSizePct > 0) {
    const pct = CFG.tradeSizePct / 100;
    const basis = CFG.paperMode ? ST.paperBalance : await getCBBalance('USD');
    let size = basis * pct;
    if (CFG.tradeSizeMinUsd > 0) size = Math.max(size, CFG.tradeSizeMinUsd);
    if (CFG.tradeSizeMaxUsd > 0) size = Math.min(size, CFG.tradeSizeMaxUsd);
    return +size.toFixed(2);
  }
  return +CFG.tradeSize;
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
    'entryMark',
    'entry',
    'exitMark',
    'exit',
    'grossPnlUsd',
    'feesUsd',
    'netPnlUsd',
    'pnlPct',
    'feeBps',
    'entrySlipBps',
    'exitSlipBps',
    'atrPctAtEntry',
    'trailStopUpdates',
    'breakEvenArmed',
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
      t.entryMark,
      t.entry,
      t.exitMark,
      t.exit,
      t.grossPnl,
      t.feesUsd,
      t.pnl,
      t.pnlPct,
      t.feeBps,
      t.slippageEntryBps,
      t.slippageExitBps,
      t.atrPctAtEntry,
      t.trailStopUpdates,
      t.breakEvenArmed,
      t.confidence,
      durationMin != null ? +durationMin.toFixed(2) : '',
    ];
    lines.push(row.map(csvEscape).join(','));
  }
  return lines.join('\n');
}

function computeTradeMetrics(trades) {
  const pnls = trades.map(t => safeNum(t.pnl, 0));
  const grossPnls = trades.map(t => safeNum(t.grossPnl, safeNum(t.pnl, 0)));
  const fees = trades.map(t => safeNum(t.feesUsd, 0));
  const n = pnls.length;
  const wins = pnls.filter(v => v > 0);
  const losses = pnls.filter(v => v < 0);
  const totalPnl = pnls.reduce((a, b) => a + b, 0);
  const totalGrossPnl = grossPnls.reduce((a, b) => a + b, 0);
  const totalFees = fees.reduce((a, b) => a + b, 0);
  const avgPnl = n ? totalPnl / n : 0;
  const avgGrossPnl = n ? totalGrossPnl / n : 0;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const winRate = n ? (wins.length / n) * 100 : null;
  const profitFactor = losses.length ? (wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))) : null;

  // Max drawdown on cumulative realized PnL (chronological order).
  let cumulative = 0, peak = 0, maxDrawdown = 0;
  for (const p of pnls) {
    cumulative += p;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }

  return {
    tradeCount: n,
    totalPnl: +totalPnl.toFixed(4),
    totalGrossPnl: +totalGrossPnl.toFixed(4),
    totalFees: +totalFees.toFixed(4),
    expectancy: +avgPnl.toFixed(4),
    grossExpectancy: +avgGrossPnl.toFixed(4),
    avgPnl: +avgPnl.toFixed(4),
    winRate: winRate == null ? null : +winRate.toFixed(2),
    avgWin: +avgWin.toFixed(4),
    avgLoss: +avgLoss.toFixed(4),
    profitFactor: profitFactor == null ? null : +profitFactor.toFixed(4),
    maxDrawdown: +maxDrawdown.toFixed(4),
  };
}

function calcRollingWindow(slice) {
  const pnls = slice.map(t => safeNum(t.pnl, 0));
  const grossPnls = slice.map(t => safeNum(t.grossPnl, safeNum(t.pnl, 0)));
  const fees = slice.map(t => safeNum(t.feesUsd, 0));
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const total = pnls.reduce((a, b) => a + b, 0);
  const totalGross = grossPnls.reduce((a, b) => a + b, 0);
  const totalFees = fees.reduce((a, b) => a + b, 0);
  const count = pnls.length;
  const winRate = count ? (wins.length / count) * 100 : null;
  const avgPnl = count ? total / count : null;
  const avgGross = count ? totalGross / count : null;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : null;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : null;
  const profitFactor = losses.length
    ? wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))
    : null;

  let eq = 0, peak = 0, maxDD = 0;
  for (const p of pnls) {
    eq += p;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    count,
    totalPnl: +total.toFixed(4),
    totalGrossPnl: +totalGross.toFixed(4),
    totalFees: +totalFees.toFixed(4),
    winRate: winRate == null ? null : +winRate.toFixed(2),
    expectancy: avgPnl == null ? null : +avgPnl.toFixed(4),
    grossExpectancy: avgGross == null ? null : +avgGross.toFixed(4),
    avgWin: avgWin == null ? null : +avgWin.toFixed(4),
    avgLoss: avgLoss == null ? null : +avgLoss.toFixed(4),
    profitFactor: profitFactor == null ? null : +profitFactor.toFixed(4),
    maxDrawdown: +maxDD.toFixed(4),
    from: slice[0]?.closed || null,
    to: slice[slice.length - 1]?.closed || null,
  };
}

function parseBoolParam(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function parseNumParam(v, fallback, min = null, max = null) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (min !== null) out = Math.max(min, out);
  if (max !== null) out = Math.min(max, out);
  return out;
}

function parseCsvList(v, fallback = []) {
  if (v === undefined || v === null || String(v).trim() === '') return fallback;
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function normalizeTimeframe(tf) {
  return TF_GRAN[tf] ? tf : CFG.timeframe;
}

function getRiskForTimeframe(tf) {
  return RISK[normalizeTimeframe(tf)] || RISK['15m'];
}

function buildBacktestConfigFromQuery(q = {}) {
  const timeframe = normalizeTimeframe(q.timeframe || CFG.timeframe);
  const watchedCoins = parseCsvList(q.coins || q.watchedCoins, CFG.watchedCoins).slice(0, 16);
  const tradeSizeUsd = parseNumParam(
    q.tradeSizeUsd ?? q.tradeSize ?? q.size,
    CFG.tradeSizePct > 0 ? Math.max(CFG.tradeSizeMinUsd || 0, CFG.tradeSize || 50) : CFG.tradeSize,
    1,
    50000
  );

  return {
    name: String(q.name || 'custom'),
    timeframe,
    watchedCoins,
    candles: Math.round(parseNumParam(q.candles, 700, 120, 2200)),
    startBalance: parseNumParam(q.startBalance, 1000, 100, 1000000),
    maxPositions: Math.round(parseNumParam(q.maxPositions, CFG.maxPositions, 1, 20)),
    dailyLossLimit: parseNumParam(q.dailyLossLimit, CFG.dailyLossLimit, 0, 100000),
    activeMode: parseBoolParam(q.activeMode, CFG.activeMode),
    minConfidence: Math.round(parseNumParam(q.minConfidence, CFG.minConfidence, 0, 100)),
    entryCooldownMin: Math.round(parseNumParam(q.entryCooldownMin, CFG.entryCooldownMin, 0, 240)),
    buyScoreThreshold: parseNumParam(q.buyScoreThreshold, CFG.buyScoreThreshold, 0.01, 0.95),
    strongScoreThreshold: parseNumParam(q.strongScoreThreshold, CFG.strongScoreThreshold, 0.02, 0.99),
    dipBuyEnabled: parseBoolParam(q.dipBuyEnabled, CFG.dipBuyEnabled),
    dipLookbackCandles: Math.round(parseNumParam(q.dipLookbackCandles, CFG.dipLookbackCandles, 2, 60)),
    minDipPct: parseNumParam(q.minDipPct, CFG.minDipPct, 0, 50),
    minTakeProfitUsd: parseNumParam(q.minTakeProfitUsd, CFG.minTakeProfitUsd, 0, 10000),
    signalCloseMinProfitUsd: parseNumParam(q.signalCloseMinProfitUsd, CFG.signalCloseMinProfitUsd, 0, 10000),
    paperDisableStopLoss: parseBoolParam(q.paperDisableStopLoss, CFG.paperDisableStopLoss),
    regimeFilter: parseBoolParam(q.regimeFilter, CFG.regimeFilter),
    minEmaGapPct: parseNumParam(q.minEmaGapPct, CFG.minEmaGapPct, 0, 20),
    minAtrPct: parseNumParam(q.minAtrPct, CFG.minAtrPct, 0, 20),
    regimeRequireEmaAlignment: parseBoolParam(q.regimeRequireEmaAlignment, CFG.regimeRequireEmaAlignment),
    longOnlyPaper: parseBoolParam(q.longOnlyPaper, CFG.longOnlyPaper),
    tradeSizeUsd,
    feeBps: parseNumParam(q.feeBps, CFG.feeBps, 0, 1000),
    slippageEntryBps: parseNumParam(q.slippageEntryBps, CFG.slippageEntryBps, 0, 1000),
    slippageExitBps: parseNumParam(q.slippageExitBps, CFG.slippageExitBps, 0, 1000),
    atrTrailEnabled: parseBoolParam(q.atrTrailEnabled, CFG.atrTrailEnabled),
    atrTrailMult: parseNumParam(q.atrTrailMult, CFG.atrTrailMult, 0, 10),
    breakEvenTriggerR: parseNumParam(q.breakEvenTriggerR, CFG.breakEvenTriggerR, 0, 10),
    breakEvenOffsetBps: parseNumParam(q.breakEvenOffsetBps, CFG.breakEvenOffsetBps, 0, 500),
  };
}

function passRegimeFilterForConfig(signal, cfg) {
  if (!cfg.regimeFilter) return { ok: true, reason: 'disabled' };
  const ind = signal.indicators || {};
  const emaGapPct = ind.emaGapPct ?? 0;
  const atrPct = ind.atrPct ?? 0;
  const side = signal.label.includes('BUY') ? 'BUY' : signal.label.includes('SELL') ? 'SELL' : 'HOLD';

  if (emaGapPct < cfg.minEmaGapPct) {
    return { ok: false, reason: `emaGap ${emaGapPct.toFixed(3)}% < ${cfg.minEmaGapPct}%` };
  }
  if (atrPct < cfg.minAtrPct) {
    return { ok: false, reason: `atr ${atrPct.toFixed(3)}% < ${cfg.minAtrPct}%` };
  }
  if (cfg.regimeRequireEmaAlignment) {
    if (side === 'BUY' && !(ind.ema9 > ind.ema21)) return { ok: false, reason: 'BUY signal not aligned with EMA trend' };
    if (side === 'SELL' && !(ind.ema9 < ind.ema21)) return { ok: false, reason: 'SELL signal not aligned with EMA trend' };
  }
  return { ok: true, reason: 'ok' };
}

function passDipFilterForConfig(candles, side, cfg) {
  if (!cfg.dipBuyEnabled) return { ok: true, reason: 'disabled', movePct: null };
  const lb = Math.max(2, cfg.dipLookbackCandles || 2);
  if (!candles || candles.length < lb + 1) return { ok: false, reason: 'insufficient candles', movePct: null };

  const hist = candles.slice(-(lb + 1), -1);
  const closes = hist.map(c => c.close);
  const cur = candles[candles.length - 1].close;
  const windowHigh = Math.max(...closes);
  const windowLow = Math.min(...closes);

  if (side === 'BUY') {
    const dipPct = windowHigh > 0 ? ((windowHigh - cur) / windowHigh) * 100 : 0;
    if (dipPct < cfg.minDipPct) return { ok: false, reason: `dip ${dipPct.toFixed(3)}% < ${cfg.minDipPct}%`, movePct: +dipPct.toFixed(4) };
    return { ok: true, reason: 'ok', movePct: +dipPct.toFixed(4) };
  }
  if (side === 'SELL') {
    const rallyPct = windowLow > 0 ? ((cur - windowLow) / windowLow) * 100 : 0;
    if (rallyPct < cfg.minDipPct) return { ok: false, reason: `rally ${rallyPct.toFixed(3)}% < ${cfg.minDipPct}%`, movePct: +rallyPct.toFixed(4) };
    return { ok: true, reason: 'ok', movePct: +rallyPct.toFixed(4) };
  }
  return { ok: true, reason: 'n/a', movePct: null };
}

function generateSignalForConfig(candles, cfg) {
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
  const risk = getRiskForTimeframe(cfg.timeframe);
  const buyT = Math.max(0.01, Math.min(0.95, Math.abs(cfg.buyScoreThreshold)));
  const strongT = Math.max(buyT + 0.01, Math.min(0.99, Math.abs(cfg.strongScoreThreshold)));
  const label = norm > strongT ? 'STRONG_BUY' : norm > buyT ? 'BUY'
    : norm < -strongT ? 'STRONG_SELL' : norm < -buyT ? 'SELL' : 'HOLD';
  return {
    label,
    confidence: Math.round(Math.abs(norm) * 100),
    score: +norm.toFixed(3),
    price: cur,
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

function estimatePositionPnlWithConfig(pos, exitMarkPrice, cfg) {
  if (!pos || !Number.isFinite(+pos.entry) || !Number.isFinite(+pos.size) || !Number.isFinite(exitMarkPrice)) {
    return { gross: 0, fees: 0, net: 0, exitPrice: null };
  }
  const side = pos.side === 'SELL' ? 'SELL' : 'BUY';
  const entry = +pos.entry;
  const size = +pos.size;
  const exitPrice = applySlippagePrice(exitMarkPrice, side, cfg.slippageExitBps, 'exit');
  const gross = side === 'BUY'
    ? ((exitPrice - entry) / entry) * size
    : ((entry - exitPrice) / entry) * size;
  const entryFee = safeNum(pos.feeEntryUsd, 0);
  const exitFee = size * bpsToFraction(cfg.feeBps);
  const fees = entryFee + exitFee;
  const net = gross - fees;
  return { gross, fees, net, exitPrice };
}

function updateDynamicStopsForConfig(pos, markPrice, cfg) {
  if (!pos || !Number.isFinite(+pos.entry) || !Number.isFinite(markPrice)) return false;
  let changed = false;
  const side = pos.side === 'SELL' ? 'SELL' : 'BUY';

  if (cfg.atrTrailEnabled && Number(pos.atrPctAtEntry) > 0 && cfg.atrTrailMult > 0) {
    const trailPct = (Number(pos.atrPctAtEntry) / 100) * cfg.atrTrailMult;
    if (trailPct > 0) {
      if (side === 'BUY') {
        const peak = Math.max(Number(pos.peakPrice || pos.entry), markPrice);
        if (!Number.isFinite(pos.peakPrice) || peak !== pos.peakPrice) {
          pos.peakPrice = +peak.toFixed(6);
          changed = true;
        }
        const trailSl = peak * (1 - trailPct);
        if (trailSl > pos.sl) {
          pos.sl = +trailSl.toFixed(6);
          pos.trailStopUpdates = (pos.trailStopUpdates || 0) + 1;
          changed = true;
        }
      } else {
        const trough = Math.min(Number(pos.troughPrice || pos.entry), markPrice);
        if (!Number.isFinite(pos.troughPrice) || trough !== pos.troughPrice) {
          pos.troughPrice = +trough.toFixed(6);
          changed = true;
        }
        const trailSl = trough * (1 + trailPct);
        if (trailSl < pos.sl) {
          pos.sl = +trailSl.toFixed(6);
          pos.trailStopUpdates = (pos.trailStopUpdates || 0) + 1;
          changed = true;
        }
      }
    }
  }

  if (!pos.breakEvenArmed && Number(pos.initialRiskPct) > 0 && cfg.breakEvenTriggerR > 0) {
    const movePct = side === 'BUY'
      ? (markPrice - pos.entry) / pos.entry
      : (pos.entry - markPrice) / pos.entry;
    const rNow = movePct / Number(pos.initialRiskPct);
    if (rNow >= cfg.breakEvenTriggerR) {
      const beOffset = bpsToFraction(cfg.breakEvenOffsetBps);
      const beSl = side === 'BUY'
        ? pos.entry * (1 + beOffset)
        : pos.entry * (1 - beOffset);
      if ((side === 'BUY' && beSl > pos.sl) || (side === 'SELL' && beSl < pos.sl)) {
        pos.sl = +beSl.toFixed(6);
        changed = true;
      }
      pos.breakEvenArmed = true;
      changed = true;
    }
  }
  return changed;
}

function summarizeTradesByCoin(trades) {
  const byCoin = {};
  for (const t of trades) {
    if (!byCoin[t.coin]) byCoin[t.coin] = [];
    byCoin[t.coin].push(t);
  }
  return Object.entries(byCoin)
    .map(([coin, coinTrades]) => ({
      coin,
      ...computeTradeMetrics(coinTrades),
    }))
    .sort((a, b) => (b.totalPnl || 0) - (a.totalPnl || 0));
}

function scoreBacktestOutcome(result) {
  const m = result?.metrics || {};
  const trades = safeNum(m.tradeCount, 0);
  const score =
    safeNum(m.totalPnl, 0) +
    safeNum(m.expectancy, 0) * 40 +
    safeNum(m.profitFactor, 0) * 8 +
    safeNum(m.winRate, 0) * 0.15 -
    safeNum(m.maxDrawdown, 0) * 0.6 -
    Math.max(0, 20 - trades) * 0.5;
  return +score.toFixed(4);
}

function runSingleBacktest(cfg, historyByCoin, opts = {}) {
  const coins = (cfg.watchedCoins || []).filter(c => Array.isArray(historyByCoin[c]) && historyByCoin[c].length > 40);
  if (!coins.length) return { ok: false, error: 'No valid coin history for backtest' };

  const minLen = Math.min(...coins.map(c => historyByCoin[c].length));
  const warmup = Math.max(35, cfg.dipLookbackCandles + 2);
  const startIndex = Math.max(warmup, Math.floor(parseNumParam(opts.startIndex, warmup, warmup, minLen - 1)));
  const endIndex = Math.max(startIndex + 1, Math.min(minLen, Math.floor(parseNumParam(opts.endIndex, minLen, startIndex + 1, minLen))));
  const forceCloseAtEnd = parseBoolParam(opts.forceCloseAtEnd, true);

  let balance = cfg.startBalance;
  const positions = {};
  const lastEntryAt = {};
  const trades = [];
  const equityCurve = [];
  let dailyLoss = 0;
  let dayKey = null;
  let pausedByDailyLoss = false;
  let blockedByDailyLossCount = 0;
  const blockCounts = { confidence: 0, cooldown: 0, regime: 0, dip: 0, policy: 0, hold: 0 };

  const closeSimPosition = (coin, markPrice, reason, atMs) => {
    const pos = positions[coin];
    if (!pos) return null;
    const est = estimatePositionPnlWithConfig(pos, markPrice, cfg);
    const pnl = est.net;
    balance += pos.size + pnl;
    if (pnl < 0) {
      dailyLoss += Math.abs(pnl);
      if (cfg.dailyLossLimit > 0 && dailyLoss >= cfg.dailyLossLimit) pausedByDailyLoss = true;
    }
    const trade = {
      ...pos,
      exit: +(est.exitPrice || markPrice).toFixed(6),
      exitMark: +markPrice.toFixed(6),
      grossPnl: +est.gross.toFixed(4),
      feesUsd: +est.fees.toFixed(4),
      pnl: +pnl.toFixed(4),
      pnlPct: +((pnl / pos.size) * 100).toFixed(2),
      reason,
      closed: atMs,
    };
    trades.push(trade);
    delete positions[coin];
    return trade;
  };

  for (let i = startIndex; i < endIndex; i++) {
    for (const coin of coins) {
      const series = historyByCoin[coin];
      const bar = series[i];
      if (!bar) continue;
      const tsMs = bar.time * 1000;
      const curDay = new Date(tsMs).toDateString();
      if (dayKey !== curDay) {
        dayKey = curDay;
        dailyLoss = 0;
        pausedByDailyLoss = false;
      }

      const markPrice = bar.close;
      const hasPos = !!positions[coin];

      if (hasPos) {
        const pos = positions[coin];
        updateDynamicStopsForConfig(pos, markPrice, cfg);
        const stopLossDisabled = !!cfg.paperDisableStopLoss;
        if (pos.side === 'BUY') {
          if (markPrice >= pos.tp) { closeSimPosition(coin, markPrice, 'TAKE_PROFIT', tsMs); continue; }
          if (!stopLossDisabled && markPrice <= pos.sl) { closeSimPosition(coin, markPrice, 'STOP_LOSS', tsMs); continue; }
        } else {
          if (markPrice <= pos.tp) { closeSimPosition(coin, markPrice, 'TAKE_PROFIT', tsMs); continue; }
          if (!stopLossDisabled && markPrice >= pos.sl) { closeSimPosition(coin, markPrice, 'STOP_LOSS', tsMs); continue; }
        }
      }

      const candles = series.slice(0, i + 1);
      const signal = generateSignalForConfig(candles, cfg);
      if (!signal) continue;
      const sideHint = signal.label.includes('BUY') ? 'BUY' : signal.label.includes('SELL') ? 'SELL' : 'HOLD';
      const regime = passRegimeFilterForConfig(signal, cfg);
      const dip = passDipFilterForConfig(candles, sideHint, cfg);
      const isStrong = signal.label === 'STRONG_BUY' || signal.label === 'STRONG_SELL';
      const isDirectional = signal.label === 'BUY' || signal.label === 'SELL' || isStrong;
      const confidenceOk = signal.confidence >= cfg.minConfidence;
      const cooldownMs = Math.max(0, cfg.entryCooldownMin) * 60 * 1000;
      const cooledDown = tsMs - (lastEntryAt[coin] || 0) >= cooldownMs;
      const side = sideHint;
      const sellPolicyBlocked = side === 'SELL' && cfg.longOnlyPaper;

      if (positions[coin]) {
        const pos = positions[coin];
        const shouldClose = (pos.side === 'BUY' && (signal.label === 'SELL' || signal.label === 'STRONG_SELL'))
          || (pos.side === 'SELL' && (signal.label === 'BUY' || signal.label === 'STRONG_BUY'));
        if (shouldClose) {
          const preview = estimatePositionPnlWithConfig(pos, markPrice, cfg);
          if (cfg.signalCloseMinProfitUsd <= 0 || preview.net >= cfg.signalCloseMinProfitUsd) {
            closeSimPosition(coin, markPrice, 'SIGNAL_REVERSAL', tsMs);
          }
        }
        continue;
      }

      if (pausedByDailyLoss) {
        blockedByDailyLossCount += 1;
        continue;
      }

      const shouldOpen = cfg.activeMode
        ? (isDirectional && confidenceOk && cooledDown && regime.ok && dip.ok)
        : (isStrong && cooledDown && regime.ok && dip.ok);

      if (!shouldOpen) {
        if (!isDirectional) blockCounts.hold += 1;
        else if (!confidenceOk) blockCounts.confidence += 1;
        else if (!cooledDown) blockCounts.cooldown += 1;
        else if (!dip.ok) blockCounts.dip += 1;
        else if (!regime.ok) blockCounts.regime += 1;
        continue;
      }
      if (sellPolicyBlocked) {
        blockCounts.policy += 1;
        continue;
      }
      if (Object.keys(positions).length >= cfg.maxPositions) continue;

      const size = cfg.tradeSizeUsd;
      if (!Number.isFinite(size) || size <= 0 || balance < size) continue;
      const entry = applySlippagePrice(markPrice, side, cfg.slippageEntryBps, 'entry');
      const risk = getRiskForTimeframe(cfg.timeframe);
      let tp = side === 'BUY' ? entry * (1 + risk.tp) : entry * (1 - risk.tp);
      let sl = side === 'BUY' ? entry * (1 - risk.sl) : entry * (1 + risk.sl);
      if (cfg.minTakeProfitUsd > 0) {
        const minMovePct = cfg.minTakeProfitUsd / size;
        tp = side === 'BUY'
          ? Math.max(tp, entry * (1 + minMovePct))
          : Math.min(tp, entry * (1 - minMovePct));
      }

      balance -= size;
      const feeEntryUsd = size * bpsToFraction(cfg.feeBps);
      positions[coin] = {
        coin,
        side,
        size: +size.toFixed(2),
        entry: +entry.toFixed(6),
        entryMark: +markPrice.toFixed(6),
        tp: +tp.toFixed(6),
        sl: +sl.toFixed(6),
        signal: signal.label,
        confidence: signal.confidence,
        opened: tsMs,
        atrPctAtEntry: Number(signal?.indicators?.atrPct) || null,
        initialRiskPct: +(Math.abs(entry - sl) / entry).toFixed(6),
        peakPrice: +entry.toFixed(6),
        troughPrice: +entry.toFixed(6),
        breakEvenArmed: false,
        trailStopUpdates: 0,
        feeEntryUsd: +feeEntryUsd.toFixed(6),
        slippageEntryBps: cfg.slippageEntryBps,
        feeBps: cfg.feeBps,
      };
      lastEntryAt[coin] = tsMs;
    }

    let equity = balance;
    for (const coin of Object.keys(positions)) {
      const pos = positions[coin];
      const bar = historyByCoin[coin][i];
      if (!bar) continue;
      const est = estimatePositionPnlWithConfig(pos, bar.close, cfg);
      equity += pos.size + est.net;
    }
    equityCurve.push({ t: historyByCoin[coins[0]][i].time * 1000, equity: +equity.toFixed(4) });
  }

  if (forceCloseAtEnd) {
    const idx = endIndex - 1;
    for (const coin of Object.keys(positions)) {
      const bar = historyByCoin[coin][idx];
      if (bar) closeSimPosition(coin, bar.close, 'END_OF_TEST', bar.time * 1000);
    }
  }

  const metrics = computeTradeMetrics(trades);
  const finalBalance = +balance.toFixed(4);
  const roiPct = cfg.startBalance > 0 ? +(((finalBalance - cfg.startBalance) / cfg.startBalance) * 100).toFixed(2) : null;
  const eqVals = equityCurve.map(p => p.equity);
  const equitySummary = eqVals.length
    ? { first: +eqVals[0].toFixed(4), last: +eqVals[eqVals.length - 1].toFixed(4), min: +Math.min(...eqVals).toFixed(4), max: +Math.max(...eqVals).toFixed(4) }
    : null;

  return {
    ok: true,
    config: cfg,
    coinCount: coins.length,
    candlesPerCoin: minLen,
    startIndex,
    endIndex,
    blockedByDailyLossCount,
    blockCounts,
    tradeCount: trades.length,
    startBalance: +cfg.startBalance.toFixed(2),
    finalBalance,
    roiPct,
    metrics,
    equitySummary,
    perCoin: summarizeTradesByCoin(trades),
    trades,
  };
}

function buildProfileCandidates(baseCfg) {
  const baseCoins = (baseCfg.watchedCoins || CFG.watchedCoins).slice(0, 10);
  return [
    {
      ...baseCfg,
      name: 'stability-v1',
      timeframe: '5m',
      watchedCoins: baseCoins.slice(0, Math.min(baseCoins.length, 4)),
      minConfidence: 14,
      entryCooldownMin: 3,
      buyScoreThreshold: 0.1,
      strongScoreThreshold: 0.25,
      regimeFilter: true,
      minEmaGapPct: 0.05,
      minAtrPct: 0.1,
      regimeRequireEmaAlignment: false,
      dipBuyEnabled: false,
      maxPositions: 2,
      longOnlyPaper: true,
    },
    {
      ...baseCfg,
      name: 'balanced-v1',
      timeframe: '5m',
      watchedCoins: baseCoins.slice(0, Math.min(baseCoins.length, 6)),
      minConfidence: 12,
      entryCooldownMin: 2,
      buyScoreThreshold: 0.09,
      strongScoreThreshold: 0.22,
      regimeFilter: true,
      minEmaGapPct: 0.04,
      minAtrPct: 0.09,
      dipBuyEnabled: false,
      maxPositions: 3,
      longOnlyPaper: false,
    },
    {
      ...baseCfg,
      name: 'active-v1',
      timeframe: '1m',
      watchedCoins: baseCoins,
      minConfidence: 11,
      entryCooldownMin: 1,
      buyScoreThreshold: 0.08,
      strongScoreThreshold: 0.2,
      regimeFilter: true,
      minEmaGapPct: 0.03,
      minAtrPct: 0.1,
      dipBuyEnabled: false,
      maxPositions: 4,
      longOnlyPaper: false,
    },
  ];
}

function runWalkForward(cfg, historyByCoin, windowCount = 4) {
  const coins = (cfg.watchedCoins || []).filter(c => Array.isArray(historyByCoin[c]) && historyByCoin[c].length > 40);
  if (!coins.length) {
    return { ok: false, error: 'No valid coin history for walk-forward' };
  }
  const minLen = Math.min(...coins.map(c => historyByCoin[c].length));
  const warmup = Math.max(35, cfg.dipLookbackCandles + 2);
  const usable = minLen - warmup;
  const windows = Math.max(2, Math.min(12, Math.round(windowCount)));
  const segment = Math.floor(usable / windows);
  if (!Number.isFinite(segment) || segment < 20) {
    return { ok: false, error: `Not enough data for walk-forward (${usable} usable candles)` };
  }

  const results = [];
  for (let i = 0; i < windows; i++) {
    const start = warmup + i * segment;
    const end = i === windows - 1 ? minLen : start + segment;
    const r = runSingleBacktest(cfg, historyByCoin, { startIndex: start, endIndex: end, forceCloseAtEnd: true });
    const score = scoreBacktestOutcome(r);
    results.push({
      window: i + 1,
      startIndex: start,
      endIndex: end,
      score,
      tradeCount: r.tradeCount,
      totalPnl: r.metrics?.totalPnl ?? 0,
      winRate: r.metrics?.winRate ?? null,
      profitFactor: r.metrics?.profitFactor ?? null,
      maxDrawdown: r.metrics?.maxDrawdown ?? null,
      result: r,
    });
  }

  const scores = results.map(r => r.score);
  const positiveWindows = results.filter(r => (r.totalPnl || 0) > 0).length;
  const allTrades = results.flatMap(r => r.result?.trades || []);
  const combinedMetrics = computeTradeMetrics(allTrades);

  return {
    ok: true,
    windows,
    segmentSize: segment,
    positiveWindows,
    consistencyPct: +((positiveWindows / windows) * 100).toFixed(2),
    avgScore: +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(4),
    combinedMetrics,
    windowResults: results.map(r => ({
      window: r.window,
      score: r.score,
      tradeCount: r.tradeCount,
      totalPnl: r.totalPnl,
      winRate: r.winRate,
      profitFactor: r.profitFactor,
      maxDrawdown: r.maxDrawdown,
      startIndex: r.startIndex,
      endIndex: r.endIndex,
    })),
  };
}

async function fetchCandlesHistory(productId, tf, wantedCandles = 700) {
  const gran = TF_GRAN[tf] || 900;
  const wanted = Math.max(120, Math.min(2200, Math.round(wantedCandles)));
  const pageSize = 300;
  const maxPages = Math.ceil(wanted / pageSize) + 1;
  let endMs = Date.now();
  const byTime = new Map();

  for (let page = 0; page < maxPages; page++) {
    const startMs = endMs - gran * pageSize * 1000;
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const url = `${CB_PUB}/products/${productId}/candles?granularity=${gran}&start=${startIso}&end=${endIso}`;
    const raw = await fetchJSONWithRetry(url, { attempts: 2, timeoutMs: 12000 });
    if (Array.isArray(raw)) {
      for (const c of raw) {
        const t = Number(c[0]);
        if (!Number.isFinite(t)) continue;
        if (!byTime.has(t)) {
          byTime.set(t, { time: t, low: +c[1], high: +c[2], open: +c[3], close: +c[4], volume: +c[5] });
        }
      }
    }
    if (byTime.size >= wanted) break;
    endMs = startMs - gran * 1000;
    await sleep(120);
  }

  return [...byTime.values()].sort((a, b) => a.time - b.time).slice(-wanted);
}

async function loadBacktestHistory(coins, timeframe, candles) {
  const out = {};
  for (const coin of coins) {
    try {
      out[coin] = await fetchCandlesHistory(coin, timeframe, candles);
      await sleep(80);
    } catch (e) {
      out[coin] = [];
    }
  }
  return out;
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
  const effectiveTradeSizeUsd = await resolveTradeSizeUsd();
  const runtime = getRuntimeSettings();
  res.json({
    paperMode:      CFG.paperMode,
    tradingEnabled: ST.tradingEnabled,
    activeMode:     CFG.activeMode,
    minConfidence:  CFG.minConfidence,
    entryCooldownMin: CFG.entryCooldownMin,
    buyScoreThreshold: CFG.buyScoreThreshold,
    strongScoreThreshold: CFG.strongScoreThreshold,
    dipBuyEnabled:   CFG.dipBuyEnabled,
    dipLookbackCandles: CFG.dipLookbackCandles,
    minDipPct:       CFG.minDipPct,
    minTakeProfitUsd: CFG.minTakeProfitUsd,
    signalCloseMinProfitUsd: CFG.signalCloseMinProfitUsd,
    paperDisableStopLoss: CFG.paperDisableStopLoss,
    regimeFilter:   CFG.regimeFilter,
    minEmaGapPct:   CFG.minEmaGapPct,
    minAtrPct:      CFG.minAtrPct,
    regimeRequireEmaAlignment: CFG.regimeRequireEmaAlignment,
    longOnlyPaper:  CFG.longOnlyPaper,
    longOnlyLive:   CFG.longOnlyLive,
    watchedCoins:   CFG.watchedCoins,
    timeframe:      CFG.timeframe,
    tradeSize:      CFG.tradeSize,
    tradeSizePct:   CFG.tradeSizePct,
    tradeSizeMinUsd: CFG.tradeSizeMinUsd,
    tradeSizeMaxUsd: CFG.tradeSizeMaxUsd,
    tradingEnabledOnStartup: CFG.tradingEnabledOnStartup,
    feeBps: CFG.feeBps,
    slippageEntryBps: CFG.slippageEntryBps,
    slippageExitBps: CFG.slippageExitBps,
    atrTrailEnabled: CFG.atrTrailEnabled,
    atrTrailMult: CFG.atrTrailMult,
    breakEvenTriggerR: CFG.breakEvenTriggerR,
    breakEvenOffsetBps: CFG.breakEvenOffsetBps,
    loopIntervalSec: CFG.loopIntervalSec,
    runtime,
    effectiveTradeSizeUsd,
    paperBalance:   +ST.paperBalance.toFixed(2),
    reservedCapital: +reservedCapital.toFixed(2),
    startBalance:   ST.startBalance,
    equity,
    dailyLoss:      +ST.dailyLoss.toFixed(2),
    dailyLossLimit: CFG.dailyLossLimit,
    lastTradeAt:    ST.lastTradeAt,
    lastBlocked:    ST.lastBlocked,
    lastCycleAt:    ST.lastCycleAt,
    positionCount:  Object.keys(ST.positions).length,
    errorCount:     ST.errors.length,
    pnl,
  });
});

// ── Signals ───────────────────────────────────────────────────────
app.get('/api/signals', auth, (_, res) => res.json(ST.signals));

app.get('/api/wallet-signal/status', auth, (_, res) => {
  res.json({
    enabled: CFG.walletSignalEnabled,
    mode: CFG.walletSignalMode,
    threshold: CFG.walletSignalThreshold,
    boostPct: CFG.walletSignalBoostPct,
    source: ST.walletSignals?.source || 'manual',
    updatedAt: ST.walletSignals?.updatedAt || null,
    coinCount: Object.keys(ST.walletSignals?.coins || {}).length,
    message: 'Phase-1 scaffold active. Post coin scores to /api/wallet-signals.',
  });
});

// ── Wallet-signal summary (phase-1 scaffold) ─────────────────────
app.get('/api/wallet-signals', auth, (_, res) => {
  const updatedAt = ST.walletSignals?.updatedAt || null;
  const ageMin = updatedAt ? Math.round((Date.now() - updatedAt) / 60000) : null;
  res.json({
    enabled: CFG.walletSignalEnabled,
    mode: CFG.walletSignalMode,
    threshold: CFG.walletSignalThreshold,
    boostPct: CFG.walletSignalBoostPct,
    ageMinutes: ageMin,
    updatedAt,
    coins: ST.walletSignals?.coins || {},
  });
});

// ── Wallet signal ingest (phase-1 scaffold endpoint) ─────────────
app.post('/api/wallet-signals', auth, (req, res) => {
  const coins = req.body?.coins;
  if (!coins || typeof coins !== 'object') {
    return res.status(400).json({ error: 'Body must contain { coins: { \"BTC-USD\": { flowZ, score, sampleWallets } } }' });
  }
  const sanitized = {};
  for (const [coin, v] of Object.entries(coins)) {
    sanitized[coin] = {
      flowZ: Number(v?.flowZ) || 0,
      score: Number(v?.score) || 0,
      sampleWallets: Number(v?.sampleWallets) || 0,
      source: String(v?.source || 'manual'),
      updatedAt: Date.now(),
    };
  }
  ST.walletSignals = { source: 'manual', updatedAt: Date.now(), coins: sanitized };
  saveState();
  res.json({ ok: true, updatedAt: ST.walletSignals.updatedAt, count: Object.keys(sanitized).length });
});

// ── Signals summary (human-readable) ──────────────────────────────
app.get('/api/signals/summary', auth, (req, res) => {
  const now = Date.now();
  const cooldownMs = Math.max(0, CFG.entryCooldownMin) * 60 * 1000;
  const positions = ST.positions || {};
  const signals = Object.entries(ST.signals || {}).map(([coin, s]) => {
    const label = s?.label || '—';
    const confidence = Number.isFinite(s?.confidence) ? s.confidence : null;
    const regime = s?.regime || { ok: true, reason: 'n/a' };
    const hasPos = !!positions[coin];
    const isStrong = label === 'STRONG_BUY' || label === 'STRONG_SELL';
    const isDirectional = label === 'BUY' || label === 'SELL' || isStrong;
    const side = label.includes('BUY') ? 'BUY' : label.includes('SELL') ? 'SELL' : 'HOLD';
    const confidenceOk = confidence !== null ? confidence >= CFG.minConfidence : false;
    const lastEntryAt = ST.lastEntryAt?.[coin] || 0;
    const cooledDown = now - lastEntryAt >= cooldownMs;
    const sellPolicyBlocked = side === 'SELL' && (
      (CFG.paperMode && CFG.longOnlyPaper) ||
      (!CFG.paperMode && CFG.longOnlyLive)
    );

    let status = 'watching';
    let reason = 'waiting';
    if (hasPos) {
      status = 'in_position';
      reason = 'already in position';
    } else if (sellPolicyBlocked) {
      status = 'blocked';
      reason = CFG.paperMode
        ? 'policy: LONG_ONLY_PAPER blocks SELL entries'
        : 'policy: LONG_ONLY_LIVE blocks SELL entries';
    } else if (!isDirectional) {
      status = 'blocked';
      reason = `signal ${label} (needs BUY/SELL)`;
    } else if (!confidenceOk) {
      status = 'blocked';
      reason = `confidence ${confidence}% < ${CFG.minConfidence}%`;
    } else if (!cooledDown) {
      const mins = Math.max(1, Math.ceil((cooldownMs - (now - lastEntryAt)) / 60000));
      status = 'blocked';
      reason = `cooldown active (${mins}m remaining)`;
    } else if (CFG.dipBuyEnabled && s?.dip?.ok === false) {
      status = 'blocked';
      reason = `dip filter: ${s.dip.reason}`;
    } else if (!regime.ok) {
      status = 'blocked';
      reason = `regime blocked: ${regime.reason}`;
    } else if (!CFG.activeMode && !isStrong) {
      status = 'blocked';
      reason = `classic mode: waiting STRONG_* (got ${label})`;
    } else {
      status = 'entry_ready';
      reason = 'eligible for entry';
    }

    return {
      coin,
      label,
      confidence,
      price: s?.price ?? null,
      regimeOk: !!regime.ok,
      regimeReason: regime.reason || 'n/a',
      status,
      reason,
      updatedAt: s?.updatedAt || null,
    };
  });

  signals.sort((a, b) => a.coin.localeCompare(b.coin));

  const counts = signals.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  const lines = [];
  lines.push(`Signals summary @ ${new Date(now).toISOString()}`);
  lines.push(
    `Mode=${CFG.activeMode ? 'active' : 'classic'} · MinConf=${CFG.minConfidence}% · Cooldown=${CFG.entryCooldownMin}m · BuyT=${CFG.buyScoreThreshold} · StrongT=${CFG.strongScoreThreshold} · Dip=${CFG.dipBuyEnabled ? 'on' : 'off'}(${CFG.minDipPct}%/${CFG.dipLookbackCandles}c) · TPMin=$${CFG.minTakeProfitUsd} · SigCloseMin=$${CFG.signalCloseMinProfitUsd} · PaperSL=${CFG.paperDisableStopLoss ? 'off' : 'on'} · Size=${CFG.tradeSizePct > 0 ? CFG.tradeSizePct + '% [' + CFG.tradeSizeMinUsd + '-' + CFG.tradeSizeMaxUsd + ']' : '$' + CFG.tradeSize} · Fee=${CFG.feeBps}bps · Slip=${CFG.slippageEntryBps}/${CFG.slippageExitBps}bps · Trail=${CFG.atrTrailEnabled ? `on(${CFG.atrTrailMult}xATR)` : 'off'} · BE=${CFG.breakEvenTriggerR}R/${CFG.breakEvenOffsetBps}bps · Loop=${CFG.loopIntervalSec}s · Wallet=${CFG.walletSignalEnabled ? 'on' : 'off'}(thr ${CFG.walletSignalThreshold}) · Regime=${CFG.regimeFilter ? 'on' : 'off'} · Align=${CFG.regimeRequireEmaAlignment ? 'on' : 'off'}`
  );
  lines.push(`Counts: entry_ready=${counts.entry_ready || 0}, blocked=${counts.blocked || 0}, in_position=${counts.in_position || 0}, watching=${counts.watching || 0}`);
  for (const s of signals) {
    const conf = s.confidence != null ? `${s.confidence}%` : '—';
    const px = s.price != null ? `$${Number(s.price).toFixed(4)}` : '—';
    lines.push(`${s.coin.padEnd(8)} ${String(s.label).padEnd(12)} conf=${conf.padEnd(4)} price=${px} | ${s.status} | ${s.reason}`);
  }

  const wantsText = String(req.query.format || '').toLowerCase() === 'text'
    || String(req.query.format || '').toLowerCase() === 'txt'
    || String(req.headers.accept || '').includes('text/plain');

  if (wantsText) {
    res.type('text/plain').send(lines.join('\n'));
    return;
  }

  res.json({
    generatedAt: now,
    mode: {
      activeMode: CFG.activeMode,
      minConfidence: CFG.minConfidence,
      entryCooldownMin: CFG.entryCooldownMin,
      buyScoreThreshold: CFG.buyScoreThreshold,
      strongScoreThreshold: CFG.strongScoreThreshold,
      dipBuyEnabled: CFG.dipBuyEnabled,
      dipLookbackCandles: CFG.dipLookbackCandles,
      minDipPct: CFG.minDipPct,
      minTakeProfitUsd: CFG.minTakeProfitUsd,
      signalCloseMinProfitUsd: CFG.signalCloseMinProfitUsd,
      paperDisableStopLoss: CFG.paperDisableStopLoss,
      tradeSize: CFG.tradeSize,
      tradeSizePct: CFG.tradeSizePct,
      tradeSizeMinUsd: CFG.tradeSizeMinUsd,
      tradeSizeMaxUsd: CFG.tradeSizeMaxUsd,
      tradingEnabledOnStartup: CFG.tradingEnabledOnStartup,
      feeBps: CFG.feeBps,
      slippageEntryBps: CFG.slippageEntryBps,
      slippageExitBps: CFG.slippageExitBps,
      atrTrailEnabled: CFG.atrTrailEnabled,
      atrTrailMult: CFG.atrTrailMult,
      breakEvenTriggerR: CFG.breakEvenTriggerR,
      breakEvenOffsetBps: CFG.breakEvenOffsetBps,
      loopIntervalSec: CFG.loopIntervalSec,
      regimeFilter: CFG.regimeFilter,
      minEmaGapPct: CFG.minEmaGapPct,
      minAtrPct: CFG.minAtrPct,
      regimeRequireEmaAlignment: CFG.regimeRequireEmaAlignment,
    },
    counts,
    signals,
    text: lines.join('\n'),
  });
});

// ── Positions (with live P&L) ─────────────────────────────────────
app.get('/api/positions', auth, async (_, res) => {
  const enriched = {};
  for (const [coin, pos] of Object.entries(ST.positions)) {
    try {
      const price = await fetchPrice(coin);
      const est = estimatePositionPnl(pos, price, CFG.slippageExitBps);
      const pnl = est.net;
      enriched[coin] = {
        ...pos,
        currentPrice: price,
        estExitPrice: est.exitPrice != null ? +est.exitPrice.toFixed(6) : null,
        grossPnl: +est.gross.toFixed(4),
        feesUsd: +est.fees.toFixed(4),
        pnl: +pnl.toFixed(4),
        pnlPct: +((pnl / pos.size) * 100).toFixed(2),
      };
    } catch(e) { enriched[coin] = pos; }
  }
  res.json(enriched);
});

// ── Trade history ─────────────────────────────────────────────────
app.get('/api/trades', auth, (_, res) => res.json(ST.trades.slice(0, 50)));

// ── Backtest (single profile) ──────────────────────────────────────
app.get('/api/backtest', auth, async (req, res) => {
  try {
    const cfg = buildBacktestConfigFromQuery(req.query || {});
    if (!cfg.watchedCoins.length) {
      return res.status(400).json({ error: 'No coins configured. Pass ?coins=BTC-USD,ETH-USD' });
    }
    const historyByCoin = await loadBacktestHistory(cfg.watchedCoins, cfg.timeframe, cfg.candles);
    const result = runSingleBacktest(cfg, historyByCoin, { forceCloseAtEnd: true });
    if (!result.ok) return res.status(400).json(result);
    res.json({
      generatedAt: Date.now(),
      mode: 'single',
      result,
      score: scoreBacktestOutcome(result),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'backtest failed' });
  }
});

// ── Backtest walk-forward + profile ranking ────────────────────────
app.get('/api/backtest/walk-forward', auth, async (req, res) => {
  try {
    const baseCfg = buildBacktestConfigFromQuery(req.query || {});
    if (!baseCfg.watchedCoins.length) {
      return res.status(400).json({ error: 'No coins configured. Pass ?coins=BTC-USD,ETH-USD' });
    }
    const windows = Math.round(parseNumParam(req.query.windows, 4, 2, 12));
    const profileMode = String(req.query.profiles || 'preset').toLowerCase();
    const candidates = profileMode === 'single'
      ? [baseCfg]
      : buildProfileCandidates(baseCfg);
    const historyCache = {};
    const loadHistoryForConfig = async (cfg) => {
      const key = `${cfg.timeframe}::${cfg.candles}::${(cfg.watchedCoins || []).join(',')}`;
      if (!historyCache[key]) {
        historyCache[key] = await loadBacktestHistory(cfg.watchedCoins, cfg.timeframe, cfg.candles);
      }
      return historyCache[key];
    };

    const runs = [];
    for (const c of candidates) {
      const historyByCoin = await loadHistoryForConfig(c);
      const walk = runWalkForward(c, historyByCoin, windows);
      if (!walk.ok) {
        runs.push({ profile: c.name || 'custom', ok: false, error: walk.error });
        continue;
      }
      const aggregateScore =
        safeNum(walk.combinedMetrics?.totalPnl, 0) +
        safeNum(walk.combinedMetrics?.expectancy, 0) * 40 +
        safeNum(walk.combinedMetrics?.profitFactor, 0) * 8 +
        safeNum(walk.consistencyPct, 0) * 0.15 -
        safeNum(walk.combinedMetrics?.maxDrawdown, 0) * 0.6;
      runs.push({
        profile: c.name || 'custom',
        ok: true,
        score: +aggregateScore.toFixed(4),
        config: c,
        walkForward: walk,
      });
    }

    const ranked = runs
      .filter(r => r.ok)
      .sort((a, b) => (b.score || 0) - (a.score || 0));

    res.json({
      generatedAt: Date.now(),
      windows,
      requestedProfiles: candidates.map(c => c.name || 'custom'),
      bestProfile: ranked[0] || null,
      ranked,
      failed: runs.filter(r => !r.ok),
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'walk-forward failed' });
  }
});

// ── Rolling trade metrics ─────────────────────────────────────────
app.get('/api/metrics/rolling', auth, (_, res) => {
  const requested = [10, 30, 50];
  const history = [...(ST.trades || [])]
    .filter(t => Number.isFinite(+t.pnl))
    .sort((a, b) => (a.closed || 0) - (b.closed || 0)); // oldest -> newest

  const windows = {};
  for (const n of requested) {
    const slice = history.slice(-n);
    windows[`last${n}`] = calcRollingWindow(slice);
  }
  const overall = calcRollingWindow(history);

  res.json({
    totalTrades: history.length,
    overall,
    windows,
  });
});

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

// ── Rolling performance metrics ────────────────────────────────────
app.get('/api/performance/rolling', auth, (_, res) => {
  // ST.trades is newest-first. For metrics, compute in chronological order.
  const allChrono = [...ST.trades].reverse();
  const windows = [10, 30, 50].map(w => {
    const slice = allChrono.slice(-w);
    return { window: w, ...computeTradeMetrics(slice) };
  });

  const overall = computeTradeMetrics(allChrono);
  res.json({
    updatedAt: Date.now(),
    overall,
    windows,
  });
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
  const priorLoopIntervalSec = CFG.loopIntervalSec;
  const {
    tradeSize, tradeSizePct, tradeSizeMinUsd, tradeSizeMaxUsd, maxPositions, dailyLossLimit, watchedCoins, timeframe,
    activeMode, minConfidence, entryCooldownMin, buyScoreThreshold, strongScoreThreshold, dipBuyEnabled, dipLookbackCandles, minDipPct, minTakeProfitUsd, signalCloseMinProfitUsd, paperDisableStopLoss, regimeFilter, minEmaGapPct, minAtrPct, regimeRequireEmaAlignment, longOnlyPaper, longOnlyLive,
    tradingEnabledOnStartup,
    feeBps, slippageEntryBps, slippageExitBps, atrTrailEnabled, atrTrailMult, breakEvenTriggerR, breakEvenOffsetBps, loopIntervalSec,
  } = req.body;
  if (tradeSize      !== undefined) CFG.tradeSize      = +tradeSize;
  if (tradeSizePct   !== undefined) CFG.tradeSizePct   = +tradeSizePct;
  if (tradeSizeMinUsd !== undefined) CFG.tradeSizeMinUsd = +tradeSizeMinUsd;
  if (tradeSizeMaxUsd !== undefined) CFG.tradeSizeMaxUsd = +tradeSizeMaxUsd;
  if (maxPositions   !== undefined) CFG.maxPositions   = +maxPositions;
  if (dailyLossLimit !== undefined) CFG.dailyLossLimit = +dailyLossLimit;
  if (watchedCoins   !== undefined) CFG.watchedCoins   = watchedCoins;
  if (timeframe      !== undefined) CFG.timeframe      = timeframe;
  if (activeMode     !== undefined) CFG.activeMode     = !!activeMode;
  if (minConfidence  !== undefined) CFG.minConfidence  = +minConfidence;
  if (entryCooldownMin !== undefined) CFG.entryCooldownMin = +entryCooldownMin;
  if (buyScoreThreshold !== undefined) CFG.buyScoreThreshold = +buyScoreThreshold;
  if (strongScoreThreshold !== undefined) CFG.strongScoreThreshold = +strongScoreThreshold;
  if (dipBuyEnabled  !== undefined) CFG.dipBuyEnabled  = !!dipBuyEnabled;
  if (dipLookbackCandles !== undefined) CFG.dipLookbackCandles = +dipLookbackCandles;
  if (minDipPct      !== undefined) CFG.minDipPct      = +minDipPct;
  if (minTakeProfitUsd !== undefined) CFG.minTakeProfitUsd = +minTakeProfitUsd;
  if (signalCloseMinProfitUsd !== undefined) CFG.signalCloseMinProfitUsd = +signalCloseMinProfitUsd;
  if (paperDisableStopLoss !== undefined) CFG.paperDisableStopLoss = !!paperDisableStopLoss;
  if (regimeFilter   !== undefined) CFG.regimeFilter   = !!regimeFilter;
  if (minEmaGapPct   !== undefined) CFG.minEmaGapPct   = +minEmaGapPct;
  if (minAtrPct      !== undefined) CFG.minAtrPct      = +minAtrPct;
  if (regimeRequireEmaAlignment !== undefined) CFG.regimeRequireEmaAlignment = !!regimeRequireEmaAlignment;
  if (longOnlyPaper  !== undefined) CFG.longOnlyPaper  = !!longOnlyPaper;
  if (longOnlyLive   !== undefined) CFG.longOnlyLive   = !!longOnlyLive;
  if (tradingEnabledOnStartup !== undefined) CFG.tradingEnabledOnStartup = !!tradingEnabledOnStartup;
  // Runtime execution settings
  if (feeBps !== undefined) CFG.feeBps = clamp(+feeBps, 0, 1000, CFG.feeBps);
  if (slippageEntryBps !== undefined) CFG.slippageEntryBps = clamp(+slippageEntryBps, 0, 1000, CFG.slippageEntryBps);
  if (slippageExitBps !== undefined) CFG.slippageExitBps = clamp(+slippageExitBps, 0, 1000, CFG.slippageExitBps);
  if (atrTrailEnabled !== undefined) CFG.atrTrailEnabled = !!atrTrailEnabled;
  if (atrTrailMult !== undefined) CFG.atrTrailMult = clamp(+atrTrailMult, 0, 10, CFG.atrTrailMult);
  if (breakEvenTriggerR !== undefined) CFG.breakEvenTriggerR = clamp(+breakEvenTriggerR, 0, 10, CFG.breakEvenTriggerR);
  if (breakEvenOffsetBps !== undefined) CFG.breakEvenOffsetBps = clamp(+breakEvenOffsetBps, 0, 500, CFG.breakEvenOffsetBps);
  if (loopIntervalSec !== undefined) CFG.loopIntervalSec = Math.round(clamp(+loopIntervalSec, 5, 300, CFG.loopIntervalSec));
  if (CFG.loopIntervalSec !== priorLoopIntervalSec) restartMonitorInterval();
  res.json({
    ok: true,
    tradeSize: CFG.tradeSize,
    tradeSizePct: CFG.tradeSizePct,
    tradeSizeMinUsd: CFG.tradeSizeMinUsd,
    tradeSizeMaxUsd: CFG.tradeSizeMaxUsd,
    maxPositions: CFG.maxPositions,
    dailyLossLimit: CFG.dailyLossLimit,
    watchedCoins: CFG.watchedCoins,
    timeframe: CFG.timeframe,
    activeMode: CFG.activeMode,
    minConfidence: CFG.minConfidence,
    entryCooldownMin: CFG.entryCooldownMin,
    buyScoreThreshold: CFG.buyScoreThreshold,
    strongScoreThreshold: CFG.strongScoreThreshold,
    dipBuyEnabled: CFG.dipBuyEnabled,
    dipLookbackCandles: CFG.dipLookbackCandles,
    minDipPct: CFG.minDipPct,
    minTakeProfitUsd: CFG.minTakeProfitUsd,
    signalCloseMinProfitUsd: CFG.signalCloseMinProfitUsd,
    paperDisableStopLoss: CFG.paperDisableStopLoss,
    regimeFilter: CFG.regimeFilter,
    minEmaGapPct: CFG.minEmaGapPct,
    minAtrPct: CFG.minAtrPct,
    regimeRequireEmaAlignment: CFG.regimeRequireEmaAlignment,
    longOnlyPaper: CFG.longOnlyPaper,
    longOnlyLive: CFG.longOnlyLive,
    tradingEnabledOnStartup: CFG.tradingEnabledOnStartup,
    feeBps: CFG.feeBps,
    slippageEntryBps: CFG.slippageEntryBps,
    slippageExitBps: CFG.slippageExitBps,
    atrTrailEnabled: CFG.atrTrailEnabled,
    atrTrailMult: CFG.atrTrailMult,
    breakEvenTriggerR: CFG.breakEvenTriggerR,
    breakEvenOffsetBps: CFG.breakEvenOffsetBps,
    loopIntervalSec: CFG.loopIntervalSec,
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
  console.log(`🚦  Startup auto-enable: ${CFG.tradingEnabledOnStartup ? 'ON' : 'OFF'}`);
  console.log(`👁   Watching:   ${CFG.watchedCoins.join(', ')}`);
  const sizeCfg = CFG.tradeSizePct > 0
    ? `${CFG.tradeSizePct}% (min:$${CFG.tradeSizeMinUsd || 0}, max:$${CFG.tradeSizeMaxUsd || 0})`
    : `$${CFG.tradeSize}`;
  console.log(`⏱   Timeframe:  ${CFG.timeframe} | Trade size: ${sizeCfg}`);
  console.log(`🛡   Daily loss limit: $${CFG.dailyLossLimit}`);
  console.log(`⚙️   Active mode: ${CFG.activeMode ? 'ON' : 'OFF'} | Min confidence: ${CFG.minConfidence}% | Cooldown: ${CFG.entryCooldownMin}m`);
  console.log(`🎚   Signal thresholds: BUY>${CFG.buyScoreThreshold} | STRONG>${CFG.strongScoreThreshold}`);
  console.log(`🪙  Dip filter: ${CFG.dipBuyEnabled ? 'ON' : 'OFF'} | Min dip: ${CFG.minDipPct}% | Lookback: ${CFG.dipLookbackCandles} candles`);
  console.log(`💵  TP floor: $${CFG.minTakeProfitUsd} | Signal close min profit: $${CFG.signalCloseMinProfitUsd} | Paper stop-loss: ${CFG.paperDisableStopLoss ? 'OFF' : 'ON'}`);
  console.log(`💸  Fees/Slippage: fee ${CFG.feeBps}bps | entry slip ${CFG.slippageEntryBps}bps | exit slip ${CFG.slippageExitBps}bps`);
  console.log(`🧷  Exit controls: ATR trail ${CFG.atrTrailEnabled ? 'ON' : 'OFF'} x${CFG.atrTrailMult} | break-even ${CFG.breakEvenTriggerR}R @ ${CFG.breakEvenOffsetBps}bps`);
  console.log(`⚡  Loop interval: ${CFG.loopIntervalSec}s`);
  console.log(`🧭  Regime filter: ${CFG.regimeFilter ? 'ON' : 'OFF'} | EMA gap >= ${CFG.minEmaGapPct}% | ATR >= ${CFG.minAtrPct}% | EMA align required: ${CFG.regimeRequireEmaAlignment ? 'YES' : 'NO'}`);
  console.log(`📌  Paper policy: ${CFG.longOnlyPaper ? 'LONG ONLY' : 'ALLOW BUY/SELL'} | Live policy: ${CFG.longOnlyLive ? 'LONG ONLY' : 'ALLOW BUY/SELL'}`);
  console.log(`📌  Live mode policy: ${CFG.longOnlyLive ? 'LONG ONLY (no fresh SELL entries)' : 'ALLOW BUY/SELL entries'}`);
  console.log('════════════════════════════════════════\n');
});
