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
  regimeFilter:   process.env.REGIME_FILTER   !== 'false',
  minEmaGapPct:   parseFloat(process.env.MIN_EMA_GAP_PCT)  || 0.12,
  minAtrPct:      parseFloat(process.env.MIN_ATR_PCT)      || 0.35,
  regimeRequireEmaAlignment: process.env.REGIME_REQUIRE_EMA_ALIGNMENT !== 'false',
  longOnlyPaper:  process.env.LONG_ONLY_PAPER === 'true',
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

  const price = await fetchPrice(coin);
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
  const risk  = RISK[CFG.timeframe] || RISK['15m'];
  let tp      = side === 'BUY' ? price * (1 + risk.tp) : price * (1 - risk.tp);
  const sl    = side === 'BUY' ? price * (1 - risk.sl) : price * (1 + risk.sl);
  if (CFG.minTakeProfitUsd > 0 && usdSize > 0) {
    const minMovePct = CFG.minTakeProfitUsd / usdSize;
    if (side === 'BUY') {
      tp = Math.max(tp, price * (1 + minMovePct));
    } else {
      tp = Math.min(tp, price * (1 - minMovePct));
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

  ST.positions[coin] = {
    coin, side, size: +usdSize.toFixed(2), entry: price, tp: +tp.toFixed(6), sl: +sl.toFixed(6),
    signal: signal.label, confidence: signal.confidence, opened: Date.now(),
  };
  ST.lastTradeAt = Date.now();
  ST.lastBlocked = null;
  const mode = CFG.paperMode ? '📄 PAPER' : '💰 LIVE';
  console.log(`${mode} OPEN  ${side.padEnd(4)} ${coin} @ $${price.toFixed(4)} | Size:$${usdSize.toFixed(2)} TP:$${tp.toFixed(4)} SL:$${sl.toFixed(4)}`);
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
  ST.lastTradeAt = Date.now();

  const sign = pnl >= 0 ? '+' : '';
  console.log(`${CFG.paperMode ? '📄 PAPER' : '💰 LIVE'} CLOSE ${pos.side.padEnd(4)} ${coin} @ $${price.toFixed(4)} | PnL: ${sign}$${pnl.toFixed(2)} (${reason})`);
  saveState();
}

async function checkExits(coin) {
  const pos = ST.positions[coin];
  if (!pos) return;
  const price = await fetchPrice(coin);
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
            const pnlUsd = pos.side === 'BUY'
              ? (mark - pos.entry) / pos.entry * pos.size
              : (pos.entry - mark) / pos.entry * pos.size;
            if (CFG.signalCloseMinProfitUsd > 0 && pnlUsd < CFG.signalCloseMinProfitUsd) {
              ST.lastBlocked = {
                coin,
                label: signal.label,
                confidence: signal.confidence,
                reason: `Signal close blocked: pnl $${pnlUsd.toFixed(2)} < $${CFG.signalCloseMinProfitUsd.toFixed(2)}`,
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
  const effectiveTradeSizeUsd = await resolveTradeSizeUsd();
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
    const confidenceOk = confidence !== null ? confidence >= CFG.minConfidence : false;
    const lastEntryAt = ST.lastEntryAt?.[coin] || 0;
    const cooledDown = now - lastEntryAt >= cooldownMs;

    let status = 'watching';
    let reason = 'waiting';
    if (hasPos) {
      status = 'in_position';
      reason = 'already in position';
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
    `Mode=${CFG.activeMode ? 'active' : 'classic'} · MinConf=${CFG.minConfidence}% · Cooldown=${CFG.entryCooldownMin}m · BuyT=${CFG.buyScoreThreshold} · StrongT=${CFG.strongScoreThreshold} · Dip=${CFG.dipBuyEnabled ? 'on' : 'off'}(${CFG.minDipPct}%/${CFG.dipLookbackCandles}c) · TPMin=$${CFG.minTakeProfitUsd} · SigCloseMin=$${CFG.signalCloseMinProfitUsd} · PaperSL=${CFG.paperDisableStopLoss ? 'off' : 'on'} · Size=${CFG.tradeSizePct > 0 ? CFG.tradeSizePct + '% [' + CFG.tradeSizeMinUsd + '-' + CFG.tradeSizeMaxUsd + ']' : '$' + CFG.tradeSize} · Wallet=${CFG.walletSignalEnabled ? 'on' : 'off'}(thr ${CFG.walletSignalThreshold}) · Regime=${CFG.regimeFilter ? 'on' : 'off'} · Align=${CFG.regimeRequireEmaAlignment ? 'on' : 'off'}`
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
    tradeSize, tradeSizePct, tradeSizeMinUsd, tradeSizeMaxUsd, maxPositions, dailyLossLimit, watchedCoins, timeframe,
    activeMode, minConfidence, entryCooldownMin, buyScoreThreshold, strongScoreThreshold, dipBuyEnabled, dipLookbackCandles, minDipPct, minTakeProfitUsd, signalCloseMinProfitUsd, paperDisableStopLoss, regimeFilter, minEmaGapPct, minAtrPct, regimeRequireEmaAlignment, longOnlyPaper, longOnlyLive,
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
  const sizeCfg = CFG.tradeSizePct > 0
    ? `${CFG.tradeSizePct}% (min:$${CFG.tradeSizeMinUsd || 0}, max:$${CFG.tradeSizeMaxUsd || 0})`
    : `$${CFG.tradeSize}`;
  console.log(`⏱   Timeframe:  ${CFG.timeframe} | Trade size: ${sizeCfg}`);
  console.log(`🛡   Daily loss limit: $${CFG.dailyLossLimit}`);
  console.log(`⚙️   Active mode: ${CFG.activeMode ? 'ON' : 'OFF'} | Min confidence: ${CFG.minConfidence}% | Cooldown: ${CFG.entryCooldownMin}m`);
  console.log(`🎚   Signal thresholds: BUY>${CFG.buyScoreThreshold} | STRONG>${CFG.strongScoreThreshold}`);
  console.log(`🪙  Dip filter: ${CFG.dipBuyEnabled ? 'ON' : 'OFF'} | Min dip: ${CFG.minDipPct}% | Lookback: ${CFG.dipLookbackCandles} candles`);
  console.log(`💵  TP floor: $${CFG.minTakeProfitUsd} | Signal close min profit: $${CFG.signalCloseMinProfitUsd} | Paper stop-loss: ${CFG.paperDisableStopLoss ? 'OFF' : 'ON'}`);
  console.log(`🧭  Regime filter: ${CFG.regimeFilter ? 'ON' : 'OFF'} | EMA gap >= ${CFG.minEmaGapPct}% | ATR >= ${CFG.minAtrPct}% | EMA align required: ${CFG.regimeRequireEmaAlignment ? 'YES' : 'NO'}`);
  console.log(`📌  Paper policy: ${CFG.longOnlyPaper ? 'LONG ONLY' : 'ALLOW BUY/SELL'} | Live policy: ${CFG.longOnlyLive ? 'LONG ONLY' : 'ALLOW BUY/SELL'}`);
  console.log(`📌  Live mode policy: ${CFG.longOnlyLive ? 'LONG ONLY (no fresh SELL entries)' : 'ALLOW BUY/SELL entries'}`);
  console.log('════════════════════════════════════════\n');
});
