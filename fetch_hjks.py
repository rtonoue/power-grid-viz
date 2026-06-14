# /// script
# requires-python = ">=3.11"
# dependencies = ["requests"]
# ///
"""HJKS（発電情報公開システム）自動取得スクリプト

HJKS の画面に公式に用意されている「CSVダウンロード」機能を、
ブラウザ操作の代わりに HTTP で実行するもの（HTMLのスクレイピングはしない）。

  仕組み: GET でセッション(JSESSIONID)と CSRF トークンを取得
          → 検索フォームに csv=csv を付けて POST → CSV が返る

使い方（uv が依存を隔離環境に自動準備する）:
  uv run fetch_hjks.py outages                  # 停止情報 全件
  uv run fetch_hjks.py outages --from 2026/06/01 --to 2026/06/13
  uv run fetch_hjks.py outages --area 東京 --json
  uv run fetch_hjks.py unit                     # 発電所・ユニットマスタ
  uv run fetch_hjks.py all                      # 2種まとめて取得

※ unit_status（ユニット状態一覧）画面には公式CSV機能が無いため対象外。
  同等の情報は outages（停止情報）から導出できる。

出力: data/ 配下に UTF-8(BOM) の CSV（タイムスタンプ付き + latest 上書き）

注意:
  - HJKS データの利用時は出典（JEPX 発電情報公開システム）を明記すること
  - 取得は控えめな頻度で（推奨: 10分以上の間隔）
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import ssl
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter

BASE = "https://hjks.jepx.or.jp/hjks"
USER_AGENT = (
    "power-grid-viz/0.1 "
    "(data collection for internal visualization; "
    "contact: rtonoue625@gmail.com)"
)
OUT_DIR = Path(__file__).parent / "data"
TIMEOUT = 60
RETRIES = 3

# エリアコード（HJKS の select 値。名称でも指定できるようにする）
AREA_CODES = {
    "北海道": "1", "東北": "2", "東京": "3", "中部": "4",
    "北陸": "5", "関西": "6", "中国": "7", "四国": "8",
    "九州": "9", "沖縄": "10",
}

# 発電形式コード（参考: --format相当の拡張をする場合に使用）
FORMAT_CODES = {
    "原子力": "1", "火力（石炭）": "2", "火力（ガス）": "3",
    "火力（石油）": "4", "水力": "5", "地熱": "6", "風力": "7",
    "太陽光・太陽熱": "8", "その他": "99",
}

# 取得対象ごとの POST フィールド定義（空文字 = フィルタなし）
TARGETS = {
    "outages": {
        "path": "/outages",
        "fields": [
            "area", "company", "plantcd", "name", "format",
            "unitname", "maintemode", "assortment",
            "startdtfrom", "startdtto",
        ],
        "date_keys": ("startdtfrom", "startdtto"),
    },
    "unit": {
        "path": "/unit",
        "fields": [
            "area", "company", "plantcd", "name", "format", "unitname",
        ],
        "date_keys": None,
    },
    # unit_status は画面に CSV ダウンロード機能が無い（検索のみ）ため非対応
}

CSRF_RE = re.compile(r'name="_csrf"\s+value="([^"]+)"')


class LegacyTLSAdapter(HTTPAdapter):
    """HJKS サーバは古い TLS 設定のため、レガシー暗号を許可する。

    Python 3.10+ の OpenSSL 既定（SECLEVEL=2）では handshake が
    拒否されるので、この接続に限り SECLEVEL=1 まで緩和する。
    証明書検証自体は通常どおり行う。
    """

    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.set_ciphers("DEFAULT:@SECLEVEL=1")
        ctx.options |= getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0x4)
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


def fetch_csv(
    session: requests.Session, target: str, filters: dict[str, str]
) -> str:
    """対象画面の CSV ダウンロードを実行し、デコード済みテキストを返す。"""
    spec = TARGETS[target]
    url = BASE + spec["path"]

    # 1) フォーム画面を GET して CSRF トークンを得る
    r = session.get(url, timeout=TIMEOUT)
    r.raise_for_status()
    m = CSRF_RE.search(r.text)
    if not m:
        raise RuntimeError(
            f"{target}: CSRF トークンが見つかりません"
            "（画面構成が変わった可能性）"
        )
    csrf = m.group(1)

    # 2) csv=csv を付けて POST（公式 CSV ダウンロードボタンと同じ動作）
    data = {k: filters.get(k, "") for k in spec["fields"]}
    data["csv"] = "csv"
    data["_csrf"] = csrf
    r = session.post(url, data=data, timeout=TIMEOUT)
    r.raise_for_status()

    ctype = r.headers.get("Content-Type", "")
    if "csv" not in ctype:
        raise RuntimeError(
            f"{target}: CSV ではなく {ctype!r} が返りました"
            "（パラメータ要確認）"
        )
    # HJKS は MS932(CP932) で返す
    return r.content.decode("cp932", errors="replace")


def save(target: str, text: str, also_json: bool) -> Path:
    OUT_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = OUT_DIR / f"hjks_{target}_{stamp}.csv"
    latest = OUT_DIR / f"hjks_{target}_latest.csv"
    # Excel でも文字化けしないよう UTF-8 BOM 付きで保存
    path.write_text(text, encoding="utf-8-sig", newline="")
    latest.write_text(text, encoding="utf-8-sig", newline="")

    if also_json:
        rows = list(csv.DictReader(io.StringIO(text)))
        jpath = OUT_DIR / f"hjks_{target}_latest.json"
        jpath.write_text(
            json.dumps(rows, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"  JSON: {jpath} ({len(rows)} 件)")
    return path


def run_target(
    session: requests.Session,
    target: str,
    filters: dict[str, str],
    also_json: bool,
) -> None:
    for attempt in range(1, RETRIES + 1):
        try:
            text = fetch_csv(session, target, filters)
            break
        except (requests.RequestException, RuntimeError) as e:
            if attempt == RETRIES:
                raise
            wait = 10 * attempt  # 控えめなバックオフ
            print(
                f"  リトライ {attempt}/{RETRIES - 1}: {e} → {wait}s 待機",
                file=sys.stderr,
            )
            time.sleep(wait)
    lines = text.count("\n")
    path = save(target, text, also_json)
    print(f"  保存: {path} ({len(text) / 1e6:.1f} MB, 約{lines:,}行)")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="HJKS 公式CSVダウンロードの自動実行"
    )
    ap.add_argument(
        "target", choices=[*TARGETS, "all"],
        help="取得対象（all で3種すべて）",
    )
    ap.add_argument(
        "--area", default="",
        help="エリア（名称または2桁コード。例: 東京 / 03）",
    )
    ap.add_argument(
        "--from", dest="dt_from", default="",
        help="期間開始（例: 2026/06/01）",
    )
    ap.add_argument(
        "--to", dest="dt_to", default="",
        help="期間終了（例: 2026/06/13）",
    )
    ap.add_argument(
        "--json", action="store_true",
        help="正規化した JSON も併せて出力",
    )
    args = ap.parse_args()

    area = AREA_CODES.get(args.area, args.area)
    targets = list(TARGETS) if args.target == "all" else [args.target]

    # HJKS の期間欄は「YYYY/MM/DD HH:MM」形式。日付のみなら時刻を補完
    dt_from, dt_to = args.dt_from.strip(), args.dt_to.strip()
    if re.fullmatch(r"\d{4}/\d{2}/\d{2}", dt_from):
        dt_from += " 00:00"
    if re.fullmatch(r"\d{4}/\d{2}/\d{2}", dt_to):
        dt_to += " 23:59"

    with requests.Session() as session:
        session.headers["User-Agent"] = USER_AGENT
        session.mount("https://", LegacyTLSAdapter())
        for i, t in enumerate(targets):
            if i > 0:
                time.sleep(5)  # 連続取得時はサーバ負荷に配慮
            filters = {"area": area}
            dk = TARGETS[t]["date_keys"]
            if dk:
                filters[dk[0]], filters[dk[1]] = dt_from, dt_to
            print(f"[{t}] 取得中 …")
            run_target(session, t, filters, args.json)

    print("完了。出典明記を忘れずに: JEPX 発電情報公開システム (HJKS)")


if __name__ == "__main__":
    main()
