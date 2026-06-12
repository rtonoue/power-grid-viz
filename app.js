/* =============================================================================
 * app.js — 画面ロジック（Leaflet 地図 + Chart.js グラフ + パネル）
 * ========================================================================== */

const ZOOM_THRESHOLD = 7; // これ以上で発電所表示、未満でエリア集約表示

const STATUS_STYLE = {
  '通常':     { ring: '#ffffff', weight: 1 },
  '出力低下': { ring: '#f9a825', weight: 3 },
  '停止':     { ring: '#e53935', weight: 3 },
};

// 画面状態
const state = {
  selectedPlantId: null,
  selectedUnitUid: 'ALL',
  selectedGroupId: null,
  period: { from: '2026-06-07', to: '2026-06-13', gran: 'hour' },
};

let map, plantLayer, areaLayer, linesLayer;
let plantMarkers = {};       // plantId -> marker
let plantChart, groupChart;  // Chart.js インスタンス

document.addEventListener('DOMContentLoaded', init);

function init() {
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
  map = L.map('map', { zoomControl: true, minZoom: 4, maxZoom: 12 })
    .setView([37.6, 137.8], 5);

  // 国土地理院 淡色地図（APIキー不要）
  L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
    attribution: "地図: <a href='https://maps.gsi.go.jp/development/ichiran.html'>国土地理院</a>",
    maxZoom: 12,
  }).addTo(map);

  plantLayer = L.layerGroup();
  areaLayer = L.layerGroup();
  linesLayer = L.layerGroup();

  buildPlantMarkers();
  buildAreaAggregation();

  map.on('zoomend', () => { updateLayersForZoom(); updateModeBadge(); });
}

// 発電所マーカー（燃料色＋ステータスリング、ホバーでスペック表示）
function buildPlantMarkers() {
  for (const p of PLANTS) {
    const st = currentStatusOfPlant(p);
    const style = STATUS_STYLE[st.status];
    const totalCap = p.units.reduce((s, u) => s + u.capMW, 0);

    const m = L.circleMarker([p.lat, p.lon], {
      radius: 6 + Math.sqrt(totalCap) * 0.10,
      fillColor: FUEL[p.fuel].color,
      color: style.ring,
      weight: style.weight,
      fillOpacity: 0.9,
    });

    m.bindTooltip(plantTooltipHtml(p, st, totalCap), {
      direction: 'top', offset: [0, -4], className: 'plant-tip', sticky: true,
    });
    m.on('click', () => selectPlant(p.id));
    m.addTo(plantLayer);
    plantMarkers[p.id] = m;
  }
}

function plantTooltipHtml(p, st, totalCap) {
  const curGen = p.units.reduce((s, u) => s + unitOutput(`${p.id}/${u.name}`, NOW), 0);
  const curAv = p.units.reduce((s, u) => s + unitAvailability(`${p.id}/${u.name}`, NOW).capMW, 0);
  const badge = st.status === '通常' ? ''
    : `<span class="tip-badge ${st.status === '停止' ? 'b-stop' : 'b-derate'}">${st.status}</span>`;
  const unitRows = p.units.map((u) => {
    const av = unitAvailability(`${p.id}/${u.name}`, NOW);
    const tag = av.status === '通常' ? '' : ` <span class="u-${av.status === '停止' ? 'stop' : 'derate'}">${av.status}</span>`;
    return `<div class="tip-unit"><span>${u.name}</span><span>${u.capMW.toLocaleString()} MW${tag}</span></div>`;
  }).join('');
  return `
    <div class="tip">
      <div class="tip-head"><b>${p.name}</b> ${badge}</div>
      <div class="tip-sub">${p.op}・${p.fuel}・${p.area}エリア</div>
      <div class="tip-kpi">
        <div><span>定格合計</span><b>${Math.round(totalCap).toLocaleString()} MW</b></div>
        <div><span>供給可能量(現在)</span><b>${Math.round(curAv).toLocaleString()} MW</b></div>
        <div><span>発電実績(現在)</span><b>${Math.round(curGen).toLocaleString()} MW</b></div>
      </div>
      <div class="tip-units">${unitRows}</div>
      <div class="tip-foot">クリックで詳細・実績グラフ</div>
    </div>`;
}

// エリア集約マーカー＋連系線
function buildAreaAggregation() {
  // エリアごとの現在発電量・供給可能量を集計
  const agg = {};
  for (const a of AREAS) agg[a.id] = { gen: 0, av: 0 };
  for (const x of ALL_UNITS) {
    agg[x.plant.area].gen += unitOutput(x.uid, NOW);
    agg[x.plant.area].av += unitAvailability(x.uid, NOW).capMW;
  }

  // 連系線
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
        <div class="tip-head"><b>${ln.name}</b></div>
        <div class="tip-kpi">
          <div><span>運用容量</span><b>${ln.capMW.toLocaleString()} MW</b></div>
          <div><span>潮流</span><b>${Math.abs(ln.flowMW).toLocaleString()} MW</b></div>
          <div><span>向き</span><b>${dir}</b></div>
          <div><span>利用率</span><b>${Math.round(util * 100)}%</b></div>
        </div>
      </div>`, { sticky: true, className: 'plant-tip' });
    poly.addTo(linesLayer);
  }

  // エリア集約マーカー
  for (const a of AREAS) {
    const g = agg[a.id];
    const r = 12 + Math.sqrt(g.gen) * 0.28;
    const cm = L.circleMarker([a.lat, a.lon], {
      radius: r, fillColor: '#1565c0', color: '#fff', weight: 2, fillOpacity: 0.55,
    });
    cm.bindTooltip(`${a.name}<br><b>${Math.round(g.gen).toLocaleString()}</b> MW`, {
      permanent: true, direction: 'center', className: 'area-label',
    });
    cm.on('mouseover', () => cm.bindPopup(areaPopupHtml(a, g)));
    cm.on('click', () => map.flyTo([a.lat, a.lon], 8));
    cm.addTo(areaLayer);
  }
}

function areaPopupHtml(a, g) {
  const cnt = PLANTS.filter((p) => p.area === a.id).length;
  return `<b>${a.name}エリア</b><br>発電所 ${cnt} 箇所<br>
    発電実績(現在) ${Math.round(g.gen).toLocaleString()} MW<br>
    供給可能量(現在) ${Math.round(g.av).toLocaleString()} MW<br>
    <small>クリックでエリアにズーム</small>`;
}

// ズームに応じて表示レイヤを切替
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
    <div class="legend-title">ステータス（HJKS）</div>
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

  // プリセット
  document.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => applyPreset(btn.dataset.preset));
  });
}

function applyPreset(key) {
  const end = new Date('2026-06-13');
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

  // ハイライト
  highlightPlant(plantId);
  if (map.getZoom() < ZOOM_THRESHOLD) map.flyTo([p.lat, p.lon], 8);

  // 号機セレクタ
  const sel = document.getElementById('unit-select');
  sel.innerHTML = `<option value="ALL">発電所全体（全${p.units.length}号機）</option>` +
    p.units.map((u) => `<option value="${p.id}/${u.name}">${u.name}（${u.capMW.toLocaleString()} MW）</option>`).join('');
  sel.onchange = () => { state.selectedUnitUid = sel.value; refreshPlantChart(); };

  document.getElementById('sel-empty').style.display = 'none';
  document.getElementById('sel-body').style.display = 'block';
  document.getElementById('sel-title').textContent = p.name;
  document.getElementById('sel-meta').textContent = `${p.op}・${p.fuel}・${p.area}エリア`;

  refreshPlantChart();
}

function highlightPlant(plantId) {
  for (const [id, m] of Object.entries(plantMarkers)) {
    const st = currentStatusOfPlant(PLANT_BY_ID[id]);
    const base = STATUS_STYLE[st.status];
    if (id === plantId) m.setStyle({ color: '#0d47a1', weight: 4 });
    else m.setStyle({ color: base.ring, weight: base.weight });
  }
}

function refreshPlantChart() {
  const p = PLANT_BY_ID[state.selectedPlantId];
  if (!p) return;
  const uids = state.selectedUnitUid === 'ALL'
    ? p.units.map((u) => `${p.id}/${u.name}`)
    : [state.selectedUnitUid];

  const s = buildSeries(uids, state.period.from, state.period.to, state.period.gran);
  plantChart = drawChart('chart-plant', plantChart, s, '発電実績', '供給可能量');
  document.getElementById('sel-kpi').innerHTML = kpiHtml(s);
}

/* ----------------------------------------------------------------------------
 * グループ集計
 * ------------------------------------------------------------------------- */
function buildGroupSelect() {
  const ops = [...new Set(PLANTS.map((p) => p.op))];
  const fuels = [...new Set(PLANTS.map((p) => p.fuel))];

  const opOpts = ops.map((o) => `<option value="op:${o}">${o}</option>`).join('');
  const fuelOpts = fuels.map((f) => `<option value="fuel:${f}">${f}</option>`).join('');
  const customOpts = GROUPS.map((g) => `<option value="grp:${g.id}">${g.name}</option>`).join('');

  document.getElementById('group-select').innerHTML =
    `<option value="">— 選択してください —</option>` +
    `<optgroup label="事業者">${opOpts}</optgroup>` +
    `<optgroup label="燃料種別">${fuelOpts}</optgroup>` +
    `<optgroup label="カスタムグループ（マスタ）">${customOpts}</optgroup>`;

  document.getElementById('group-select').addEventListener('change', (e) => {
    state.selectedGroupId = e.target.value || null;
    refreshGroupChart();
  });
}

// グループID→対象ユニット uid 配列
function groupUids(groupId) {
  if (!groupId) return [];
  const [type, key] = groupId.split(':');
  if (type === 'op') return ALL_UNITS.filter((x) => x.plant.op === key).map((x) => x.uid);
  if (type === 'fuel') return ALL_UNITS.filter((x) => x.plant.fuel === key).map((x) => x.uid);
  if (type === 'grp') {
    const g = GROUPS.find((gg) => gg.id === key);
    return ALL_UNITS.filter((x) => g.test(x.plant, x.unit)).map((x) => x.uid);
  }
  return [];
}

function refreshGroupChart() {
  const gid = state.selectedGroupId;
  const body = document.getElementById('grp-body');
  if (!gid) { body.style.display = 'none'; clearGroupHighlight(); return; }

  const uids = groupUids(gid);
  const s = buildSeries(uids, state.period.from, state.period.to, state.period.gran);
  groupChart = drawChart('chart-group', groupChart, s, '発電実績（合算）', '供給可能量（合算）');

  body.style.display = 'block';
  const plantIds = [...new Set(uids.map((u) => u.split('/')[0]))];
  document.getElementById('grp-kpi').innerHTML =
    `<div class="grp-count">対象: ${plantIds.length} 発電所 / ${uids.length} 号機</div>` + kpiHtml(s);

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
    const st = currentStatusOfPlant(PLANT_BY_ID[id]);
    m.setStyle(STATUS_STYLE[st.status] ? { color: STATUS_STYLE[st.status].ring, weight: STATUS_STYLE[st.status].weight } : {});
  }
}

/* ----------------------------------------------------------------------------
 * HJKS 現在の停止・出力低下リスト
 * ------------------------------------------------------------------------- */
function renderHjksList() {
  const active = OUTAGES.filter((o) => {
    const from = new Date(o.from + 'T00:00:00');
    const to = new Date(o.to + 'T23:59:59');
    return NOW >= from && NOW <= to;
  });
  active.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === '停止' ? -1 : 1));

  const html = active.map((o) => {
    const [pid, uname] = o.unit.split('/');
    const p = PLANT_BY_ID[pid];
    const cls = o.kind === '停止' ? 'b-stop' : 'b-derate';
    const cap = o.kind === '出力低下' ? `→ ${o.toCap.toLocaleString()} MW に抑制` : '全停';
    return `<div class="hjks-row" data-plant="${pid}">
        <div class="hjks-h"><span class="tip-badge ${cls}">${o.kind}</span>
          <b>${p.name}</b> ${uname}</div>
        <div class="hjks-d">${o.reason}｜${cap}</div>
        <div class="hjks-p">${o.from} 〜 ${o.to}</div>
      </div>`;
  }).join('');

  const box = document.getElementById('hjks-list');
  box.innerHTML = html || '<div class="muted">現在、停止・出力低下の登録はありません</div>';
  document.getElementById('hjks-count').textContent = active.length;
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

function kpiHtml(s) {
  const avgA = avg(s.actual), avgAv = avg(s.available);
  const peakA = Math.max(...s.actual, 0);
  const util = avgAv > 0 ? (avgA / avgAv) * 100 : 0;
  return `<div class="kpi3">
      <div><span>平均 発電実績</span><b>${Math.round(avgA).toLocaleString()} MW</b></div>
      <div><span>平均 供給可能量</span><b>${Math.round(avgAv).toLocaleString()} MW</b></div>
      <div><span>ピーク実績</span><b>${Math.round(peakA).toLocaleString()} MW</b></div>
      <div><span>設備利用率(対供給可能量)</span><b>${Math.round(util)}%</b></div>
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
