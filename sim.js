/* =============================================================================
 * sim.js — HJKS 実データのデコード + 供給可能量計算 + 発電実績
 *
 *  実データ: 供給可能量・停止/出力低下ステータス（HJKS由来、hjks_data.js）
 *            発電実績（OCCTO由来、occto_data.js）
 *  合成データ: OCCTO 非公開ユニット・期間外は燃料プロファイルで生成
 *
 *  レスポンス重視の実装:
 *   - 起動時に1回だけデコードし、日時はすべて数値(ms)で保持
 *   - 停止イベントは「長期(>90日)」と「短期」に分離。短期は開始時刻ソート
 *     済み配列への二分探索で照合（水力ユニットは数千イベント持つため）
 *   - OCCTO データは Uint16 base64 でバイナリ保持し O(1) ルックアップ
 * ========================================================================== */

const NOW = new Date('2026-06-13T12:00:00');
const NOW_MS = NOW.getTime();
const LONG_EVENT_MS = 90 * 86400000;   // 90日超は長期イベント扱い
const FAR_FUTURE_MS = 4102444800000;   // 2100年 ≒ 復旧未定

/* ----------------------------------------------------------------------------
 * HJKS データのデコード（起動時1回）
 * ------------------------------------------------------------------------- */
const PLANTS = HJKS.plants.map((a, i) => ({
  id: 'p' + i,
  name: a[0], op: a[1], fuel: a[2], area: a[3],
  lat: a[4], lon: a[5], approx: !!a[6],
  units: a[7].map((u, j) => ({
    uid: 'p' + i + '/' + j,
    name: u[0], capMW: u[1],
    evLong: [],   // 長期イベント（少数なので線形照合）
    evShort: [],  // 短期イベント（f昇順、二分探索）
  })),
}));

const PLANT_BY_ID = Object.fromEntries(PLANTS.map((p) => [p.id, p]));

const ALL_UNITS = HJKS.units.map(([pi, uj, code, rawName, master, flags]) => {
  const plant = PLANTS[pi];
  const unit = plant.units[uj];
  unit.master = master !== 0;            // 現行マスタ在籍
  unit.haishi = !!((flags || 0) & 1);    // 廃止（確定）
  unit.shaft = !!((flags || 0) & 2);     // 多軸の軸別サブユニット（表示から隠す）
  unit.review = !!((flags || 0) & 4);    // 要確認（廃止候補・未確定）
  return { uid: unit.uid, plant, unit, code, rawName };
});
const UNIT_BY_ID = Object.fromEntries(ALL_UNITS.map((x) => [x.uid, x]));

// OCCTO 実績のルックアップキー: uid → "発電所コード/ユニット名"
const OCCTO_KEY_BY_UID = Object.fromEntries(
  ALL_UNITS.map(({ uid, code, rawName }) => [uid, `${code}/${rawName}`]),
);

// OCCTO バイナリ (Uint16 base64) を起動時にデコード
(function initOccto() {
  if (typeof OCCTO === 'undefined' || !OCCTO.data) return;
  const bin = atob(OCCTO.data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  OCCTO._buf = new Uint16Array(u8.buffer);
  OCCTO._idx = Object.fromEntries(
    OCCTO.seriesMeta.map(([key, from, offset, length]) => [key, { from, offset, length }])
  );
})();

// events: [unitIdx, kind(0停止/1低下), capMW, from分, to分, 種別idx]
for (let i = 0; i < HJKS.events.length; i++) {
  const [ui, kind, cap, fmin, tmin, ai] = HJKS.events[i];
  const ev = {
    k: kind, cap,
    f: fmin * 60000, t: tmin * 60000,
    a: HJKS.assortments[ai],
    note: HJKS.notes[i] || '',   // 停止原因（現在進行中のみ保持）
  };
  const u = ALL_UNITS[ui].unit;
  if (ev.t - ev.f > LONG_EVENT_MS) u.evLong.push(ev);
  else u.evShort.push(ev);       // build_data.py が f 昇順で出力済み
}

/* ----------------------------------------------------------------------------
 * 供給可能量（実データ）
 * ------------------------------------------------------------------------- */

// unit の時刻 t(ms) に有効なイベントを列挙して fn を呼ぶ
function eachActiveEvent(unit, t, fn) {
  for (const ev of unit.evLong) {
    if (t >= ev.f && t <= ev.t) fn(ev);
  }
  const evs = unit.evShort;
  // f <= t を満たす最後のイベントを二分探索
  let lo = 0, hi = evs.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (evs[mid].f <= t) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  // 短期イベントの長さは90日以下なので、f > t-90日 の範囲だけ遡ればよい
  const limit = t - LONG_EVENT_MS;
  for (let i = idx; i >= 0 && evs[i].f >= limit; i--) {
    if (t <= evs[i].t) fn(evs[i]);
  }
}

// 当該号機の供給可能量(MW)と状態
//  status: '通常' | '出力低下' | '停止'
function unitAvailability(uid, date) {
  const rec = UNIT_BY_ID[uid];
  if (!rec) return { capMW: 0, status: '通常' };
  const t = date.getTime();
  let cap = rec.unit.capMW;
  let status = '通常';
  let why = '';
  eachActiveEvent(rec.unit, t, (ev) => {
    if (ev.k === 0) { cap = 0; status = '停止'; why = ev.a; }
    else if (status !== '停止' && ev.cap < cap) {
      cap = ev.cap; status = '出力低下'; why = ev.a;
    }
  });
  return { capMW: cap, status, reason: why };
}

// 現在(NOW)有効な停止・低下イベントの一覧（HJKSパネル用。軸別サブユニットは除外）
function collectActiveEvents() {
  const out = [];
  for (const x of VISIBLE_UNITS) {
    eachActiveEvent(x.unit, NOW_MS, (ev) => {
      out.push({ uid: x.uid, plant: x.plant, unit: x.unit, ev });
    });
  }
  return out;
}

// 発電所の現在ステータス（停止>出力低下>通常 の優先で集約。軸別は除外）
function currentStatusOfPlant(plant) {
  let worst = '通常';
  let stopped = 0, derated = 0;
  const units = visiblePlantUnits(plant);
  for (const u of units) {
    const av = unitAvailability(u.uid, NOW);
    if (av.status === '停止') { stopped++; worst = '停止'; }
    else if (av.status === '出力低下') { derated++; if (worst === '通常') worst = '出力低下'; }
  }
  return { status: worst, stopped, derated, total: units.length };
}

/* ----------------------------------------------------------------------------
 * 発電実績（合成。供給可能量＝実データで頭打ち）
 * ------------------------------------------------------------------------- */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function tkey(date) { return Math.floor(date.getTime() / 3600000); }

// 燃料種別ごとの「定格に対する出力率(0〜1)」を時刻から生成
function rawFactor(fuel, date, seed) {
  const rnd = mulberry32(seed ^ tkey(date));
  const hour = date.getHours() + date.getMinutes() / 60;
  const doy = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
  const season = 0.85 + 0.15 * Math.cos((doy - 200) / 365 * 2 * Math.PI);
  const peak = (h) => Math.max(0, Math.sin(Math.PI * (h - 6) / 16));
  const isPeak = hour >= 9 && hour <= 21;

  switch (fuel) {
    case '原子力':
    case '地熱':
      return 0.93 + 0.04 * (rnd() - 0.5);
    case '石炭':
      return 0.80 + 0.12 * peak(hour) + 0.05 * (rnd() - 0.5);
    case 'LNG':
      return (0.25 + 0.50 * peak(hour)) * season + 0.06 * (rnd() - 0.5);
    case '石油':
      return isPeak ? 0.05 + 0.45 * peak(hour) : 0;
    case '水力':
      return 0.40 + 0.25 * peak(hour) + 0.08 * (rnd() - 0.5);
    case '太陽光': {
      if (hour < 5 || hour > 19) return 0;
      const bell = Math.max(0, Math.sin(Math.PI * (hour - 5) / 14));
      return bell * (0.45 + 0.55 * rnd()) * season;
    }
    case '風力':
      return 0.12 + 0.55 * rnd();
    default:
      return 0.35 + 0.25 * peak(hour) + 0.05 * (rnd() - 0.5);
  }
}

// uid の指定日時の実績データ種別
// 'real': OCCTO 実データ範囲内 | 'private': OCCTO 未登録 | 'synthetic': 期間外で合成
function unitDataStatus(uid, date) {
  if (!OCCTO || !OCCTO._idx) return 'synthetic';
  const key = OCCTO_KEY_BY_UID[uid];
  if (!key || !(key in OCCTO._idx)) return 'private';
  if (!date) return 'real';
  const m = OCCTO._idx[key];
  const utcMin = Math.floor(date.getTime() / 60000);
  const slot = Math.floor((utcMin - m.from) / OCCTO.step);
  return (slot >= 0 && slot < m.length) ? 'real' : 'synthetic';
}

// UI バッジ: '' (公開/実データあり) | '廃止' | '要確認' | '非公開'
//  廃止・要確認ユニットでも過去の OCCTO 実績があれば実績・供給可能量は表示する
function unitBadge(uid) {
  const rec = UNIT_BY_ID[uid];
  if (!rec) return '';
  if (rec.unit.haishi) return '廃止';
  if (rec.unit.review) return '要確認';   // 廃止候補・未確定
  if (unitDataStatus(uid) === 'real') return '';   // OCCTO 実データあり
  return '非公開';
}

function hasOcctoData(uid) {
  return unitDataStatus(uid) === 'real';
}

// 表示しないユニット:
//   - 多軸の軸別サブユニット（系列側に集約）
//   - 2024/04より前に廃止（OCCTO実績が無い廃止）＝表示しても情報が無い
function unitHidden(uid) {
  const rec = UNIT_BY_ID[uid];
  if (!rec) return true;
  if (rec.unit.shaft) return true;
  if (rec.unit.haishi && !hasOcctoData(uid)) return true;
  return false;
}

// 表示・集計対象のユニット
const VISIBLE_UNITS = ALL_UNITS.filter((x) => !unitHidden(x.uid));
function visiblePlantUnits(plant) {
  return plant.units.filter((u) => !unitHidden(u.uid));
}

// 当該号機の発電実績(MW)。OCCTO 実データを優先し、公開ユニットの範囲外は合成値。
//  戻り値: MW(数値) / null(=実績なし。非公開ユニットはダミーを出さない)
function unitOutput(uid, date) {
  const rec = UNIT_BY_ID[uid];
  if (!rec) return null;

  // 非公開ユニット（OCCTO未登録）は実績が存在しない → ダミーグラフを出さない
  if (unitDataStatus(uid) === 'private') return null;

  const av = unitAvailability(uid, date);
  if (av.capMW <= 0) return 0;   // 停止中は実績0（HJKS由来の実情報）

  // OCCTO バイナリ実績 (0=欠損, v+1=v×0.1MW)
  if (OCCTO && OCCTO._buf) {
    const key = OCCTO_KEY_BY_UID[uid];
    const m = OCCTO._idx[key];
    const utcMin = Math.floor(date.getTime() / 60000);
    const slot = Math.floor((utcMin - m.from) / OCCTO.step);
    if (slot >= 0 && slot < m.length) {
      const v = OCCTO._buf[m.offset + slot];
      if (v > 0) return Math.min((v - 1) / 10, av.capMW);  // 0.1MW単位 → MW
    }
  }

  // 廃止・要確認ユニットは OCCTO 範囲外を合成しない（過去実績のみ表示）
  if (rec.unit.haishi || rec.unit.review) return null;

  // 公開ユニットの OCCTO 期間外・欠損 → 合成値
  let f = rawFactor(rec.plant.fuel, date, hashStr(uid));
  f = Math.max(0, Math.min(1, f));
  return Math.min(rec.unit.capMW * f, av.capMW);
}

/* ----------------------------------------------------------------------------
 * 時系列生成（粒度: hour / day / month）
 * ------------------------------------------------------------------------- */
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
      subs = sampleDay(cur, 3);
      advance = () => cur.setDate(cur.getDate() + 1);
    } else {
      label = fmt(cur, 'YYYY/MM');
      subs = sampleMonth(cur);
      advance = () => cur.setMonth(cur.getMonth() + 1);
    }

    let acSum = 0, avSum = 0, acHas = false;
    for (const t of subs) {
      for (const uid of uids) {
        const o = unitOutput(uid, t);
        if (o !== null) { acSum += o; acHas = true; }  // 非公開ユニットは加算しない
        avSum += unitAvailability(uid, t).capMW;
      }
    }
    // 実績データを持つユニットが1つも無い場合は null（線を描かない）
    actual.push(acHas ? round1(acSum / subs.length) : null);
    available.push(round1(avSum / subs.length));
    labels.push(label);
    advance();
  }
  return { labels, actual, available };
}

/* ---- 補助 ---- */
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
    for (const h of [3, 9, 13, 18, 22]) arr.push(new Date(y, m, day, h, 0, 0));
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
// ms → 'YYYY/MM/DD HH:mm'（2100年以降は復旧未定の意味）
function fmtMs(ms) {
  if (ms >= FAR_FUTURE_MS) return '復旧未定';
  const d = new Date(ms);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}` +
         ` ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
