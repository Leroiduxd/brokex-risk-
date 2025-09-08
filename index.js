// Node 18+ (fetch global). Run: `node index.js`
// Stores results under ./data/*.jsonl

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// ==== CONFIG ====
const ASSET_IDS = [0, 1, 5500, 5000, 5002];
const TIMEFRAMES = [
  { label: "15m", interval: 900,   weight: 1 },
  { label: "1h",  interval: 3600,  weight: 2 },
  { label: "1d",  interval: 86400, weight: 3 },
];
const BASE = "https://chart.brokex.trade/history?pair={PAIR}&interval={INTERVAL}";

const DATA_DIR = path.join(__dirname, "data");
const ANALYSES_FILE = path.join(DATA_DIR, "analyses.jsonl");
const OUTCOMES_FILE = path.join(DATA_DIR, "outcomes.jsonl");

// Crée data dir si besoin
fs.mkdirSync(DATA_DIR, { recursive: true });

// ===== WSS PRICE FEED =====
const WSS_URL = "wss://wss.brokex.trade:8443";

// stocke { [assetId:number]: { price:number, ts:number, pair?:string } }
const livePrices = Object.create(null);

function startWss() {
  const ws = new WebSocket(WSS_URL);

  ws.on("open", () => {
    console.log("[WSS] connected");
  });

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      // le payload semble être un dict { pairKey: payload }, payload.id, payload.instruments[0].currentPrice
      Object.entries(data).forEach(([pairKey, payload]) => {
        const item = payload?.instruments?.[0];
        if (!item) return;
        const id = Object.prototype.hasOwnProperty.call(payload, "id") ? Number(payload.id) : undefined;
        const price = parseFloat(item.currentPrice);
        const ts = Number(item.timestamp ?? Date.now());
        if (Number.isFinite(id) && Number.isFinite(price)) {
          livePrices[id] = { price, ts, pair: item.tradingPair?.toUpperCase?.() ?? String(pairKey) };
        }
      });
    } catch (e) {
      console.error("[WSS] parse error:", e.message);
    }
  });

  ws.on("close", (code) => {
    console.warn("[WSS] closed:", code, " — retrying in 3s");
    setTimeout(startWss, 3000);
  });

  ws.on("error", (err) => {
    console.error("[WSS] error:", err.message);
  });
}
startWss();

// ====== HELPERS (indicateurs) ======
const toNum = (x) => (typeof x === "number" ? x : parseFloat(x));
const SMA = (arr, p) => {
  if (arr.length < p) return null;
  let s = 0;
  for (let i = arr.length - p; i < arr.length; i++) s += arr[i];
  return s / p;
};
const EMA = (arr, p) => {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let emaPrev = SMA(arr.slice(0, p), p);
  for (let i = p; i < arr.length; i++) emaPrev = arr[i] * k + emaPrev * (1 - k);
  return emaPrev;
};
const stddev = (arr, p) => {
  if (arr.length < p) return null;
  const slice = arr.slice(-p);
  const mean = slice.reduce((a, b) => a + b, 0) / p;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / p;
  return Math.sqrt(variance);
};
const RSI = (closes, p = 14) => {
  if (closes.length < p + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= p; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / p, avgLoss = losses / p;
  for (let i = p + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
};
const MACD = (closes, fast = 12, slow = 26, signal = 9) => {
  if (closes.length < slow + signal) return null;
  const series = [];
  let emaF = SMA(closes.slice(0, fast), fast);
  let emaS = SMA(closes.slice(0, slow), slow);
  const kF = 2 / (fast + 1), kS = 2 / (slow + 1);
  for (let i = Math.max(fast, slow); i < closes.length; i++) {
    if (i >= fast) emaF = closes[i] * kF + emaF * (1 - kF);
    if (i >= slow) emaS = closes[i] * kS + emaS * (1 - kS);
    series.push(emaF - emaS);
  }
  const macdVal = series.at(-1);
  const signalVal = EMA(series, signal);
  const hist = macdVal - signalVal;
  const prevSeries = series.slice(0, -1);
  const prevSignal = prevSeries.length ? EMA(prevSeries, signal) : null;
  const prevMacd = prevSeries.length ? prevSeries.at(-1) : null;
  const prevHist = (prevMacd != null && prevSignal != null) ? (prevMacd - prevSignal) : null;
  return { macd: macdVal, signal: signalVal, hist, prevHist };
};
const Bollinger = (closes, p = 20, mult = 2) => {
  if (closes.length < p) return null;
  const mid = SMA(closes, p);
  const sd = stddev(closes, p);
  return { mid, upper: mid + mult * sd, lower: mid - mult * sd };
};
const Stoch = (highs, lows, closes, kP = 14, dP = 3, smoothK = 3) => {
  if (closes.length < kP + dP) return null;
  const kArr = [];
  for (let i = kP - 1; i < closes.length; i++) {
    const hh = Math.max(...highs.slice(i - kP + 1, i + 1));
    const ll = Math.min(...lows.slice(i - kP + 1, i + 1));
    const k = ((closes[i] - ll) / (hh - ll)) * 100;
    kArr.push(k);
  }
  const smooth = (arr, p) => {
    const out = [];
    for (let i = p - 1; i < arr.length; i++) out.push(SMA(arr.slice(0, i + 1), p));
    return out;
  };
  const kSm = smooth(kArr, smoothK);
  const dArr = [];
  for (let i = dP - 1; i < kSm.length; i++) dArr.push(SMA(kSm.slice(0, i + 1), dP));
  const K = kSm.at(-1);
  const D = dArr.at(-1);
  const prevK = kSm.at(-2) ?? null;
  const prevD = dArr.at(-2) ?? null;
  return { K, D, prevK, prevD };
};
const CCI = (highs, lows, closes, p = 20) => {
  if (closes.length < p) return null;
  const tp = closes.map((c, i) => (highs[i] + lows[i] + closes[i]) / 3);
  const lastTP = tp.at(-1);
  const sma = SMA(tp, p);
  const slice = tp.slice(-p);
  const meanDev = slice.reduce((a, v) => a + Math.abs(v - sma), 0) / p;
  return (lastTP - sma) / (0.015 * meanDev);
};
const ADX = (highs, lows, closes, p = 14) => {
  if (closes.length < p + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  const wSmooth = (arr, p) => {
    let prev = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [prev];
    for (let i = p; i < arr.length; i++) { prev = prev - prev / p + arr[i]; out.push(prev); }
    return out;
  };
  const tr14 = wSmooth(tr, p);
  const plusDM14 = wSmooth(plusDM, p);
  const minusDM14 = wSmooth(minusDM, p);
  const plusDI = plusDM14.map((v, i) => 100 * (v / tr14[i]));
  const minusDI = minusDM14.map((v, i) => 100 * (v / tr14[i]));
  const dx = plusDI.map((v, i) => 100 * Math.abs(v - minusDI[i]) / (v + minusDI[i]));
  let adx = dx.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < dx.length; i++) adx = (adx * (p - 1) + dx[i]) / p;
  return { adx, plusDI: plusDI.at(-1), minusDI: minusDI.at(-1) };
};

// ==== SIGNAL ENGINE ====
function decideSignal({ rsi, macd, bb, adx, stoch, cci, ema50, ema200, close }) {
  let score = 0, notes = [];

  if (ema50 && ema200) {
    if (ema50 > ema200) { score += 1; notes.push("Trend UP (EMA50>EMA200)"); }
    else { score -= 1; notes.push("Trend DOWN (EMA50<EMA200)"); }
  }
  if (rsi != null) {
    if (rsi < 30) { score += 1; notes.push("RSI < 30 (oversold)"); }
    else if (rsi > 70) { score -= 1; notes.push("RSI > 70 (overbought)"); }
  }
  if (macd) {
    if (macd.macd > macd.signal && (macd.prevHist == null || macd.hist > macd.prevHist)) {
      score += 1; notes.push("MACD bullish & rising hist");
    } else if (macd.macd < macd.signal && (macd.prevHist == null || macd.hist < macd.prevHist)) {
      score -= 1; notes.push("MACD bearish & falling hist");
    }
  }
  if (bb) {
    const pos = (close - bb.lower) / (bb.upper - bb.lower); // 0=lower, 1=upper
    if (pos <= 0.1) { score += 0.5; notes.push("Near lower Bollinger"); }
    else if (pos >= 0.9) { score -= 0.5; notes.push("Near upper Bollinger"); }
  }
  if (adx) {
    if (adx.adx > 25) {
      if (adx.plusDI > adx.minusDI) { score += 0.5; notes.push("ADX>25, +DI dominates"); }
      else { score -= 0.5; notes.push("ADX>25, -DI dominates"); }
    }
  }
  if (stoch && stoch.prevK != null && stoch.prevD != null) {
    if (stoch.prevK < stoch.prevD && stoch.K > stoch.D && stoch.K < 20) {
      score += 0.5; notes.push("Stoch bullish cross <20");
    } else if (stoch.prevK > stoch.prevD && stoch.K < stoch.D && stoch.K > 80) {
      score -= 0.5; notes.push("Stoch bearish cross >80");
    }
  }
  if (cci != null) {
    if (cci < -100) { score += 0.5; notes.push("CCI < -100"); }
    else if (cci > 100) { score -= 0.5; notes.push("CCI > 100"); }
  }

  let verdict = "NEUTRAL / WAIT";
  if (score >= 1.5) verdict = "LEAN LONG";
  else if (score <= -1.5) verdict = "LEAN SHORT";

  return { score: +score.toFixed(2), verdict, notes };
}

// ==== CORE FETCH ====
async function fetchOHLC(pair, interval) {
  const url = BASE.replace("{PAIR}", pair).replace("{INTERVAL}", interval);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
  return res.json();
}

async function analyzeOneTF(assetId, label, interval) {
  const rows = await fetchOHLC(assetId, interval);
  const closes = rows.map(r => toNum(r.close));
  const highs  = rows.map(r => toNum(r.high));
  const lows   = rows.map(r => toNum(r.low));
  const close  = closes.at(-1);

  const rsi = RSI(closes, 14);
  const macd = MACD(closes, 12, 26, 9);
  const bb = Bollinger(closes, 20, 2);
  const adx = ADX(highs, lows, closes, 14);
  const stoch = Stoch(highs, lows, closes, 14, 3, 3);
  const cci = CCI(highs, lows, closes, 20);
  const ema50 = EMA(closes, 50);
  const ema200 = EMA(closes, 200);

  const { score, verdict, notes } = decideSignal({ rsi, macd, bb, adx, stoch, cci, ema50, ema200, close });

  return { label, close, score, verdict, notes };
}

async function analyzeAsset(assetId) {
  const perTF = [];
  for (const tf of TIMEFRAMES) {
    const r = await analyzeOneTF(assetId, tf.label, tf.interval);
    perTF.push({ ...r, weight: tf.weight });
  }
  const totalW = TIMEFRAMES.reduce((a, b) => a + b.weight, 0);
  const weightedScore = perTF.reduce((a, r) => a + r.score * r.weight, 0) / totalW;

  let globalVerdict = "NEUTRAL / WAIT";
  if (weightedScore >= 1.0) globalVerdict = "GLOBAL: LEAN LONG";
  else if (weightedScore <= -1.0) globalVerdict = "GLOBAL: LEAN SHORT";

  // Prix live au moment de l'analyse
  const live = livePrices[assetId];
  const spot = live?.price ?? null;
  const pairName = live?.pair ?? null;

  const now = new Date();
  const record = {
    t: now.toISOString(),
    epoch: Math.floor(now.getTime() / 1000),
    assetId,
    pair: pairName,
    spotAtAnalysis: spot,
    weightedScore: +weightedScore.toFixed(3),
    verdict: globalVerdict,
    perTF: perTF.map(({ label, close, score }) => ({ label, close, score }))
  };

  appendJsonLine(ANALYSES_FILE, record);
  console.log(`[ANALYZE] ${assetId} (${pairName ?? "?"}) score=${record.weightedScore} verdict=${globalVerdict} spot=${spot ?? "NA"}`);

  // Planifie vérification 1h plus tard
  setTimeout(() => {
    const now2 = new Date();
    const live2 = livePrices[assetId];
    const spotLater = live2?.price ?? null;

    // signe attendu de la variation d'après le score
    const predSign = Math.sign(record.weightedScore);
    const movedUp = (spot != null && spotLater != null) ? (spotLater > spot) : null;
    let correct = null;
    if (movedUp !== null) {
      if (predSign > 0) correct = movedUp === true;
      else if (predSign < 0) correct = movedUp === false;
      else correct = null; // neutre : pas d'évaluation
    }

    const outcome = {
      tCheck: now2.toISOString(),
      assetId,
      pair: pairName,
      spotAtT: spot,
      spotAtTplus1h: spotLater,
      delta: (spot != null && spotLater != null) ? +(spotLater - spot).toFixed(6) : null,
      predictedSign: predSign, // -1 short, +1 long, 0 neutral
      wasCorrect: correct
    };
    appendJsonLine(OUTCOMES_FILE, outcome);

    // (Option) relancer immédiatement une analyse à T+1h
    // analyzeAsset(assetId).catch(e => console.error("Re-analyze error:", e));

    console.log(`[OUTCOME] ${assetId} spotT=${spot ?? "NA"} spotT+1h=${spotLater ?? "NA"} correct=${correct}`);
  }, 60 * 60 * 1000);
}

function appendJsonLine(file, obj) {
  fs.appendFile(file, JSON.stringify(obj) + "\n", (err) => {
    if (err) console.error("append error", file, err.message);
  });
}

// ====== SCHEDULER ======
async function runAllAssets() {
  for (const id of ASSET_IDS) {
    try {
      await analyzeAsset(id);
    } catch (e) {
      console.error(`[ERR] analyze asset ${id}:`, e.message);
    }
  }
}

// Aligner (optionnel) au prochain “top of hour”
function msToNextHour() {
  const now = Date.now();
  const next = Math.ceil(now / 3600000) * 3600000;
  return next - now;
}

// Lance une première passe dès qu’on a un peu de prix,
// puis cadence toutes les heures alignées.
setTimeout(() => {
  runAllAssets();
  setInterval(runAllAssets, 60 * 60 * 1000);
}, Math.min(msToNextHour(), 15_000)); // start au prochain top d’heure (ou dans 15s max)

console.log("Brokex hourly analyzer started. Watching assets:", ASSET_IDS.join(", "));

