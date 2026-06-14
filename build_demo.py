# /// script
# requires-python = ">=3.11"
# ///
"""GitHub Pages 用のデモを docs/ に生成する。

OCCTO/HJKS の実データは公開不可のため、デモは**合成データのみ**で構成する:
  - 発電所名・概算位置・燃料・認可出力 … 一般に公開された情報（手書き）
  - 発電実績・停止/出力低下イベント … すべて合成値（実データではない）

出力:
  docs/index.html  styles.css  data.js  sim.js  app.js   （ルートからコピー）
  docs/hjks_data.js  docs/occto_data.js                  （合成デモデータ）

使い方: uv run build_demo.py
"""

from __future__ import annotations

import array
import base64
import json
import math
import random
import shutil
from datetime import datetime, timezone, timedelta
from pathlib import Path

HERE = Path(__file__).parent
DOCS = HERE / "docs"

JST = timezone(timedelta(hours=9))
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

# sim.js の NOW と揃える（デモデータはこの時刻まで生成）
NOW = datetime(2026, 6, 13, 12, 0, tzinfo=JST)
OCCTO_DAYS = 60                       # NOW から遡って実績を持たせる日数

rng = random.Random(42)


def jst_min(dt: datetime) -> int:
    return int((dt - EPOCH).total_seconds()) // 60


# --- デモ発電所（名称・位置・燃料は一般公開情報。値はすべて合成）---
# (発電所名, 事業者, 燃料, エリア, lat, lon, [(ユニット名, 認可出力MW), ...])
PLANTS_SRC = [
    ("泊発電所", "デモ電力", "原子力", "HOKKAIDO", 43.04, 140.51, [("3号機", 912)]),
    ("苫東厚真発電所", "デモ電力", "石炭", "HOKKAIDO", 42.71, 141.86,
     [("2号機", 600), ("4号機", 700)]),
    ("女川原子力発電所", "デモ電力", "原子力", "TOHOKU", 38.40, 141.50, [("2号機", 825)]),
    ("東新潟火力発電所", "デモ電力", "LNG", "TOHOKU", 37.97, 139.26,
     [("4号機", 1090), ("港1号機", 350)]),
    ("奥只見発電所", "デモ電力", "水力", "TOHOKU", 37.15, 139.25, [("単独", 560)]),
    ("柏崎刈羽原子力発電所", "デモ電力", "原子力", "TOKYO", 37.43, 138.60,
     [("6号機", 1356), ("7号機", 1356)]),
    ("鹿島火力発電所", "デモ電力", "LNG", "TOKYO", 35.93, 140.69,
     [("2号機", 600), ("3号機", 1000)]),
    ("富津火力発電所", "デモ電力", "LNG", "TOKYO", 35.32, 139.79,
     [("1号機", 1520), ("4号機", 1520)]),
    ("横須賀火力発電所", "デモ電力", "石炭", "TOKYO", 35.22, 139.72, [("新1号機", 650)]),
    ("デモ千葉ソーラー", "デモ新電力", "太陽光", "TOKYO", 35.60, 140.30, [("単独", 120)]),
    ("浜岡原子力発電所", "デモ電力", "原子力", "CHUBU", 34.62, 138.14, [("4号機", 1137)]),
    ("碧南火力発電所", "デモ電力", "石炭", "CHUBU", 34.79, 136.99,
     [("3号機", 700), ("5号機", 1000)]),
    ("川越火力発電所", "デモ電力", "LNG", "CHUBU", 35.00, 136.68, [("3号機", 1700)]),
    ("七尾大田火力発電所", "デモ電力", "石炭", "HOKURIKU", 37.05, 136.95, [("2号機", 700)]),
    ("高浜発電所", "デモ電力", "原子力", "KANSAI", 35.52, 135.50,
     [("3号機", 870), ("4号機", 870)]),
    ("姫路第二発電所", "デモ電力", "LNG", "KANSAI", 34.78, 134.66, [("1号機", 486)]),
    ("三隅発電所", "デモ電力", "石炭", "CHUGOKU", 34.78, 131.97, [("1号機", 1000)]),
    ("島根原子力発電所", "デモ電力", "原子力", "CHUGOKU", 35.54, 133.00, [("2号機", 820)]),
    ("坂出発電所", "デモ電力", "LNG", "SHIKOKU", 34.33, 133.83, [("4号機", 296)]),
    ("伊方発電所", "デモ電力", "原子力", "SHIKOKU", 33.49, 132.31, [("3号機", 890)]),
    ("川内原子力発電所", "デモ電力", "原子力", "KYUSHU", 31.83, 130.19,
     [("1号機", 890), ("2号機", 890)]),
    ("松浦火力発電所", "デモ電力", "石炭", "KYUSHU", 33.36, 129.69, [("2号機", 1000)]),
    ("デモ五島ウィンド", "デモ新電力", "風力", "KYUSHU", 32.70, 128.80, [("単独", 80)]),
    ("吉の浦火力発電所", "デモ電力", "LNG", "OKINAWA", 26.32, 127.83, [("1号機", 251)]),
    # 非公開ユニットのデモ（製鉄系共同火力を模した架空プラント）
    ("デモ製鉄共同火力", "デモ製鉄", "その他", "TOKYO", 35.50, 140.10, [("1号機", 280)]),
    # 廃止ユニットのデモ（実績が途中で途絶＝過去のみ表示）
    ("デモ旧火力発電所", "デモ電力", "石油", "KANSAI", 34.60, 135.40, [("1号機", 600)]),
]


def fuel_factor(fuel: str, hour: float, r: random.Random) -> float:
    """燃料種別ごとの簡易な出力率（0..1）。合成。"""
    peak = max(0.0, math.sin(math.pi * (hour - 6) / 16))
    if fuel in ("原子力", "地熱"):
        return 0.92 + 0.04 * (r.random() - 0.5)
    if fuel == "石炭":
        return 0.80 + 0.12 * peak + 0.05 * (r.random() - 0.5)
    if fuel == "LNG":
        return 0.25 + 0.5 * peak + 0.06 * (r.random() - 0.5)
    if fuel == "石油":
        return (0.05 + 0.45 * peak) if 9 <= hour <= 21 else 0.0
    if fuel == "水力":
        return 0.40 + 0.25 * peak + 0.08 * (r.random() - 0.5)
    if fuel == "太陽光":
        if hour < 5 or hour > 19:
            return 0.0
        bell = max(0.0, math.sin(math.pi * (hour - 5) / 14))
        return bell * (0.5 + 0.4 * r.random())
    if fuel == "風力":
        return 0.12 + 0.55 * r.random()
    return 0.4 + 0.2 * peak


def main() -> None:
    DOCS.mkdir(exist_ok=True)

    plants_out = []
    units_out = []       # [pi, uj, code, rawName, master, flags]
    occ_series = []      # (key, from_min, vals[])
    uidx = {}            # (発電所名, ユニット名) -> 全体ユニット番号
    code_n = 0

    now_min = jst_min(NOW)
    base = NOW.replace(hour=0, minute=0) - timedelta(days=OCCTO_DAYS)
    base_min = jst_min(base)
    full_len = OCCTO_DAYS * 48 + 24       # NOW(12:00) まで

    for pi, (name, op, fuel, area, lat, lon, units) in enumerate(PLANTS_SRC):
        is_private = name == "デモ製鉄共同火力"
        is_haishi = name == "デモ旧火力発電所"
        u_arr = []
        for uj, (uname, cap) in enumerate(units):
            code_n += 1
            code = f"D{code_n:04d}"
            flags = 1 if is_haishi else 0      # bit1=廃止
            uidx[(name, uname)] = len(units_out)
            units_out.append([pi, uj, code, uname, 1, flags])
            u_arr.append([uname, cap])

            if is_private:
                continue                       # OCCTO 実績なし → 非公開表示

            # 廃止ユニットは NOW の約35日前で実績が途絶える
            length = (OCCTO_DAYS - 35) * 48 if is_haishi else full_len
            r = random.Random(hash(code) & 0xFFFFFFFF)
            vals = []
            for i in range(length):
                t = base + timedelta(minutes=30 * i)
                hour = t.hour + t.minute / 60.0
                f = max(0.0, min(1.0, fuel_factor(fuel, hour, r)))
                mw10 = round(cap * f * 10)      # 0.1MW 単位
                vals.append(min(mw10 + 1, 65535) if mw10 > 0 else 0)
            occ_series.append((f"{code}/{uname}", base_min, vals))

        plants_out.append([name, op, fuel, area, lat, lon, 0, u_arr])

    # --- 合成 HJKS イベント（一部の発電所を停止/出力低下に）---
    assortments = ["計画停止", "計画外停止", "出力低下"]
    notes = {}
    events = []
    day = timedelta(days=1)

    def add_event(plant, unit, kind, cap, f_dt, t_dt, ai, note=""):
        ui = uidx[(plant, unit)]
        events.append([ui, kind, cap, jst_min(f_dt), jst_min(t_dt), ai])
        if jst_min(t_dt) >= now_min:
            notes[str(len(events) - 1)] = note

    add_event("泊発電所", "3号機", 0, 0.0,
              NOW - 20 * day, NOW + 40 * day, 0, "定期検査中（デモ）")
    add_event("苫東厚真発電所", "4号機", 1, 400.0,
              NOW - 2 * day, NOW + 5 * day, 2, "出力抑制（デモ）")
    add_event("高浜発電所", "4号機", 0, 0.0,
              NOW - 8 * day, NOW + 15 * day, 1, "計画外停止（デモ）")
    add_event("碧南火力発電所", "5号機", 1, 600.0,
              NOW - 3 * day, NOW + 4 * day, 2, "出力抑制（デモ）")
    events.sort(key=lambda e: (e[0], e[3]))

    hjks = {
        "generated": NOW.strftime("%Y-%m-%d %H:%M") + "（デモ・合成データ）",
        "plants": plants_out,
        "units": units_out,
        "events": events,
        "assortments": assortments,
        "notes": notes,
    }

    # --- OCCTO バイナリ（Uint16 base64）---
    series_meta = []
    all_vals = []
    offset = 0
    for key, frm, vals in occ_series:
        series_meta.append([key, frm, offset, len(vals)])
        all_vals.extend(vals)
        offset += len(vals)
    buf = array.array("H", all_vals)
    occto = {
        "generated": NOW.strftime("%Y-%m-%d %H:%M") + "（デモ・合成データ）",
        "step": 30,
        "seriesMeta": series_meta,
        "data": base64.b64encode(buf.tobytes()).decode("ascii"),
    }

    head = "// デモ用・合成データ（実データではありません）\n"
    hjks_js = json.dumps(hjks, ensure_ascii=False, separators=(",", ":"))
    occto_js = json.dumps(occto, ensure_ascii=False, separators=(",", ":"))
    (DOCS / "hjks_data.js").write_text(
        head + "const HJKS = " + hjks_js + ";\n", encoding="utf-8")
    (DOCS / "occto_data.js").write_text(
        head + "const OCCTO = " + occto_js + ";\n", encoding="utf-8")

    # --- コードをコピー（index.html はデモ表記に差し替え）---
    for fn in ("styles.css", "data.js", "sim.js", "app.js"):
        shutil.copyfile(HERE / fn, DOCS / fn)
    html = (HERE / "index.html").read_text(encoding="utf-8")
    html = html.replace(
        "停止情報: HJKS実データ / 発電実績: OCCTO実データ（非公開ユニットは合成値）",
        "⚠ デモ（サンプル合成データ・実データではありません）")
    (DOCS / "index.html").write_text(html, encoding="utf-8")

    n_units = len(units_out)
    sz = (DOCS / "occto_data.js").stat().st_size / 1e6
    print(f"docs/ 生成完了: {len(plants_out)}発電所 / {n_units}ユニット / "
          f"OCCTO {len(series_meta)}系列 / occto_data.js {sz:.2f}MB")


if __name__ == "__main__":
    main()
