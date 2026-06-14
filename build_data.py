# /// script
# requires-python = ">=3.11"
# ///
"""HJKS 生データ → アプリ用コンパクトデータ (hjks_data.js) 変換

レスポンス重視の設計:
  - ブラウザには整形済み・重複排除済みのデータだけを渡す
  - 日時は「epoch 分 (UTC)」の数値に事前変換（ブラウザ側で Date パース不要）
  - 発電所・ユニットはインデックス参照の配列でコンパクトに

入力 (fetch_hjks.py の出力):
  data/hjks_unit_latest.csv     発電所・ユニットマスタ
  data/hjks_outages_latest.csv  停止・出力低下情報

出力:
  hjks_data.js        アプリが読み込むデータ (const HJKS = {...})
  data/build_report.txt  変換統計（座標未登録の大規模発電所一覧など）

使い方: uv run build_data.py
"""

from __future__ import annotations

import csv
import json
import re
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).parent
DATA = HERE / "data"          # OCCTO/HJKS 生データ（公開不可・gitignore）
MASTER = HERE / "master"      # 手動管理メタデータ（廃止リスト等・公開可）

JST_OFFSET_MIN = 9 * 60
EPOCH = datetime(1970, 1, 1)
FAR_FUTURE_MIN = 4102444800 // 60  # 2100年

AREA_IDS = {
    "北海道": "HOKKAIDO", "東北": "TOHOKU", "東京": "TOKYO",
    "中部": "CHUBU", "北陸": "HOKURIKU", "関西": "KANSAI",
    "中国": "CHUGOKU", "四国": "SHIKOKU", "九州": "KYUSHU",
    "沖縄": "OKINAWA",
}
AREA_CENTER = {
    "HOKKAIDO": (43.3, 142.5), "TOHOKU": (39.2, 140.7),
    "TOKYO": (35.9, 139.9), "CHUBU": (35.2, 137.4),
    "HOKURIKU": (36.5, 136.9), "KANSAI": (34.9, 135.5),
    "CHUGOKU": (34.7, 132.8), "SHIKOKU": (33.8, 133.6),
    "KYUSHU": (32.8, 130.7), "OKINAWA": (26.4, 127.9),
}
FUEL_MAP = {
    "原子力": "原子力", "火力（石炭）": "石炭", "火力（ガス）": "LNG",
    "火力（石油）": "石油", "水力": "水力", "地熱": "地熱",
    "風力": "風力", "太陽光・太陽熱": "太陽光", "その他": "その他",
    "": "その他",
}

# 主要発電所の座標表（部分一致、長いキー優先）。±0.1度程度の概算。
# 未登録は build_report.txt に出るので、必要に応じてここに追記する。
COORDS = {
    # 原子力
    "泊発電所": (43.04, 140.51), "東通": (41.19, 141.39),
    "女川": (38.40, 141.50), "福島第一": (37.42, 141.03),
    "福島第二": (37.32, 141.03), "柏崎刈羽": (37.43, 138.60),
    "東海第二": (36.47, 140.61), "浜岡": (34.62, 138.14),
    "志賀": (37.06, 136.73), "美浜": (35.70, 135.96),
    "高浜": (35.52, 135.50), "大飯": (35.54, 135.65),
    "敦賀発電所": (35.67, 136.08), "島根原子力": (35.54, 133.00),
    "伊方": (33.49, 132.31), "玄海": (33.52, 129.84),
    "川内原子力": (31.83, 130.19),
    # 北海道 火力
    "苫東厚真": (42.71, 141.86), "伊達発電所": (42.46, 140.86),
    "知内": (41.61, 140.41), "苫小牧": (42.63, 141.61),
    "砂川": (43.49, 141.90), "奈井江": (43.42, 141.88),
    "音別": (42.93, 143.49), "石狩湾新港": (43.20, 141.27),
    # 東北 火力
    "八戸": (40.53, 141.53), "能代": (40.20, 140.05),
    "秋田": (39.75, 140.06), "新仙台": (38.21, 141.01),
    "仙台火力": (38.30, 141.03), "原町": (37.62, 141.02),
    "東新潟": (37.97, 139.26), "新潟": (37.95, 139.20),
    # 東京 火力
    "広野": (37.21, 141.00), "常陸那珂": (36.40, 140.62),
    "鹿島": (35.93, 140.69), "千葉火力": (35.57, 140.09),
    "五井": (35.52, 140.07), "姉崎": (35.47, 140.04),
    "袖ケ浦": (35.42, 139.97), "袖ヶ浦": (35.42, 139.97),
    "富津": (35.32, 139.79), "横浜火力": (35.46, 139.66),
    "南横浜": (35.42, 139.63), "磯子": (35.39, 139.63),
    "横須賀": (35.22, 139.72), "川崎火力": (35.50, 139.75),
    "東扇島": (35.50, 139.75), "品川": (35.61, 139.75),
    "大井火力": (35.59, 139.76), "上越": (37.18, 138.21),
    "鶴見": (35.49, 139.69), "蘇我": (35.58, 140.13),
    "君津": (35.32, 139.88), "市原": (35.49, 140.09),
    "真岡": (36.43, 140.00), "五泉": (37.74, 139.18),
    # 中部 火力
    "碧南": (34.79, 136.99), "知多第二": (34.99, 136.84),
    "知多": (34.99, 136.84), "西名古屋": (35.05, 136.81),
    "新名古屋": (35.07, 136.86), "川越火力": (35.00, 136.68),
    "四日市": (34.95, 136.64), "渥美": (34.63, 137.17),
    "武豊": (34.84, 136.92), "田原": (34.64, 137.19),
    # 北陸 火力
    "七尾大田": (37.05, 136.95), "敦賀火力": (35.66, 136.08),
    "福井火力": (36.13, 136.10), "富山新港": (36.78, 137.13),
    # 関西 火力
    "舞鶴": (35.51, 135.31), "宮津": (35.57, 135.22),
    "高砂": (34.74, 134.80), "姫路第一": (34.77, 134.72),
    "姫路第二": (34.78, 134.66), "赤穂": (34.74, 134.40),
    "相生": (34.78, 134.47), "南港": (34.62, 135.43),
    "堺港": (34.57, 135.44), "多奈川": (34.32, 135.13),
    "御坊": (33.85, 135.16), "和歌山共同": (34.20, 135.13),
    "海南": (34.15, 135.20),
    # 中国 火力
    "水島": (34.50, 133.74), "玉島": (34.52, 133.67),
    "新小野田": (34.00, 131.15), "下関": (33.96, 130.93),
    "柳井": (33.95, 132.11), "岩国": (34.14, 132.23),
    "大崎": (34.24, 132.91), "竹原": (34.32, 132.94),
    "三隅": (34.78, 131.97), "坂発電所": (34.33, 132.51),
    "福山共同": (34.45, 133.44), "倉敷共同": (34.50, 133.76),
    # 四国 火力
    "坂出": (34.33, 133.83), "西条": (33.93, 133.19),
    "阿南": (33.93, 134.66), "橘湾": (33.86, 134.65),
    # 九州 火力
    "苅田": (33.78, 131.02), "新小倉": (33.91, 130.93),
    "戸畑": (33.90, 130.86), "苓北": (32.45, 130.02),
    "松浦": (33.36, 129.69), "相浦": (33.20, 129.66),
    "川内火力": (31.85, 130.20), "新大分": (33.27, 131.74),
    "大村": (32.92, 129.96), "港発電所": (33.60, 130.40),
    "豊前": (33.62, 131.12), "大分共同": (33.25, 131.68),
    "戸畑共同": (33.90, 130.86), "鶴崎": (33.24, 131.70),
    # 沖縄
    "吉の浦": (26.32, 127.83), "具志川": (26.36, 127.85),
    "金武": (26.45, 127.92), "石川": (26.42, 127.83),
    "牧港": (26.27, 127.72), "うるま": (26.37, 127.86),
    # 水力・揚水（大規模）
    "奥只見": (37.15, 139.25), "田子倉": (37.29, 139.30),
    "奥清津": (36.83, 138.78), "今市": (36.69, 139.61),
    "川治": (36.85, 139.70), "塩原": (36.92, 139.83),
    "玉原": (36.71, 139.06), "神流川": (36.06, 138.71),
    "矢木沢": (36.89, 139.06), "安曇": (36.16, 137.78),
    "新高瀬川": (36.44, 137.76), "高瀬川": (36.44, 137.76),
    "奥矢作": (35.19, 137.43), "井川": (35.21, 138.23),
    "畑薙": (35.31, 138.20), "黒部川第四": (36.57, 137.66),
    "奥多々良木": (35.27, 134.77), "大河内": (35.06, 134.70),
    "喜撰山": (34.87, 135.83), "奥吉野": (34.12, 135.79),
    "池原": (34.13, 136.01), "小丸川": (32.27, 131.30),
    "天山": (33.43, 130.16), "大平": (32.55, 130.62),
    "本川": (33.76, 133.32), "俣野川": (35.24, 133.55),
    "新成羽川": (34.78, 133.45), "南原": (34.49, 132.51),
    "京極": (42.86, 140.93), "新冠": (42.41, 142.42),
    "高見": (42.43, 142.65), "静内": (42.40, 142.40),
    "上椎葉": (32.46, 131.16), "一ツ瀬": (32.18, 131.32),
    "佐久間": (35.10, 137.79), "新豊根": (35.13, 137.74),
    "御母衣": (36.13, 136.92), "手取川": (36.25, 136.62),
    "有峰": (36.47, 137.45), "葛野川": (35.66, 138.87),
    "塩川": (37.46, 139.85), "下郷": (37.25, 139.78),
    "第二沼沢": (37.45, 139.55), "沼原": (36.96, 139.96),
    "蛇尾川": (36.93, 139.92), "渋川": (34.95, 134.30),
    # 地熱
    "八丁原": (33.09, 131.21), "大岳": (33.10, 131.20),
    "滝上": (33.08, 131.18), "山川": (31.20, 130.61),
    "森発電所": (42.12, 140.62), "葛根田": (39.85, 140.93),
    "松川": (39.87, 140.95), "柳津西山": (37.46, 139.65),
    "上の岱": (39.02, 140.62), "澄川": (39.97, 140.75),
    # 共同火力・IPP・自家発系（build_report の上位から追補）
    "新地火力": (37.85, 140.92), "奥美濃": (35.75, 136.78),
    "勿来": (36.93, 140.78), "神戸発電所": (34.68, 135.28),
    "姫路天然ガス": (34.79, 134.67), "扇島": (35.48, 139.71),
    "福島天然ガス": (37.88, 140.92), "松島火力": (32.95, 129.59),
    "川内発電所": (31.85, 130.20), "川崎発電所": (35.52, 139.70),
    "尾鷲三田": (34.07, 136.21), "川崎天然ガス": (35.51, 139.73),
    "酒田共同": (38.97, 139.82), "下松": (34.00, 131.87),
    "ひびき": (33.93, 130.77), "泉北天然ガス": (34.53, 135.42),
    "千葉クリーンパワー": (35.58, 140.10), "徳山製造所": (34.05, 131.80),
    "トクヤマ東": (34.05, 131.82), "根岸": (35.40, 139.63),
    "大分製鐵": (33.27, 131.68), "馬瀬川": (35.92, 137.20),
    "富山火力": (36.76, 137.22), "壬生川": (33.90, 133.10),
    "出光愛知": (34.93, 136.83), "中袖": (35.37, 139.92),
    "小千谷": (37.31, 138.80), "水江": (35.51, 139.72),
    "三池": (33.01, 130.43), "土佐発電所": (33.55, 133.67),
    "宇部": (33.95, 131.25),
    # 概算配置だった発電所の座標調査による追補（共同火力・IPP・バイオマス・水力等）
    # ※確証が持てない一部はあえて未登録のまま（data/approx_plants_review.csv 参照）
    "釧路火力": (42.97, 144.38), "石巻雲雀野": (38.41, 141.30),
    "仙台パワーステーション": (38.26, 140.99), "仙台港バイオマス": (38.26, 141.00),
    "東日本製鉄所(千葉地区)": (35.566, 140.118),  # JFE千葉(西/コンバインド両方)
    "神栖火力": (35.88, 140.68), "麻里布": (34.16, 132.21),
    "大分 第2": (33.26, 131.74), "徳山発電所": (35.67, 136.43),  # 中部電力・徳山ダム水力
    "鈴川エネルギー": (35.16, 138.71), "糸魚川発電": (37.04, 137.85),
    "海田発電": (34.36, 132.53), "音沢": (36.82, 137.56),
    "下小鳥": (36.35, 137.10), "酉島エネルギー": (34.68, 135.42),
    "船町発電": (34.64, 135.46), "室蘭中央": (42.34, 140.95),
    "釜石火力": (39.27, 141.89), "広畑発電": (34.78, 134.62),
    "防府バイオマス": (34.03, 131.58), "酸素吹石炭ガス化": (34.24, 132.89),  # 大崎クールジェン
    "新居浜西": (33.96, 133.28), "響灘火力": (33.93, 130.77),
    "相馬石炭": (37.83, 140.97), "豊橋発電": (34.73, 137.35),  # 明海発電・三河港
    "大阪製油所": (34.55, 135.42),
}
# 長いキー優先で照合（「新大分」が「大分」より先に当たるように）
COORDS_SORTED = sorted(COORDS.items(), key=lambda kv: -len(kv[0]))

ZEN2HAN = str.maketrans("０１２３４５６７８９（）　", "0123456789() ")
UNIT_SUFFIX_RE = re.compile(
    r"(新?[0-9]+号.*$)|(GT[0-9]*号?.*$)|([0-9]+号$)"
)


def norm(s: str) -> str:
    return (s or "").translate(ZEN2HAN).strip()


def basename(name: str) -> str:
    """発電所名から号機サフィックスを除いた発電所グループ名を返す。"""
    n = norm(name)
    n = UNIT_SUFFIX_RE.sub("", n).strip()
    return n or norm(name)


def to_min(s: str) -> int | None:
    """'2026/06/13 00:59' or '2026/06/13' (JST) → epoch分(UTC)。"""
    s = norm(s)
    if not s:
        return None
    for fmt in ("%Y/%m/%d %H:%M", "%Y/%m/%d"):
        try:
            dt = datetime.strptime(s, fmt)
            break
        except ValueError:
            continue
    else:
        return None
    if dt.year >= 2100:
        return FAR_FUTURE_MIN
    return int((dt - EPOCH).total_seconds() // 60) - JST_OFFSET_MIN


def jitter(key: str) -> tuple[float, float]:
    """発電所キーから決定論的なオフセット（±0.6度）を作る。"""
    h = 2166136261
    for c in key:
        h = ((h ^ ord(c)) * 16777619) & 0xFFFFFFFF
    dx = ((h & 0xFFFF) / 0xFFFF - 0.5) * 1.2
    dy = (((h >> 16) & 0xFFFF) / 0xFFFF - 0.5) * 1.2
    return dx, dy


def find_coords(name: str) -> tuple[float, float] | None:
    n = norm(name)
    for key, ll in COORDS_SORTED:
        if key in n:
            return ll
    return None


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8-sig", newline="") as f:
        return [
            {(k or "").strip(): (v or "").strip() for k, v in row.items()
             if k is not None}
            for row in csv.DictReader(f)
        ]


# 多軸機の軸別サブユニット判定（GT/ST/軸 を含む名称。全角ＧＴ/ＳＴも吸収）
SHAFT_RE = re.compile(r"(GT[A-D]?|ST[A-D]?|軸)$")
ZEN_ALPHA = str.maketrans("ＡＢＣＤＧＳＴ", "ABCDGST")


def is_shaft(raw_name: str) -> bool:
    n = norm(raw_name).translate(ZEN_ALPHA)
    return bool(SHAFT_RE.search(n))


def load_haishi_lists() -> tuple[set[tuple[str, str]], set[tuple[str, str]]]:
    """廃止リストを読み込み (廃止集合, 要確認集合) を返す。

    - master/haishi_units.csv          : 全行を廃止扱い
    - master/haishi_review.csv (判定列) : 「廃止」→廃止 / 「要確認」→要確認
    重複時は廃止を優先。
    """
    haishi: set[tuple[str, str]] = set()
    review: set[tuple[str, str]] = set()

    upath = MASTER / "haishi_units.csv"
    if upath.exists():
        for row in read_csv(upath):
            code = row.get("発電所コード", "")
            unit = norm(row.get("ユニット名", ""))
            if code and unit:
                haishi.add((code, unit))

    rpath = MASTER / "haishi_review.csv"
    if rpath.exists():
        for row in read_csv(rpath):
            code = row.get("コード", "")        # review CSV は列名が「コード」
            unit = norm(row.get("ユニット名", ""))
            judge = row.get("判定", "")
            if not code or not unit:
                continue
            if judge == "廃止":
                haishi.add((code, unit))
            elif judge == "要確認":
                review.add((code, unit))

    review -= haishi          # 廃止優先
    return haishi, review


def main() -> None:
    units_raw = read_csv(DATA / "hjks_unit_latest.csv")
    outs_raw = read_csv(DATA / "hjks_outages_latest.csv")
    haishi, review = load_haishi_lists()

    # ---- 発電所のグルーピング（事業者 + 発電所グループ名 + エリア）----
    plants: dict[tuple, dict] = {}
    uid_index: dict[tuple, int] = {}   # (発電所コード, ユニット名) -> unit番号
    all_units: list[dict] = []

    def add_unit(row: dict, from_master: bool) -> None:
        code = row["発電所コード"]
        uname = norm(row["ユニット名"]) or "単独"
        key_u = (code, uname)
        if key_u in uid_index:
            return
        area = AREA_IDS.get(row["エリア"], "TOKYO")
        op = norm(row["発電事業者"])
        bname = basename(row["発電所名"])
        key_p = (op, bname, area)
        if key_p not in plants:
            ll = find_coords(row["発電所名"]) or find_coords(bname)
            approx = ll is None
            if approx:
                cx, cy = AREA_CENTER[area]
                dx, dy = jitter(op + bname)
                ll = (round(cx + dx, 3), round(cy + dy, 3))
            plants[key_p] = {
                "name": bname, "op": op, "area": area,
                "fuel": FUEL_MAP.get(row["発電形式"], "その他"),
                "lat": ll[0], "lon": ll[1], "approx": approx,
                "units": [],
            }
        cap_kw = norm(row["認可出力"]).replace(",", "")
        cap_mw = round(int(cap_kw) / 1000, 1) if cap_kw.isdigit() else 0
        # ユニット表示名: 発電所名がユニット個別名ならそちらを優先
        disp = uname
        full = norm(row["発電所名"])
        if disp in ("単独", "") and full != plants[key_p]["name"]:
            disp = full.removeprefix(plants[key_p]["name"]).strip() or "単独"
        uid_index[key_u] = len(all_units)
        rec = {"plant_key": key_p, "name": disp, "capMW": cap_mw,
               "master": from_master, "code": code, "rawName": uname}
        all_units.append(rec)
        plants[key_p]["units"].append(rec)

    for row in units_raw:
        add_unit(row, True)
    for row in outs_raw:                 # マスタにないユニットを補完
        add_unit(row, False)

    # ---- 停止イベント: 重複排除（同一キーは最終更新が新しいものを採用）----
    dedup: dict[tuple, dict] = {}
    for o in outs_raw:
        k = (o["発電所コード"], norm(o["ユニット名"]) or "単独", o["停止日時"])
        prev = dedup.get(k)
        if prev is None or o["最終更新日時"] > prev["最終更新日時"]:
            dedup[k] = o

    # 種別はコード化（テキスト重複を排除してサイズ削減）
    assortments: list[str] = []
    assort_no: dict[str, int] = {}

    def assort_idx(s: str) -> int:
        if s not in assort_no:
            assort_no[s] = len(assortments)
            assortments.append(s)
        return assort_no[s]

    now_min = int((datetime.now() - EPOCH).total_seconds() // 60) \
        - JST_OFFSET_MIN

    events = []
    notes = {}  # イベント番号 -> [種別idx, 停止原因] ※現在進行中のみ保持
    skipped = 0
    for (code, uname, _), o in dedup.items():
        ui = uid_index.get((code, uname))
        f = to_min(o["停止日時"])
        if ui is None or f is None:
            skipped += 1
            continue
        t = to_min(o["復旧予定日"])
        if t is None:
            t = FAR_FUTURE_MIN          # 復旧未定
        else:
            t += 24 * 60 - 1            # 復旧予定日の終日まで
        kind = 0 if "停止" in o["停止区分"] else 1
        cap = 0.0
        if kind == 1:
            down_kw = norm(o["低下量"]).replace(",", "")
            rated = all_units[ui]["capMW"]
            down = int(down_kw) / 1000 if down_kw.isdigit() else 0
            cap = max(round(rated - down, 1), 0)
        events.append([ui, kind, cap, f, t,
                       assort_idx(norm(o["種別"])),
                       norm(o["停止原因"])[:80]])
    events.sort(key=lambda e: (e[0], e[3]))
    # 過去イベントの停止原因テキストは落とす（現在進行中・将来のみ保持）
    for i, e in enumerate(events):
        if e[4] >= now_min:
            notes[str(i)] = e[6]
        del e[6]

    # ---- 出力（インデックス参照のコンパクト形式）----
    plant_list = list(plants.values())
    plant_no = {k: i for i, k in enumerate(plants.keys())}
    p_out = [
        [p["name"], p["op"], p["fuel"], p["area"], p["lat"], p["lon"],
         1 if p["approx"] else 0,
         [[u["name"], u["capMW"]] for u in p["units"]]]
        for p in plant_list
    ]
    # ユニット番号 → [発電所番号, 発電所内番号, コード, ユニット名, master, flags]
    #   master: 1=現行マスタ在籍 / 0=停止情報のみ由来
    #   flags : ビット 1=廃止 / 2=多軸の軸別(隠す) / 4=要確認(廃止候補・未確定)
    u_out = []
    counters: dict[int, int] = {}
    for u in all_units:
        pi = plant_no[u["plant_key"]]
        counters[pi] = counters.get(pi, -1) + 1
        master = 1 if u["master"] else 0
        key = (u["code"], u["rawName"])
        flags = 0
        if key in haishi:
            flags |= 1
        if not u["master"] and is_shaft(u["rawName"]):
            flags |= 2
        if key in review:
            flags |= 4
        u_out.append(
            [pi, counters[pi], u["code"], u["rawName"], master, flags])

    payload = {
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "plants": p_out,
        "units": u_out,
        "events": events,
        "assortments": assortments,
        "notes": notes,
    }
    js = ("// fetch_hjks.py で取得した HJKS データを build_data.py で変換"
          "したもの（自動生成）\n"
          "// 出典: JEPX 発電情報公開システム (HJKS)\n"
          "const HJKS = "
          + json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
          + ";\n")
    out_js = HERE / "hjks_data.js"
    out_js.write_text(js, encoding="utf-8")

    # ---- レポート ----
    matched = sum(1 for p in plant_list if not p["approx"])
    big_unmatched = sorted(
        (p for p in plant_list if p["approx"]),
        key=lambda p: -sum(u["capMW"] for u in p["units"]),
    )[:40]
    lines = [
        f"発電所: {len(plant_list)} / ユニット: {len(all_units)}",
        f"座標登録済み: {matched} / 概算配置: {len(plant_list) - matched}",
        f"イベント: {len(events)} (重複排除前 {len(outs_raw)}, "
        f"スキップ {skipped})",
        f"hjks_data.js: {out_js.stat().st_size / 1e6:.2f} MB",
        "",
        "--- 座標未登録の大規模発電所（容量順上位40）---",
    ]
    for p in big_unmatched:
        cap = sum(u["capMW"] for u in p["units"])
        lines.append(
            f"{cap:8.0f} MW  {p['area']:9s} {p['op'][:20]:20s} {p['name']}"
        )
    (DATA / "build_report.txt").write_text(
        "\n".join(lines), encoding="utf-8"
    )
    print("\n".join(lines[:5]))
    print("詳細: data/build_report.txt")


if __name__ == "__main__":
    main()
