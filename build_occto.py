# /// script
# requires-python = ">=3.11"
# dependencies = ["pyarrow"]
# ///
"""OCCTO CSVs → occto_data.js

data/occto_*_*_*_*.csv を Parquet に中間保存し、Uint16 base64 形式で
occto_data.js (const OCCTO = {...}) を出力する。

OCCTO と HJKS は発電所コード体系が一部異なる（特に JERA は完全に別系統）。
そこで OCCTO の各系列を段階照合で HJKS ユニットへ解決し、出力キーを
HJKS の "発電所コード/ユニット名"（= sim.js の OCCTO_KEY_BY_UID）に揃える。
これにより sim.js / app.js は無変更で実データを参照できる。

  ※ hjks_data.js を先に生成しておく必要がある（HJKS マスタを読むため）。

【出力フォーマット】
  seriesMeta: [[key, from_utcmin, offset, length], ...]
    key    : HJKS 側 "発電所コード/ユニット名"  例: "31202/柏崎刈羽6号機"
    from   : 系列先頭スロット開始の UTC epoch 分
    offset : data 配列内の先頭インデックス
    length : スロット数
  data   : Uint16Array (little-endian) を base64 エンコード
    0      → 欠損（-1 → 0 変換）
    v+1    → v × 0.1 MW  (max 65534 → 6553.4 MW)

Usage: uv run build_occto.py
"""

from __future__ import annotations

import array
import base64
import csv
import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).parent
DATA = HERE / "data"
PARQUET_PATH = DATA / "occto_all.parquet"
HJKS_JS = HERE / "hjks_data.js"

JST = timezone(timedelta(hours=9))
EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)

ZEN2HAN = str.maketrans("０１２３４５６７８９（）　", "0123456789() ")


def norm(s: str) -> str:
    return (s or "").translate(ZEN2HAN).strip()


# ---------------------------------------------------------------------------
# OCCTO↔HJKS 照合用の正規化（_analyze_join.js と同等のロジック）
# ---------------------------------------------------------------------------
_DASH_RE = re.compile(r"[‐‑‒–—―−ー－~〜]")
_PREF_RE = re.compile(
    r"^(北海道|東北|東京|中部|北陸|関西|中国|四国|九州|沖縄)"
    r"電力(ホールディングス|フュエル.?&?パワー|エナジーパートナー)?"
)
_PREF2_RE = re.compile(r"^(電源開発|JERA|日本製鉄|JFEスチール|日立造船)")
_UNUM_RE = re.compile(r"(新)?([0-9][0-9-]*)号")
_GT_RE = re.compile(r"GT([0-9]*)", re.IGNORECASE)


def _zen(s: str) -> str:
    return (s or "").translate(ZEN2HAN)


def ukey(s: str) -> str:
    """ユニット名の正準化（全半角・各種ダッシュ・号機/号/軸を吸収）。"""
    n = _DASH_RE.sub("-", _zen(s).strip())
    n = n.replace("号機", "号").replace("軸", "号")
    return re.sub(r"\s+", "", n)


def pkey(s: str) -> str:
    """発電所名の正準化（会社名・事業者プレフィックス・ユニット番号を除去）。"""
    n = _zen(s).replace(" ", "")
    n = re.sub(r"(株式会社|合同会社|有限会社|\(株\)|㈱|合資会社)", "", n)
    n = re.sub(r"\(.*?\)", "", n)
    n = _PREF_RE.sub("", n)
    n = _PREF2_RE.sub("", n)
    n = re.sub(r"[0-9].*$", "", n)
    return re.sub(r"新$", "", n)


def unum(s: str) -> str:
    """ユニット番号トークンを抽出（例: 姉崎新3号→新3, 千葉1-1号→1-1, 1号機→1）。"""
    n = ukey(s)
    m = _UNUM_RE.search(n)
    if m:
        return (m.group(1) or "") + m.group(2)
    m = _GT_RE.search(n)
    if m:
        return "GT" + m.group(1)
    return n


# 48 スロット: "00:30", "01:00", ..., "24:00"
SLOT_LABELS: list[str] = []
for _h in range(25):
    for _m in [0, 30]:
        if _h == 0 and _m == 0:
            continue
        if _h == 24 and _m == 30:
            break
        SLOT_LABELS.append(f"{_h:02d}:{_m:02d}")
assert len(SLOT_LABELS) == 48, f"スロット数異常: {len(SLOT_LABELS)}"


def jst_date_to_utc_min(date_str: str) -> int:
    """'YYYY/MM/DD' JST → その日 00:00 JST の UTC epoch 分。"""
    dt = datetime.strptime(date_str, "%Y/%m/%d").replace(tzinfo=JST)
    return int((dt - EPOCH).total_seconds()) // 60


def needs_rebuild() -> bool:
    if not PARQUET_PATH.exists():
        return True
    # 旧スキーマ（plant 列なし）は強制再構築
    if "plant" not in pq.ParquetFile(PARQUET_PATH).schema_arrow.names:
        print("Parquet に plant 列なし → 再構築")
        return True
    pq_mtime = PARQUET_PATH.stat().st_mtime
    csv_files = list(DATA.glob("occto_*_*_*_*.csv"))
    if not csv_files:
        return False
    return max(f.stat().st_mtime for f in csv_files) > pq_mtime


def rebuild_parquet(csv_files: list[Path]) -> None:
    print(f"Parquet 再構築: {len(csv_files)} CSV ...")
    codes: list[str] = []
    plants: list[str] = []
    units: list[str] = []
    dates: list[str] = []
    slot_cols: list[list[int]] = [[] for _ in range(48)]

    for path in csv_files:
        with open(path, encoding="utf-8-sig", newline="") as f:
            for row in csv.DictReader(f):
                code = (row.get("発電所コード") or "").strip()
                unit = norm(row.get("ユニット名") or "")
                plant = (row.get("発電所名") or "").strip()
                date_str = (row.get("対象日") or "").strip()
                if not code or not unit or not date_str:
                    continue
                codes.append(code)
                plants.append(plant)
                units.append(unit)
                dates.append(date_str)
                for si, label in enumerate(SLOT_LABELS):
                    val_str = (row.get(f"{label}[kWh]") or "").strip()
                    try:
                        slot_cols[si].append(int(val_str))
                    except ValueError:
                        slot_cols[si].append(-1)

    table = pa.table({
        "code": pa.array(codes, type=pa.string()),
        "plant": pa.array(plants, type=pa.string()),
        "unit": pa.array(units, type=pa.string()),
        "date": pa.array(dates, type=pa.string()),
        **{f"s{i}": pa.array(slot_cols[i], type=pa.int32())
           for i in range(48)},
    })
    pq.write_table(table, PARQUET_PATH, compression="snappy")
    sz = PARQUET_PATH.stat().st_size / 1e6
    print(f"  → {PARQUET_PATH.name} ({sz:.1f} MB, {len(codes):,} 行)")


def load_raw_from_parquet():
    """Parquet → (raw[(code,unit)]={utc_min:kWh}, plant_of[(code,unit)]=名)"""
    table = pq.read_table(PARQUET_PATH)
    col_code = table["code"].to_pylist()
    col_plant = table["plant"].to_pylist()
    col_unit = table["unit"].to_pylist()
    col_date = table["date"].to_pylist()
    slot_data = [table[f"s{i}"].to_pylist() for i in range(48)]

    raw: dict[tuple[str, str], dict[int, int]] = {}
    plant_of: dict[tuple[str, str], str] = {}
    n = len(col_code)
    for i in range(n):
        code, unit, date_str = col_code[i], col_unit[i], col_date[i]
        try:
            base_min = jst_date_to_utc_min(date_str)
        except ValueError:
            continue
        key: tuple[str, str] = (code, unit)
        plant_of.setdefault(key, col_plant[i])
        slots = raw.setdefault(key, {})
        for si in range(48):
            val = slot_data[si][i]
            if val >= 0:
                slots[base_min + si * 30] = val  # raw kWh
    return raw, plant_of


# ---------------------------------------------------------------------------
# HJKS マスタの読み込みと OCCTO→HJKS 段階照合
# ---------------------------------------------------------------------------
def load_hjks_units() -> list[dict]:
    """hjks_data.js から HJKS ユニット一覧（code, raw, plant, op, master）を読む。"""
    txt = HJKS_JS.read_text(encoding="utf-8")
    obj = json.loads(txt[txt.index("{"):txt.rindex("}") + 1])
    out = []
    for rec in obj["units"]:
        pi, _uj, code, raw_name = rec[0], rec[1], rec[2], rec[3]
        master = bool(rec[4]) if len(rec) > 4 else True
        p = obj["plants"][pi]
        out.append({"code": code, "raw": raw_name, "plant": p[0],
                    "op": p[1], "master": master})
    return out


def build_hjks_index(units: list[dict]) -> dict[str, dict]:
    idx = {k: {} for k in ("code", "codeU", "uk", "pu", "pk")}

    def push(m, key, u):
        m.setdefault(key, []).append(u)

    for u in units:
        push(idx["code"], u["code"], u)
        push(idx["codeU"], f'{u["code"]}/{unum(u["raw"])}', u)
        push(idx["uk"], ukey(u["raw"]), u)
        push(idx["pu"], f'{pkey(u["plant"])}/{unum(u["raw"])}', u)
        push(idx["pk"], pkey(u["plant"]), u)
    return idx


def _pk_compat(a: str, b: str) -> bool:
    """発電所名の整合（一致 or 一方が他方を含む）。uk ティアの誤マッチ防止。"""
    return bool(a) and bool(b) and (a == b or a in b or b in a)


def _resolve_one(o_code: str, o_plant: str, o_unit: str,
                 idx: dict[str, dict]):
    """単一インデックスに対する段階照合（一意な段階のみ採用）。

    code / codeU は登録コード一致なので無条件採用。uk（ユニット名一意）は
    発電所名の整合を要求し、別発電所への誤接続（例: 上越2-1号機→柳井2-1号）を防ぐ。
    """
    pk_o = pkey(o_plant)
    candidates = [
        (idx["code"], o_code, False),
        (idx["codeU"], f"{o_code}/{unum(o_unit)}", False),
        (idx["uk"], ukey(o_unit), True),
        (idx["pu"], f"{pk_o}/{unum(o_unit)}", False),
        (idx["pk"], pk_o, False),
    ]
    for table, key, need_compat in candidates:
        cand = table.get(key)
        if cand and len(cand) == 1:
            if need_compat and not _pk_compat(pk_o, pkey(cand[0]["plant"])):
                continue
            return cand[0]
    return None


def resolve_to_hjks(o_code: str, o_plant: str, o_unit: str,
                    idx_master: dict[str, dict], idx_all: dict[str, dict]):
    """2段階照合: まずマスタ在籍ユニットのみで解決し、無ければ全ユニットで解決。

    多軸機（上越1-1号=系列マスタ595MW と 1-1GTB=軸194MW の二重登録）や
    五井（JERA新設=マスタ と 旧TEPCO F&P=停止情報のみ）のような重複時に、
    現行マスタ（系列・稼働中）を優先することで実績を正しい単位へ接続する。
    """
    return (_resolve_one(o_code, o_plant, o_unit, idx_master)
            or _resolve_one(o_code, o_plant, o_unit, idx_all))


def main() -> None:
    csv_files = sorted(DATA.glob("occto_*_*_*_*.csv"))
    print(f"CSV ファイル数: {len(csv_files)}")

    if needs_rebuild():
        rebuild_parquet(csv_files)
    else:
        print(f"Parquet 最新 ({PARQUET_PATH.name}), 再構築スキップ")

    print("Parquet 読み込み中 ...")
    raw, plant_of = load_raw_from_parquet()
    print(f"OCCTO 系列数: {len(raw)}")

    # HJKS マスタを読み、OCCTO 各系列を HJKS の code/rawName へ解決（マスタ優先）
    hjks_units = load_hjks_units()
    idx_master = build_hjks_index([u for u in hjks_units if u["master"]])
    idx_all = build_hjks_index(hjks_units)
    n_master = sum(1 for u in hjks_units if u["master"])
    print(f"HJKS ユニット数: {len(hjks_units)} (うちマスタ在籍 {n_master})")

    series_meta: list[list] = []  # [key, from_min, offset, length]
    all_vals: list[int] = []
    offset = 0
    matched = 0
    unmatched: list[tuple[str, str, str]] = []
    seen_keys: set[str] = set()

    for (code, unit), slots in sorted(raw.items()):
        if not slots:
            continue
        o_plant = plant_of.get((code, unit), "")
        hu = resolve_to_hjks(code, o_plant, unit, idx_master, idx_all)
        if hu is None:
            unmatched.append((code, o_plant, unit))
            continue
        key_str = f'{hu["code"]}/{hu["raw"]}'  # HJKS 側キー（sim.js と一致）
        if key_str in seen_keys:
            # 複数 OCCTO 系列が同一 HJKS に解決（GT/ST 分割等）→ 先勝ち
            continue
        seen_keys.add(key_str)
        matched += 1

        first = min(slots)
        last = max(slots)
        n = (last - first) // 30 + 1
        series_meta.append([key_str, first, offset, n])
        for i in range(n):
            kWh = slots.get(first + i * 30, -1)
            # kWh → 0.1 MW 単位 (30分発電量[kWh] / 50 = 平均出力[0.1 MW])
            # 0=欠損, v+1=v×0.1MW (Uint16 sentinel)
            if kWh < 0:
                all_vals.append(0)
            else:
                all_vals.append(min(round(kWh / 50) + 1, 65535))
        offset += n

    print(f"HJKS へ解決: {matched} 系列 / 未解決 {len(unmatched)} 系列")
    if unmatched:
        print("  未解決(先頭15): "
              + ", ".join(f"{c}:{u}" for c, _p, u in unmatched[:15]))

    all_u16 = array.array('H', all_vals)
    total_slots = len(all_u16)
    valid_slots = sum(1 for v in all_u16 if v > 0)
    print(f"総スロット: {total_slots:,} / 有効: {valid_slots:,} "
          f"({valid_slots / total_slots * 100:.1f}%)")

    data_b64 = base64.b64encode(all_u16.tobytes()).decode('ascii')

    payload = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "step": 30,
        "seriesMeta": series_meta,
        "data": data_b64,
    }
    js = (
        "// build_occto.py で自動生成\n"
        "// 出典: 電力広域的運営推進機関（OCCTO）ユニット別発電実績公開システム\n"
        "const OCCTO = "
        + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        + ";\n"
    )
    out = HERE / "occto_data.js"
    out.write_text(js, encoding="utf-8")
    size_mb = out.stat().st_size / 1e6
    print(f"occto_data.js: {size_mb:.2f} MB ({len(series_meta)} ユニット)")


if __name__ == "__main__":
    main()
