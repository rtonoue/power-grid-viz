/* =============================================================================
 * sim.js — 合成シミュレーション層
 *  実データが無いため、発電実績・供給可能量を「それらしく」生成する。
 *  外部公開:
 *    NOW                         … 画面上の「現在時刻」(2026-06-13 12:00)
 *    unitAvailability(uid, date) … 当該号機の供給可能量(MW)と状態を返す
 *    unitOutput(uid, date)       … 当該号機の発電実績(MW)を返す
 *    buildSeries(uids, from, to, gran) … 複数号機合算の時系列を生成
 *    currentStatusOfPlant(plant) … 発電所の現在ステータス（map表示用）
 * ========================================================================== */

const NOW = new Date('2026-06-13T12:00:00');

// 決定論的な擬似乱数（mulberry32）。同じ seed なら毎回同じ値。
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 文字列を 32bit 整数へ（seed 用）
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// 日付→通し時間（seed 用に安定したキーを作る）
function tkey(date) {
  return Math.floor(date.getTime() / 3600000); // 1時間刻み
}

// HJKS イベントを考慮した供給可能量（MW）と状態を返す
//  status: '通常' | '出力低下' | '停止'
function unitAvailability(uid, date) {
  const rec = UNIT_BY_ID[uid];
  if (!rec) return { capMW: 0, status: '通常' };
  const rated = rec.unit.capMW;
  const events = OUTAGES_BY_UID[uid] || [];
  const t = date.getTime();
  let cap = rated;
  let status = '通常';
  for (const e of events) {
    const from = new Date(e.from + 'T00:00:00').getTime();
    const to = new Date(e.to + 'T23:59:59').getTime();
    if (t >= from && t <= to) {
      if (e.kind === '停止') { return { capMW: 0, status: '停止', reason: e.reason, event: e }; }
      // 出力低下：最も厳しい抑制を採用
      if (e.toCap != null && e.toCap < cap) { cap = e.toCap; status = '出力低下'; }
    }
  }
  return { capMW: cap, status, ...(status !== '通常' ? {} : {}) };
}

// 燃料種別ごとの「定格に対する出力率(0〜1)」を時刻から生成
function rawFactor(fuel, date, seed) {
  const rnd = mulberry32(seed ^ tkey(date));
  const hour = date.getHours() + date.getMinutes() / 60;
  const doy = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const season = 0.85 + 0.15 * Math.cos((doy - 200) / 365 * 2 * Math.PI); // 夏に需要↑

  switch (fuel) {
    case '原子力':
    case '地熱':
      return 0.93 + 0.04 * (rnd() - 0.5);                       // 高稼働・安定（ベースロード）
    case '石炭':
      return 0.80 + 0.12 * peak(hour) + 0.05 * (rnd() - 0.5);   // 概ね高め、緩く負荷追従
    case 'LNG':
      return (0.25 + 0.50 * peak(hour)) * season + 0.06 * (rnd() - 0.5); // 負荷追従の主力
    case '石油':
      return Math.max(0, (0.05 + 0.45 * peak(hour)) * peakHours(hour)) ; // ピーク時のみ
    case '水力':
      return 0.45 + 0.20 * peak(hour) + 0.08 * (rnd() - 0.5);
    case '揚水':
      return peakHours(hour) ? (0.55 + 0.35 * peak(hour)) : Math.max(0, -0.15); // ピーク発電/夜間は揚水(≒0)
    case '太陽光': {
      if (hour < 5 || hour > 19) return 0;
      const bell = Math.max(0, Math.sin(Math.PI * (hour - 5) / 14)); // 5-19時のベル型
      const weather = 0.45 + 0.55 * rnd();                            // 天候ばらつき
      return bell * weather * season;
    }
    case '風力':
      return 0.12 + 0.55 * rnd();                                     // 不規則
    default:
      return 0.5;
  }
  // ---- ローカル関数 ----
  function peak(h) { // 9-21時を山にした 0〜1 形状
    return Math.max(0, Math.sin(Math.PI * (h - 6) / 16));
  }
  function peakHours(h) { return h >= 9 && h <= 21; }
}

// 当該号機の発電実績(MW)。供給可能量を上限に丸める。
function unitOutput(uid, date) {
  const rec = UNIT_BY_ID[uid];
  if (!rec) return 0;
  const av = unitAvailability(uid, date);
  if (av.capMW <= 0) return 0;
  const seed = hashStr(uid);
  let f = rawFactor(rec.plant.fuel, date, seed);
  f = Math.max(0, Math.min(1, f));
  const out = rec.unit.capMW * f;
  return Math.min(out, av.capMW); // 供給可能量でキャップ
}

// 粒度に応じてサンプリングしながら、複数号機合算の時系列を生成
//  return { labels[], actual[], available[] }  単位はいずれも MW（平均値）
function buildSeries(uids, from, to, gran) {
  const labels = [], actual = [], available = [];
  const cur = new Date(from);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(23, 59, 59, 0);

  let guard = 0;
  while (cur <= end && guard < 6000) {
    guard++;
    let label, subs, advance;
    if (gran === 'hour') {
      label = fmt(cur, 'MM/DD HH:00');
      subs = [new Date(cur)];
      advance = () => cur.setHours(cur.getHours() + 1);
    } else if (gran === 'day') {
      label = fmt(cur, 'MM/DD');
      subs = sampleDay(cur, 3);            // 3時間おき8点で日平均
      advance = () => cur.setDate(cur.getDate() + 1);
    } else { // month
      label = fmt(cur, 'YYYY/MM');
      subs = sampleMonth(cur);             // 月内の代表日×時刻
      advance = () => cur.setMonth(cur.getMonth() + 1);
    }

    let acSum = 0, avSum = 0;
    for (const t of subs) {
      for (const uid of uids) {
        acSum += unitOutput(uid, t);
        avSum += unitAvailability(uid, t).capMW;
      }
    }
    actual.push(round1(acSum / subs.length));
    available.push(round1(avSum / subs.length));
    labels.push(label);
    advance();
  }
  return { labels, actual, available };
}

// 発電所の現在ステータス（停止>出力低下>通常 の優先で集約）。map のリング表示に使用。
function currentStatusOfPlant(plant) {
  let worst = '通常';
  let stopped = 0, derated = 0;
  for (const u of plant.units) {
    const av = unitAvailability(`${plant.id}/${u.name}`, NOW);
    if (av.status === '停止') { stopped++; if (worst !== '停止') worst = '停止'; }
    else if (av.status === '出力低下') { derated++; if (worst === '通常') worst = '出力低下'; }
  }
  return { status: worst, stopped, derated, total: plant.units.length };
}

// ---- 補助 ----
function sampleDay(day, stepH) {
  const arr = [];
  for (let h = 1; h < 24; h += stepH) {
    const d = new Date(day); d.setHours(h, 0, 0, 0); arr.push(d);
  }
  return arr;
}
function sampleMonth(month) {
  const arr = [];
  const y = month.getFullYear(), m = month.getMonth();
  for (const day of [5, 15, 25]) {
    for (const h of [3, 9, 13, 18, 22]) {
      arr.push(new Date(y, m, day, h, 0, 0));
    }
  }
  return arr;
}
function round1(x) { return Math.round(x * 10) / 10; }
function pad2(n) { return String(n).padStart(2, '0'); }
function fmt(d, pat) {
  return pat
    .replace('YYYY', d.getFullYear())
    .replace('MM', pad2(d.getMonth() + 1))
    .replace('DD', pad2(d.getDate()))
    .replace('HH', pad2(d.getHours()));
}
