/* =============================================================================
 * data.js — マスタデータ（モック）
 *  - AREAS  : エリア（旧一般送配電エリア）と代表座標
 *  - LINES  : 連系線（運用容量と現在潮流のサンプル）
 *  - PLANTS : 発電所と発電機（ユニット）
 *  - OUTAGES: HJKS（発電情報公開システム）相当の停止・出力低下情報
 *  - GROUPS : マスタとして登録したカスタム集約グループ
 *
 *  ※すべて合成データです。実在の発電所名・座標に近づけていますが、
 *    号機構成・出力・座標・潮流値は説明用のダミーです。
 *    実データ接続時はこのファイル（と sim.js）を差し替える想定。
 * ========================================================================== */

// 燃料種別ごとの色（凡例・マーカー・グラフで共通利用）
const FUEL = {
  '原子力': { color: '#7b1fa2' },
  '石炭':   { color: '#6d4c41' },
  'LNG':    { color: '#1e88e5' },
  '石油':   { color: '#546e7a' },
  '水力':   { color: '#00acc1' },
  '揚水':   { color: '#00897b' },
  '太陽光': { color: '#fbc02d' },
  '風力':   { color: '#43a047' },
  '地熱':   { color: '#e64a19' },
};

// エリア定義（id, 名称, 代表座標, エリア集約マーカーを置く座標）
const AREAS = [
  { id: 'HOKKAIDO', name: '北海道', lat: 43.40, lon: 142.80 },
  { id: 'TOHOKU',   name: '東北',   lat: 39.50, lon: 140.60 },
  { id: 'TOKYO',    name: '東京',   lat: 36.10, lon: 139.60 },
  { id: 'CHUBU',    name: '中部',   lat: 35.30, lon: 137.20 },
  { id: 'HOKURIKU', name: '北陸',   lat: 36.70, lon: 137.00 },
  { id: 'KANSAI',   name: '関西',   lat: 34.80, lon: 135.40 },
  { id: 'CHUGOKU',  name: '中国',   lat: 34.70, lon: 132.60 },
  { id: 'SHIKOKU',  name: '四国',   lat: 33.80, lon: 133.50 },
  { id: 'KYUSHU',   name: '九州',   lat: 32.50, lon: 130.80 },
  { id: 'OKINAWA',  name: '沖縄',   lat: 26.50, lon: 127.95 },
];

// 連系線（運用容量 capMW と、サンプルの現在潮流 flowMW・向き）
// flowMW > 0 のとき from→to の向き
const LINES = [
  { id: 'L_HOK_TOH', from: 'HOKKAIDO', to: 'TOHOKU', name: '北海道・本州間連系設備', capMW: 900,  flowMW: 420 },
  { id: 'L_TOH_TOK', from: 'TOHOKU',   to: 'TOKYO',  name: '東北東京間連系線',       capMW: 5570, flowMW: 3100 },
  { id: 'L_TOK_CHU', from: 'TOKYO',    to: 'CHUBU',  name: 'FC（周波数変換設備）',   capMW: 2100, flowMW: -600 },
  { id: 'L_CHU_HKR', from: 'CHUBU',    to: 'HOKURIKU', name: '中部北陸間連系設備',    capMW: 300,  flowMW: 80 },
  { id: 'L_CHU_KAN', from: 'CHUBU',    to: 'KANSAI', name: '中部関西間連系線',       capMW: 2500, flowMW: 1200 },
  { id: 'L_HKR_KAN', from: 'HOKURIKU', to: 'KANSAI', name: '北陸関西間連系線',       capMW: 1900, flowMW: 700 },
  { id: 'L_KAN_CHG', from: 'KANSAI',   to: 'CHUGOKU', name: '関西中国間連系線',      capMW: 4150, flowMW: -900 },
  { id: 'L_KAN_SHI', from: 'KANSAI',   to: 'SHIKOKU', name: '阿南紀北直流幹線',      capMW: 1400, flowMW: 500 },
  { id: 'L_CHG_SHI', from: 'CHUGOKU',  to: 'SHIKOKU', name: '本四連系線',            capMW: 1200, flowMW: 240 },
  { id: 'L_CHG_KYU', from: 'CHUGOKU',  to: 'KYUSHU',  name: '関門連系線',            capMW: 2780, flowMW: 1500 },
];

// 発電機（ユニット）生成ヘルパー
function U(name, capMW, year) { return { name, capMW, year }; }

// 発電所マスタ
// op: 事業者（グループ集約に利用）/ fuel: 燃料種別
const PLANTS = [
  // ---- 北海道 ----
  { id: 'tomari',   name: '泊発電所',       area: 'HOKKAIDO', op: '北海道電力', fuel: '原子力', lat: 43.035, lon: 140.512,
    units: [U('1号機', 579, 1989), U('2号機', 579, 1991), U('3号機', 912, 2009)] },
  { id: 'tomatoatsuma', name: '苫東厚真発電所', area: 'HOKKAIDO', op: '北海道電力', fuel: '石炭', lat: 42.710, lon: 141.860,
    units: [U('1号機', 350, 1980), U('2号機', 600, 1985), U('4号機', 700, 2002)] },
  { id: 'date',     name: '伊達発電所',     area: 'HOKKAIDO', op: '北海道電力', fuel: '石油', lat: 42.460, lon: 140.860,
    units: [U('1号機', 350, 1978), U('2号機', 350, 1980)] },
  { id: 'setana',   name: 'せたな風力',     area: 'HOKKAIDO', op: 'J-POWER',   fuel: '風力', lat: 42.450, lon: 139.820,
    units: [U('1号', 12, 2004), U('2号', 12, 2004)] },

  // ---- 東北 ----
  { id: 'higashidori', name: '東通原子力発電所', area: 'TOHOKU', op: '東北電力', fuel: '原子力', lat: 41.188, lon: 141.388,
    units: [U('1号機', 1100, 2005)] },
  { id: 'onagawa',  name: '女川原子力発電所', area: 'TOHOKU', op: '東北電力', fuel: '原子力', lat: 38.401, lon: 141.499,
    units: [U('2号機', 825, 1995), U('3号機', 825, 2002)] },
  { id: 'sendai_t', name: '仙台火力発電所',  area: 'TOHOKU', op: '東北電力', fuel: 'LNG', lat: 38.020, lon: 140.960,
    units: [U('4号機', 446, 2010)] },
  { id: 'noshiro',  name: '能代風力',       area: 'TOHOKU', op: '東北電力', fuel: '風力', lat: 40.180, lon: 140.020,
    units: [U('ウインドファーム', 88, 2018)] },

  // ---- 東京 ----
  { id: 'kk',       name: '柏崎刈羽原子力発電所', area: 'TOKYO', op: '東京電力', fuel: '原子力', lat: 37.428, lon: 138.602,
    units: [U('1号機', 1100, 1985), U('2号機', 1100, 1990), U('3号機', 1100, 1993),
            U('4号機', 1100, 1994), U('5号機', 1100, 1990), U('6号機', 1356, 1996), U('7号機', 1356, 1997)] },
  { id: 'futtsu',   name: '富津火力発電所',  area: 'TOKYO', op: 'JERA', fuel: 'LNG', lat: 35.320, lon: 139.790,
    units: [U('1号系列', 1000, 1985), U('2号系列', 1000, 1988), U('3号系列', 1520, 1999), U('4号系列', 1520, 2008)] },
  { id: 'kashima',  name: '鹿島火力発電所',  area: 'TOKYO', op: 'JERA', fuel: 'LNG', lat: 35.930, lon: 140.710,
    units: [U('5号機', 1000, 1975), U('6号機', 1000, 1977)] },
  { id: 'hirono',   name: '広野火力発電所',  area: 'TOKYO', op: 'JERA', fuel: '石炭', lat: 37.210, lon: 141.000,
    units: [U('5号機', 600, 2004), U('6号機', 600, 2013)] },
  { id: 'kannagawa', name: '神流川揚水発電所', area: 'TOKYO', op: '東京電力', fuel: '揚水', lat: 36.060, lon: 138.710,
    units: [U('1号機', 470, 2005), U('2号機', 470, 2012)] },
  { id: 'fukushima_pv', name: '福島太陽光発電所', area: 'TOKYO', op: '東京電力', fuel: '太陽光', lat: 37.020, lon: 140.900,
    units: [U('発電設備', 40, 2016)] },

  // ---- 中部 ----
  { id: 'hamaoka',  name: '浜岡原子力発電所', area: 'CHUBU', op: '中部電力', fuel: '原子力', lat: 34.624, lon: 138.142,
    units: [U('3号機', 1100, 1987), U('4号機', 1137, 1993), U('5号機', 1380, 2005)] },
  { id: 'hekinan',  name: '碧南火力発電所',  area: 'CHUBU', op: 'JERA', fuel: '石炭', lat: 34.787, lon: 136.990,
    units: [U('1号機', 700, 1991), U('2号機', 700, 1992), U('3号機', 700, 1993), U('4号機', 1000, 2001), U('5号機', 1000, 2002)] },
  { id: 'kawagoe',  name: '川越火力発電所',  area: 'CHUBU', op: 'JERA', fuel: 'LNG', lat: 35.000, lon: 136.680,
    units: [U('3号系列', 1700, 1996), U('4号系列', 1700, 1997)] },
  { id: 'joetsu',   name: '上越火力発電所',  area: 'CHUBU', op: 'JERA', fuel: 'LNG', lat: 37.180, lon: 138.210,
    units: [U('1号系列', 595, 2012), U('2号系列', 595, 2014)] },

  // ---- 北陸 ----
  { id: 'shika',    name: '志賀原子力発電所', area: 'HOKURIKU', op: '北陸電力', fuel: '原子力', lat: 37.060, lon: 136.730,
    units: [U('1号機', 540, 1993), U('2号機', 1206, 2006)] },
  { id: 'nanao',    name: '七尾大田火力発電所', area: 'HOKURIKU', op: '北陸電力', fuel: '石炭', lat: 37.050, lon: 136.950,
    units: [U('1号機', 500, 1995), U('2号機', 700, 1998)] },

  // ---- 関西 ----
  { id: 'takahama', name: '高浜発電所',     area: 'KANSAI', op: '関西電力', fuel: '原子力', lat: 35.521, lon: 135.504,
    units: [U('1号機', 826, 1974), U('2号機', 826, 1975), U('3号機', 870, 1985), U('4号機', 870, 1985)] },
  { id: 'ohi',      name: '大飯発電所',     area: 'KANSAI', op: '関西電力', fuel: '原子力', lat: 35.541, lon: 135.652,
    units: [U('3号機', 1180, 1991), U('4号機', 1180, 1993)] },
  { id: 'himeji2',  name: '姫路第二発電所', area: 'KANSAI', op: '関西電力', fuel: 'LNG', lat: 34.780, lon: 134.660,
    units: [U('1号機', 486, 2013), U('3号機', 486, 2014), U('5号機', 486, 2015), U('6号機', 486, 2015)] },
  { id: 'nanko',    name: '南港発電所',     area: 'KANSAI', op: '関西電力', fuel: 'LNG', lat: 34.620, lon: 135.430,
    units: [U('1号機', 600, 1990), U('2号機', 600, 1990), U('3号機', 600, 1991)] },
  { id: 'okutataragi', name: '奥多々良木発電所', area: 'KANSAI', op: '関西電力', fuel: '揚水', lat: 35.270, lon: 134.770,
    units: [U('1号機', 322, 1974), U('2号機', 322, 1974), U('3号機', 322, 1998), U('4号機', 322, 1998)] },
  { id: 'kurobe4',  name: '黒部川第四発電所', area: 'KANSAI', op: '関西電力', fuel: '水力', lat: 36.566, lon: 137.665,
    units: [U('発電機', 335, 1961)] },

  // ---- 中国 ----
  { id: 'shimane',  name: '島根原子力発電所', area: 'CHUGOKU', op: '中国電力', fuel: '原子力', lat: 35.538, lon: 133.000,
    units: [U('2号機', 820, 1989)] },
  { id: 'misumi',   name: '三隅発電所',     area: 'CHUGOKU', op: '中国電力', fuel: '石炭', lat: 34.780, lon: 131.970,
    units: [U('1号機', 1000, 1998), U('2号機', 1000, 2022)] },

  // ---- 四国 ----
  { id: 'ikata',    name: '伊方発電所',     area: 'SHIKOKU', op: '四国電力', fuel: '原子力', lat: 33.490, lon: 132.310,
    units: [U('3号機', 890, 1994)] },
  { id: 'anan',     name: '阿南発電所',     area: 'SHIKOKU', op: '四国電力', fuel: 'LNG', lat: 33.930, lon: 134.660,
    units: [U('1号機', 450, 2018), U('2号機', 450, 2019)] },

  // ---- 九州 ----
  { id: 'genkai',   name: '玄海原子力発電所', area: 'KYUSHU', op: '九州電力', fuel: '原子力', lat: 33.515, lon: 129.837,
    units: [U('3号機', 1180, 1994), U('4号機', 1180, 1997)] },
  { id: 'sendai_n', name: '川内原子力発電所', area: 'KYUSHU', op: '九州電力', fuel: '原子力', lat: 31.834, lon: 130.190,
    units: [U('1号機', 890, 1984), U('2号機', 890, 1985)] },
  { id: 'reihoku',  name: '苓北発電所',     area: 'KYUSHU', op: '九州電力', fuel: '石炭', lat: 32.450, lon: 130.020,
    units: [U('1号機', 700, 1995), U('2号機', 700, 2003)] },
  { id: 'shinoita', name: '新大分発電所',   area: 'KYUSHU', op: '九州電力', fuel: 'LNG', lat: 33.270, lon: 131.740,
    units: [U('1号系列', 690, 1991), U('2号系列', 918, 1998), U('3号系列', 480, 2016)] },
  { id: 'matsuura', name: '松浦火力発電所', area: 'KYUSHU', op: 'J-POWER', fuel: '石炭', lat: 33.360, lon: 129.690,
    units: [U('1号機', 1000, 1990), U('2号機', 1000, 1997)] },
  { id: 'hatchobaru', name: '八丁原地熱発電所', area: 'KYUSHU', op: '九州電力', fuel: '地熱', lat: 33.090, lon: 131.210,
    units: [U('1号機', 55, 1977), U('2号機', 55, 1990)] },

  // ---- 沖縄 ----
  { id: 'yoshinoura', name: '吉の浦火力発電所', area: 'OKINAWA', op: '沖縄電力', fuel: 'LNG', lat: 26.320, lon: 127.830,
    units: [U('1号機', 251, 2012), U('2号機', 251, 2013)] },
  { id: 'gushikawa', name: '具志川火力発電所', area: 'OKINAWA', op: '沖縄電力', fuel: '石炭', lat: 26.360, lon: 127.850,
    units: [U('1号機', 156, 1994), U('2号機', 156, 1995)] },
];

// HJKS（発電情報公開システム）相当の停止・出力低下情報（モック）
//  unit  : 「<plantId>/<ユニット名>」で対象号機を指定
//  kind  : '停止' | '出力低下'
//  toCap : 出力低下のときの抑制後出力(MW)。停止のときは無視（0扱い）
//  from/to: 期間（ISO日付）
//  2026-06-13 を「現在」とし、現在に重なるイベントを多めに用意
const OUTAGES = [
  { unit: 'tomari/3号機',    kind: '停止',     from: '2026-04-10', to: '2026-07-20', reason: '定期検査' },
  { unit: 'tomatoatsuma/2号機', kind: '停止',  from: '2026-06-05', to: '2026-06-25', reason: '計画停止（補修作業）' },
  { unit: 'kk/1号機',        kind: '停止',     from: '2012-03-26', to: '2027-03-31', reason: '長期停止' },
  { unit: 'kk/2号機',        kind: '停止',     from: '2012-03-26', to: '2027-03-31', reason: '長期停止' },
  { unit: 'kk/3号機',        kind: '停止',     from: '2012-03-26', to: '2027-03-31', reason: '長期停止' },
  { unit: 'kk/4号機',        kind: '停止',     from: '2012-03-26', to: '2027-03-31', reason: '長期停止' },
  { unit: 'kk/5号機',        kind: '停止',     from: '2012-03-26', to: '2027-03-31', reason: '長期停止' },
  { unit: 'hamaoka/3号機',   kind: '停止',     from: '2011-05-14', to: '2027-12-31', reason: '長期停止' },
  { unit: 'hamaoka/4号機',   kind: '停止',     from: '2011-05-14', to: '2027-12-31', reason: '長期停止' },
  { unit: 'hamaoka/5号機',   kind: '停止',     from: '2011-05-14', to: '2027-12-31', reason: '長期停止' },
  { unit: 'takahama/1号機',  kind: '停止',     from: '2026-05-01', to: '2026-08-15', reason: '定期検査' },
  { unit: 'hekinan/3号機',   kind: '出力低下', toCap: 400, from: '2026-06-10', to: '2026-06-18', reason: '補機作業のため出力抑制' },
  { unit: 'sendai_n/2号機',  kind: '出力低下', toCap: 600, from: '2026-06-12', to: '2026-06-16', reason: '復水器点検' },
  { unit: 'futtsu/1号系列',  kind: '停止',     from: '2026-06-01', to: '2026-06-30', reason: '計画停止' },
  { unit: 'shika/2号機',     kind: '停止',     from: '2011-09-01', to: '2027-06-30', reason: '長期停止' },
  { unit: 'misumi/2号機',    kind: '出力低下', toCap: 700,  from: '2026-06-11', to: '2026-06-20', reason: '試運転調整' },
  { unit: 'kawagoe/3号系列', kind: '停止',     from: '2026-06-08', to: '2026-06-22', reason: '定期点検' },
];

// マスタとして登録したカスタム集約グループ
//  test(plant, unit) が true のユニットを集計対象にする
const GROUPS = [
  { id: 'g_renew',   name: '再生可能エネルギー', test: (p) => ['太陽光', '風力', '水力', '地熱'].includes(p.fuel) },
  { id: 'g_baseload', name: 'ベースロード電源（原子力・石炭・地熱）', test: (p) => ['原子力', '石炭', '地熱'].includes(p.fuel) },
  { id: 'g_thermal', name: '火力（LNG・石炭・石油）', test: (p) => ['LNG', '石炭', '石油'].includes(p.fuel) },
  { id: 'g_jera_kanto', name: 'JERA 関東エリア', test: (p) => p.op === 'JERA' && p.area === 'TOKYO' },
];

// ---- 参照しやすいよう索引を用意 ----
const PLANT_BY_ID = Object.fromEntries(PLANTS.map((p) => [p.id, p]));
const AREA_BY_ID  = Object.fromEntries(AREAS.map((a) => [a.id, a]));

// 全ユニットをフラットに展開（uid, plant, unit を保持）
const ALL_UNITS = [];
for (const p of PLANTS) {
  for (const u of p.units) {
    ALL_UNITS.push({ uid: `${p.id}/${u.name}`, plant: p, unit: u });
  }
}
const UNIT_BY_ID = Object.fromEntries(ALL_UNITS.map((x) => [x.uid, x]));

// OUTAGES を uid 索引化
const OUTAGES_BY_UID = {};
for (const o of OUTAGES) {
  (OUTAGES_BY_UID[o.unit] = OUTAGES_BY_UID[o.unit] || []).push(o);
}
