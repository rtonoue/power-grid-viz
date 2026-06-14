/* =============================================================================
 * data.js — 静的マスタ
 *  発電所・ユニット・停止情報の実データは hjks_data.js（build_data.py が生成、
 *  出典: JEPX 発電情報公開システム）から読み込む。
 *  ここには HJKS に含まれない静的マスタのみを置く:
 *    FUEL   : 燃料種別の表示色
 *    AREAS  : エリアと代表座標
 *    LINES  : 連系線（運用容量・潮流はサンプル値）
 *    GROUPS : カスタム集約グループ
 * ========================================================================== */

// 燃料種別ごとの色（凡例・マーカー・グラフで共通利用）
const FUEL = {
  '原子力': { color: '#7b1fa2' },
  '石炭':   { color: '#6d4c41' },
  'LNG':    { color: '#1e88e5' },
  '石油':   { color: '#546e7a' },
  '水力':   { color: '#00acc1' },
  '太陽光': { color: '#fbc02d' },
  '風力':   { color: '#43a047' },
  '地熱':   { color: '#e64a19' },
  'その他': { color: '#9e9e9e' },
};

// エリア定義（id, 名称, エリア集約マーカーを置く座標）
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
// ※潮流値はダミー。実データ接続（OCCTO系統情報）は今後の課題
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

// マスタとして登録したカスタム集約グループ
//  test(plant) が true の発電所のユニットを集計対象にする
const GROUPS = [
  { id: 'g_renew',    name: '再生可能エネルギー（水力・地熱・風力・太陽光）',
    test: (p) => ['水力', '地熱', '風力', '太陽光'].includes(p.fuel) },
  { id: 'g_baseload', name: 'ベースロード電源（原子力・石炭・地熱）',
    test: (p) => ['原子力', '石炭', '地熱'].includes(p.fuel) },
  { id: 'g_thermal',  name: '火力（LNG・石炭・石油）',
    test: (p) => ['LNG', '石炭', '石油'].includes(p.fuel) },
  { id: 'g_jera',     name: 'JERA 全体',
    test: (p) => p.op.includes('JERA') },
  { id: 'g_kyodo',    name: '共同火力・IPP（大手電力・JERA以外）',
    test: (p) => !/電力|JERA/.test(p.op) },
];

const AREA_BY_ID = Object.fromEntries(AREAS.map((a) => [a.id, a]));
