/* =============================================================================
 * app.js — 画面ロジック（Leaflet 地図 + Chart.js グラフ + パネル）
 *  データソース: hjks_data.js（HJKS実データ）+ sim.js（実績の合成）
 * ========================================================================== */

const ZOOM_THRESHOLD = 7; // これ以上で発電所表示、未満でエリア集約表示
const HJKS_LIST_MAX = 200; // HJKSパネルの最大表示件数

const STATUS_STYLE = {
  '通常':     { ring: '#ffffff', weight: 1 },
  '出力低下': { ring: '#f9a825', weight: 3 },
  '停止':     { ring: '#e53935', weight: 3 },
};

const state = {
  selectedPlantId: null,
  selectedUnitUid: 'ALL',
  selectedGroupId: null,
  period: { from: '2026-06-07', to: '2026-06-13', gran: 'hour' },
};

let map, plantLayer, areaLayer, linesLayer;
let plantMarkers = {};
let plantStatusCache = {};   // plantId -> currentStatusOfPlant() 結果
let plantChart, groupChart;

document.addEventListener('DOMContentLoaded', init);

function init() {
  // 現在ステータスは初期化時に1回だけ計算してキャッシュ（速度優先）
  for (const p of PLANTS) plantStatusCache[p.id] = currentStatusOfPlant(p);

  buildMap();
  buildPanelControls();
  buildGroupSelect();
  renderHjksList();
  renderLegend();
  updateLayersForZoom();
  updateModeBadge();
}

/* ----------------------------------------------------------------------------
 * 地図
 * ------------------------------------------------------------------------- */
function buildMap() {
  // preferCanvas: マーカーをCanvas描画にして大量マーカーでも軽快に
  map = L.map('map', { zoomControl: true, minZoom: 4, maxZoom: 12, preferCanvas: true })
    .setView([37.6, 137.8], 5);

  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    attribution: "地図: <a href='https://maps.gsi.go.jp/development/ichiran.html'>国土地理院</a>"
      + "｜停止情報: <a href='https://hjks.jepx.or.jp/hjks/'>JEPX 発電情報公開システム</a>",
    maxZoom: 12,
  }).addTo(map);

  plantLayer = L.layerGroup();
  areaLayer = L.layerGroup();
  linesLayer = L.layerGroup();

  buildPlantMarkers();
  buildAreaAggregation();

  map.on('zoomend', () => { updateLayersForZoom(); updateModeBadge(); });
}

function buildPlantMarkers() {
  for (const p of PLANTS) {
    const vis = visiblePlantUnits(p);
    if (vis.length === 0) continue;   // 全ユニット非表示（完全廃止等）の発電所は地図に出さない
    const st = plantStatusCache[p.id];
    const style = STATUS_STYLE[st.status];
    // 軸別サブユニットは系列に含まれるため認可出力合計から除外（二重計上防止）
    const totalCap = vis.reduce((s, u) => s + u.capMW, 0);

    const m = L.circleMarker([p.lat, p.lon], {
      radius: 5 + Math.sqrt(totalCap) * 0.10,
      fillColor: (FUEL[p.fuel] || FUEL['その他']).color,
      color: style.ring,
      weight: style.weight,
      fillOpacity: 0.9,
    });

    // ツールチップは初ホバー時に生成（起動時間を短縮）
    m.on('mouseover', function () {
      if (!this.getTooltip()) {
        this.bindTooltip(plantTooltipHtml(p, st, totalCap), {
          direction: 'top', offset: [0, -4], className: 'plant-tip', sticky: true,
        }).openTooltip();
      }
    });
    m.on('click', () => selectPlant(p.id));
    m.addTo(plantLayer);
    plantMarkers[p.id] = m;
  }
}

function plantTooltipHtml(p, st, totalCap) {
  const units = visiblePlantUnits(p);   // 軸別サブユニットは除外
  let curGen = 0, curAv = 0;
  for (const u of units) {
    const o = unitOutput(u.uid, NOW);
    if (o !== null) curGen += o;   // 非公開・廃止ユニットは実績に計上しない
    curAv += unitAvailability(u.uid, NOW).capMW;
  }
  const badge = st.status === '通常' ? ''
    : `<span class="tip-badge ${st.status === '停止' ? 'b-stop' : 'b-derate'}">${st.status}</span>`;

  const MAXROW = 8;
  const unitRows = units.slice(0, MAXROW).map((u) => {
    const av = unitAvailability(u.uid, NOW);
    const statusTag = av.status === '通常' ? ''
      : ` <span class="u-${av.status === '停止' ? 'stop' : 'derate'}">${av.status}</span>`;
    const b = unitBadge(u.uid);
    const badgeTag = b ? ` <span class="${b === '要確認' ? 'u-review' : 'u-private'}">${b}</span>` : '';
    return `<div class="tip-unit"><span>${esc(u.name)}</span><span>${u.capMW.toLocaleString()} MW${statusTag}${badgeTag}</span></div>`;
  }).join('')
    + (units.length > MAXROW ? `<div class="tip-unit muted">… 他 ${units.length - MAXROW} ユニット</div>` : '');

  const cnt = (label) => units.filter((u) => unitBadge(u.uid) === label).length;
  const notes = [];
  if (cnt('非公開') > 0) notes.push(`非公開${cnt('非公開')}`);
  if (cnt('廃止') > 0) notes.push(`廃止${cnt('廃止')}`);
  if (cnt('要確認') > 0) notes.push(`要確認${cnt('要確認')}`);
  const genNote = notes.length
    ? `OCCTO実データ <span class="u-private">(${notes.join('・')})</span>` : 'OCCTO実データ';

  return `
    <div class="tip">
      <div class="tip-head"><b>${esc(p.name)}</b> ${badge}</div>
      <div class="tip-sub">${esc(p.op)}・${p.fuel}・${AREA_BY_ID[p.area].name}エリア${p.approx ? '｜<span class="u-derate">位置は概算</span>' : ''}</div>
      <div class="tip-kpi">
        <div><span>認可出力合計</span><b>${Math.round(totalCap).toLocaleString()} MW</b></div>
        <div><span>供給可能量(現在)</span><b>${Math.round(curAv).toLocaleString()} MW</b></div>
        <div><span>発電実績(現在)</span><b>${Math.round(curGen).toLocaleString()} MW</b></div>
      </div>
      <div class="tip-units">${unitRows}</div>
      <div class="tip-foot">実績: ${genNote}｜クリックで詳細</div>
    </div>`;
}

function buildAreaAggregation() {
  const agg = {};
  for (const a of AREAS) agg[a.id] = { gen: 0, av: 0 };
  for (const x of VISIBLE_UNITS) {   // 軸別サブユニットは除外（二重計上防止）
    const o = unitOutput(x.uid, NOW);
    if (o !== null) agg[x.plant.area].gen += o;   // 非公開・廃止は実績に計上しない
    agg[x.plant.area].av += unitAvailability(x.uid, NOW).capMW;
  }

  for (const ln of LINES) {
    const a = AREA_BY_ID[ln.from], b = AREA_BY_ID[ln.to];
    const util = Math.abs(ln.flowMW) / ln.capMW;
    const color = util >= 0.8 ? '#e53935' : util >= 0.5 ? '#fb8c00' : '#43a047';
    const poly = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
      color, weight: 2 + ln.capMW / 900, opacity: 0.8,
    });
    const dir = ln.flowMW >= 0 ? `${a.name}→${b.name}` : `${b.name}→${a.name}`;
    poly.bindTooltip(`
      <div class="tip">
        <div class="tip-head"><b>${ln.name}</b>（サンプル値）</div>
        <div class="tip-kpi">
          <div><span>運用容量</span><b>${ln.capMW.toLocaleString()} MW</b></div>
          <div><span>潮流</span><b>${Math.abs(ln.flowMW).toLocaleString()} MW</b></div>
          <div><span>向き</span><b>${dir}</b></div>
          <div><span>利用率</span><b>${Math.round(util * 100)}%</b></div>
        </div>
      </div>`, { sticky: true, className: 'plant-tip' });
    poly.addTo(linesLayer);
  }

  for (const a of AREAS) {
    const g = agg[a.id];
    const r = 12 + Math.sqrt(g.gen) * 0.28;
    const cm = L.circleMarker([a.lat, a.lon], {
      radius: r, fillColor: '#1565c0', color: '#fff', weight: 2, fillOpacity: 0.55,
    });
    cm.bindTooltip(`${a.name}<br><b>${Math.round(g.gen).toLocaleString()}</b> MW`, {
      permanent: true, direction: 'center', className: 'area-label',
    });
    cm.on('mouseover', () => cm.bindPopup(areaPopupHtml(a, g)).openPopup());
    cm.on('click', () => map.flyTo([a.lat, a.lon], 8));
    cm.addTo(areaLayer);
  }
}

function areaPopupHtml(a, g) {
  const cnt = PLANTS.filter((p) => p.area === a.id && visiblePlantUnits(p).length > 0).length;
  return `<b>${a.name}エリア</b><br>発電所 ${cnt} 箇所<br>
    発電実績(現在) ${Math.round(g.gen).toLocaleString()} MW<br>
    供給可能量(現在) ${Math.round(g.av).toLocaleString()} MW<br>
    <small>クリックでエリアにズーム</small>`;
}

function updateLayersForZoom() {
  const z = map.getZoom();
  if (z >= ZOOM_THRESHOLD) {
    if (map.hasLayer(areaLayer)) map.removeLayer(areaLayer);
    if (map.hasLayer(linesLayer)) map.removeLayer(linesLayer);
    if (!map.hasLayer(plantLayer)) map.addLayer(plantLayer);
  } else {
    if (map.hasLayer(plantLayer)) map.removeLayer(plantLayer);
    if (!map.hasLayer(areaLayer)) map.addLayer(areaLayer);
    if (!map.hasLayer(linesLayer)) map.addLayer(linesLayer);
  }
}

function updateModeBadge() {
  const z = map.getZoom();
  const el = document.getElementById('mode-badge');
  if (z >= ZOOM_THRESHOLD) {
    el.textContent = `発電所表示（zoom ${z}）`;
    el.className = 'mode-plant';
  } else {
    el.textContent = `エリア集約・連系線表示（zoom ${z}）`;
    el.className = 'mode-area';
  }
}

/* ----------------------------------------------------------------------------
 * 凡例
 * ------------------------------------------------------------------------- */
function renderLegend() {
  const fuels = Object.entries(FUEL)
    .map(([k, v]) => `<span class="lg"><i style="background:${v.color}"></i>${k}</span>`).join('');
  document.getElementById('legend').innerHTML = `
    <div class="legend-title">燃料種別</div>
    <div class="legend-row">${fuels}</div>
    <div class="legend-title">ステータス（HJKS実データ）</div>
    <div class="legend-row">
      <span class="lg"><i class="ring" style="box-shadow:0 0 0 2px #e53935 inset"></i>停止</span>
      <span class="lg"><i class="ring" style="box-shadow:0 0 0 2px #f9a825 inset"></i>出力低下</span>
    </div>`;
}

/* ----------------------------------------------------------------------------
 * 期間コントロール
 * ------------------------------------------------------------------------- */
function buildPanelControls() {
  document.getElementById('p-from').value = state.period.from;
  document.getElementById('p-to').value = state.period.to;
  document.getElementById('p-gran').value = state.period.gran;

  const onChange = () => {
    state.period.from = document.getElementById('p-from').value;
    state.period.to = document.getElementById('p-to').value;
    state.period.gran = document.getElementById('p-gran').value;
    refreshCharts();
  };
  ['p-from', 'p-to', 'p-gran'].forEach((id) =>
    document.getElementById(id).addEventListener('change', onChange));

  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });
}

function applyPreset(key) {
  const end = new Date(NOW);
  const start = new Date(end);
  let gran = 'hour';
  if (key === '24h') { start.setDate(end.getDate() - 1); gran = 'hour'; }
  else if (key === '7d') { start.setDate(end.getDate() - 6); gran = 'hour'; }
  else if (key === '30d') { start.setDate(end.getDate() - 29); gran = 'day'; }
  else if (key === '12m') { start.setMonth(end.getMonth() - 11); gran = 'month'; }
  state.period = { from: toInputDate(start), to: toInputDate(end), gran };
  document.getElementById('p-from').value = state.period.from;
  document.getElementById('p-to').value = state.period.to;
  document.getElementById('p-gran').value = gran;
  refreshCharts();
}

/* ----------------------------------------------------------------------------
 * 発電所/号機の選択 + 実績グラフ
 * ------------------------------------------------------------------------- */
function selectPlant(plantId) {
  state.selectedPlantId = plantId;
  state.selectedUnitUid = 'ALL';
  const p = PLANT_BY_ID[plantId];
  if (!p) return;

  highlightPlant(plantId);
  if (map.getZoom() < ZOOM_THRESHOLD) map.flyTo([p.lat, p.lon], 8);

  const sel = document.getElementById('unit-select');
  const units = visiblePlantUnits(p);   // 軸別サブユニットは選択肢から隠す
  sel.innerHTML = `<option value="ALL">発電所全体（全${units.length}ユニット）</option>` +
    units.map((u) => {
      const b = unitBadge(u.uid);
      const tag = b ? ` [${b}]` : '';
      return `<option value="${u.uid}">${esc(u.name)}（${u.capMW.toLocaleString()} MW）${tag}</option>`;
    }).join('');
  sel.onchange = () => { state.selectedUnitUid = sel.value; refreshPlantChart(); };

  document.getElementById('sel-empty').style.display = 'none';
  document.getElementById('sel-body').style.display = 'block';
  document.getElementById('sel-title').textContent = p.name;
  document.getElementById('sel-meta').textContent =
    `${p.op}・${p.fuel}・${AREA_BY_ID[p.area].name}エリア` + (p.approx ? '（位置は概算）' : '');

  refreshPlantChart();
}

function highlightPlant(plantId) {
  for (const [id, m] of Object.entries(plantMarkers)) {
    const base = STATUS_STYLE[plantStatusCache[id].status];
    if (id === plantId) m.setStyle({ color: '#0d47a1', weight: 4 });
    else m.setStyle({ color: base.ring, weight: base.weight });
  }
}

function refreshPlantChart() {
  const p = PLANT_BY_ID[state.selectedPlantId];
  if (!p) return;
  const uids = state.selectedUnitUid === 'ALL'
    ? visiblePlantUnits(p).map((u) => u.uid)
    : [state.selectedUnitUid];

  const noDataCount = uids.filter((uid) => !hasOcctoData(uid)).length;
  const actualLabel = noDataCount === 0 ? '発電実績'
    : noDataCount === uids.length ? '発電実績(実データなし)'
    : '発電実績(実データのみ)';

  const s = buildSeries(uids, state.period.from, state.period.to, state.period.gran);
  plantChart = drawChart('chart-plant', plantChart, s, actualLabel, '供給可能量(HJKS)');
  document.getElementById('sel-kpi').innerHTML = kpiHtml(s, noDataCount, uids.length);
}

/* ----------------------------------------------------------------------------
 * グループ集計
 * ------------------------------------------------------------------------- */
function buildGroupSelect() {
  // 事業者は数が多いので合計容量の上位30社のみ掲載
  const capByOp = {};
  for (const p of PLANTS) {
    const cap = visiblePlantUnits(p).reduce((s, u) => s + u.capMW, 0);
    capByOp[p.op] = (capByOp[p.op] || 0) + cap;
  }
  const topOps = Object.entries(capByOp)
    .sort((a, b) => b[1] - a[1]).slice(0, 30).map(([op]) => op);

  const fuels = [...new Set(PLANTS.map((p) => p.fuel))];
  const opOpts = topOps.map((o) => `<option value="op:${esc(o)}">${esc(o)}</option>`).join('');
  const fuelOpts = fuels.map((f) => `<option value="fuel:${f}">${f}</option>`).join('');
  const customOpts = GROUPS.map((g) => `<option value="grp:${g.id}">${g.name}</option>`).join('');

  document.getElementById('group-select').innerHTML =
    `<option value="">— 選択してください —</option>` +
    `<optgroup label="カスタムグループ（マスタ）">${customOpts}</optgroup>` +
    `<optgroup label="燃料種別">${fuelOpts}</optgroup>` +
    `<optgroup label="事業者（容量上位30）">${opOpts}</optgroup>`;

  document.getElementById('group-select').addEventListener('change', (e) => {
    state.selectedGroupId = e.target.value || null;
    refreshGroupChart();
  });
}

function groupUids(groupId) {
  if (!groupId) return [];
  const sep = groupId.indexOf(':');
  const type = groupId.slice(0, sep), key = groupId.slice(sep + 1);
  // 軸別サブユニットは集計対象から除外（系列側に集約済み・二重計上防止）
  if (type === 'op') return VISIBLE_UNITS.filter((x) => x.plant.op === key).map((x) => x.uid);
  if (type === 'fuel') return VISIBLE_UNITS.filter((x) => x.plant.fuel === key).map((x) => x.uid);
  if (type === 'grp') {
    const g = GROUPS.find((gg) => gg.id === key);
    return g ? VISIBLE_UNITS.filter((x) => g.test(x.plant)).map((x) => x.uid) : [];
  }
  return [];
}

function refreshGroupChart() {
  const gid = state.selectedGroupId;
  const body = document.getElementById('grp-body');
  if (!gid) { body.style.display = 'none'; clearGroupHighlight(); return; }

  const uids = groupUids(gid);
  const noDataCount = uids.filter((uid) => !hasOcctoData(uid)).length;
  const actualLabel = noDataCount === 0 ? '発電実績(合算)'
    : noDataCount === uids.length ? '発電実績(合算・実データなし)'
    : '発電実績(合算・実データのみ)';

  const s = buildSeries(uids, state.period.from, state.period.to, state.period.gran);
  groupChart = drawChart('chart-group', groupChart, s, actualLabel, '供給可能量(合算)');

  body.style.display = 'block';
  const plantIds = [...new Set(uids.map((u) => u.split('/')[0]))];
  document.getElementById('grp-kpi').innerHTML =
    `<div class="grp-count">対象: ${plantIds.length} 発電所 / ${uids.length} ユニット</div>`
    + kpiHtml(s, noDataCount, uids.length);

  highlightGroupPlants(plantIds);
}

function highlightGroupPlants(plantIds) {
  clearGroupHighlight();
  for (const id of plantIds) {
    const m = plantMarkers[id];
    if (m) m.setStyle({ color: '#00c853', weight: 4 });
  }
}
function clearGroupHighlight() {
  for (const [id, m] of Object.entries(plantMarkers)) {
    if (id === state.selectedPlantId) continue;
    const base = STATUS_STYLE[plantStatusCache[id].status];
    m.setStyle({ color: base.ring, weight: base.weight });
  }
}

/* ----------------------------------------------------------------------------
 * HJKS 現在の停止・出力低下リスト（実データ）
 * ------------------------------------------------------------------------- */
function renderHjksList() {
  const active = collectActiveEvents();
  // 停止を先、同種なら認可出力の大きい順
  active.sort((a, b) =>
    (a.ev.k - b.ev.k) || (b.unit.capMW - a.unit.capMW));

  const total = active.length;
  const shown = active.slice(0, HJKS_LIST_MAX);

  const html = shown.map((x) => {
    const isStop = x.ev.k === 0;
    const cls = isStop ? 'b-stop' : 'b-derate';
    const kind = isStop ? '停止' : '出力低下';
    const cap = isStop ? '全停'
      : `→ ${x.ev.cap.toLocaleString()} MW に低下`;
    const reason = x.ev.note ? `｜${esc(x.ev.note)}` : '';
    return `<div class="hjks-row" data-plant="${x.plant.id}">
        <div class="hjks-h"><span class="tip-badge ${cls}">${kind}</span>
          <b>${esc(x.plant.name)}</b> ${esc(x.unit.name)}
          <span class="muted">(${x.unit.capMW.toLocaleString()} MW)</span></div>
        <div class="hjks-d">${esc(x.ev.a)}${reason}｜${cap}</div>
        <div class="hjks-p">${fmtMs(x.ev.f)} 〜 ${fmtMs(x.ev.t)}</div>
      </div>`;
  }).join('');

  const more = total > HJKS_LIST_MAX
    ? `<div class="muted" style="padding:4px">… 他 ${total - HJKS_LIST_MAX} 件（地図のリング表示参照）</div>` : '';
  const box = document.getElementById('hjks-list');
  box.innerHTML = (html || '<div class="muted">現在、停止・出力低下の登録はありません</div>') + more;
  document.getElementById('hjks-count').textContent = total;
  box.querySelectorAll('.hjks-row').forEach((row) =>
    row.addEventListener('click', () => selectPlant(row.dataset.plant)));
}

/* ----------------------------------------------------------------------------
 * 共通: チャート描画 & KPI
 * ------------------------------------------------------------------------- */
function drawChart(canvasId, instance, s, labelActual, labelAvail) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  if (instance) instance.destroy();
  return new Chart(ctx, {
    type: 'line',
    data: {
      labels: s.labels,
      datasets: [
        {
          label: labelActual, data: s.actual,
          borderColor: '#1565c0', backgroundColor: 'rgba(21,101,192,0.18)',
          fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.25,
        },
        {
          label: labelAvail, data: s.available,
          borderColor: '#e53935', borderDash: [5, 4],
          fill: false, borderWidth: 1.5, pointRadius: 0, tension: 0.1,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { title: { display: true, text: 'MW' }, beginAtZero: true },
        x: { ticks: { maxTicksLimit: 12, autoSkip: true } },
      },
      plugins: { legend: { labels: { boxWidth: 12, font: { size: 11 } } } },
    },
  });
}

function kpiHtml(s, noDataCount = 0, total = 0) {
  const actualVals = s.actual.filter((v) => v !== null);   // 実データ無しの null を除外
  const avgA = avg(actualVals), avgAv = avg(s.available);
  const peakA = Math.max(...actualVals, 0);
  const util = avgAv > 0 ? (avgA / avgAv) * 100 : 0;
  const note = (noDataCount > 0 && total > 0)
    ? ` <span class="u-private">(${noDataCount}/${total}ユニット実データ無)</span>` : '';
  return `<div class="kpi3">
      <div><span>平均 発電実績${note}</span><b>${Math.round(avgA).toLocaleString()} MW</b></div>
      <div><span>平均 供給可能量</span><b>${Math.round(avgAv).toLocaleString()} MW</b></div>
      <div><span>ピーク実績</span><b>${Math.round(peakA).toLocaleString()} MW</b></div>
      <div><span>利用率(対供給可能量)</span><b>${Math.round(util)}%</b></div>
    </div>`;
}

function refreshCharts() { refreshPlantChart(); refreshGroupChart(); }

/* ----------------------------------------------------------------------------
 * 補助
 * ------------------------------------------------------------------------- */
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function toInputDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
