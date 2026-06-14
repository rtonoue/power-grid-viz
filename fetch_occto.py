# /// script
# requires-python = ">=3.11"
# dependencies = ["requests", "beautifulsoup4"]
# ///
"""OCCTO ユニット別発電実績公開システム 自動取得スクリプト

OCCTO の「ユニット別発電実績公開システム」から 30 分刻みの発電実績 CSV を
取得します。

  仕組み: GET で免責事項ページ → 同意 POST でセッション確立
          → 検索フォーム POST で CSV を取得

使い方（uv が依存を隔離環境に自動準備する）:
  uv run fetch_occto.py --area 東京 --from 2026/03/01 --to 2026/03/31
  uv run fetch_occto.py --area all --from 2026/03/01 --to 2026/03/31
  uv run fetch_occto.py --diag          # フォーム構造を診断して終了

出力: data/occto_{area}_{from}_{to}.csv および data/occto_latest.csv

注意:
  - OCCTO データの利用時は出典（電力広域的運営推進機関）を明記すること
  - 取得は控えめな頻度で（推奨: 10 分以上の間隔）
  - 速報値であり欠落がある場合があります
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ORIGIN = "https://hatsuden-kokai.occto.or.jp"
BASE = ORIGIN + "/hks-web-public"
USER_AGENT = (
    "power-grid-viz/0.1 "
    "(data collection for internal visualization; "
    "contact: rtonoue625@gmail.com)"
)
OUT_DIR = Path(__file__).parent / "data"
TIMEOUT = 60
RETRIES = 3

# OCCTO のエリアコードはゼロ埋め2桁（HJKS とは異なる）
AREA_CODES = {
    "北海道": "01", "東北": "02", "東京": "03", "中部": "04",
    "北陸": "05",   "関西": "06", "中国": "07", "四国": "08",
    "九州": "09",   "沖縄": "10",
}

# 発電方式コード（CSV ダウンロードで「すべて」= 99 + 個別コード を送信）
FUEL_CODES = ["99", "01", "02", "03", "04", "05", "06", "07", "08", "09"]

# 判明した API エンドポイント（HKSAS002.js より）
# 1) AJAX 検索 (POST) でサーバ側セッションに結果を蓄積
# 2) CSV ダウンロード (GET) でセッションの結果を CSV として取得
SEARCH_URL = BASE + "/info/hks/search"
CSV_URL = BASE + "/info/hks/downloadCsv"


def make_session() -> requests.Session:
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    return session


def accept_disclaimer(session: requests.Session, diag: bool = False) -> str:
    """免責事項画面を GET → POST して同意。セッションクッキーが設定される。
    同意後のリダイレクト先 URL を返す。
    """
    url = f"{BASE}/disclaimer-agree"
    r = session.get(url, timeout=TIMEOUT, allow_redirects=True)
    r.raise_for_status()

    # すでに別ページにいる場合は同意済み扱い
    if "disclaimer" not in r.url:
        print(f"  免責事項: 既に同意済み (→ {r.url})")
        return r.url

    if diag:
        dump = Path(__file__).parent / "data" / "_diag_disclaimer.html"
        dump.parent.mkdir(exist_ok=True)
        dump.write_text(r.text, encoding="utf-8")
        print(f"\n  [診断] 免責事項 HTML → {dump}\n")

    soup = BeautifulSoup(r.text, "html.parser")
    form = soup.find("form")
    if form is None:
        raise RuntimeError(
            "免責事項フォームが見つかりません（ページ構成が変わった可能性）\n"
            "--diag で HTML を確認してください"
        )

    action = form.get("action", url)
    if not action.startswith("http"):
        # action は "/hks-web-public/..." 形式（ルートパス）
        action = (
            ORIGIN + action if action.startswith("/") else BASE + "/" + action
        )

    # フォームフィールドを収集
    data: dict[str, str] = {}
    for inp in form.find_all("input"):
        name = inp.get("name", "")
        if not name:
            continue
        itype = (inp.get("type") or "text").lower()
        if itype == "checkbox":
            # checkbox は name なしで JS 制御されるためスキップ
            pass
        elif itype == "radio":
            if name not in data:
                data[name] = inp.get("value", "")
        else:
            data[name] = inp.get("value", "")

    # "agreed" hidden フィールドの値: JS の changeCheckbox() が
    # 初回クリック(チェック)で '' → '0' にトグルする。
    # よって同意した状態 = '0' をサーバへ送信する。
    if "agreed" in data:
        data["agreed"] = "0"
    else:
        for key in list(data):
            if "agree" in key.lower():
                data[key] = "0"

    if diag:
        print(f"  [診断] 免責事項 POST {action}")
        print(f"  data: {data}")

    r2 = session.post(action, data=data, timeout=TIMEOUT, allow_redirects=True)
    r2.raise_for_status()
    print(f"  免責事項同意: POST → {r2.url} ({r2.status_code})")
    return r2.url


def get_search_form(
    session: requests.Session, diag: bool = False
) -> tuple[str, dict[str, str], dict[str, list[str]]]:
    """検索フォームを取得し、(action, 初期フィールド値, select選択肢) を返す。"""
    if diag:
        print(f"  [診断] session cookies: {dict(session.cookies)}")

    found_r = None
    for path in ("/info/hks", "/info/home", "/"):
        url = BASE + path
        r = session.get(url, timeout=TIMEOUT, allow_redirects=True)
        if diag:
            print(f"  [診断] GET {url} → {r.status_code} final={r.url}")
        if r.status_code == 200 and "disclaimer" not in r.url:
            found_r = r
            break

    if found_r is None:
        # 全パスが disclaimer にリダイレクト → cookie 未設定の可能性
        # disclaimer/next の POST 結果を直接使う
        if diag:
            print("  [診断] 全パスで disclaimer リダイレクト検出、POST 結果を確認")
        raise RuntimeError(
            "検索フォームページが見つかりません。\n"
            "免責事項同意 POST が失敗した可能性があります。\n"
            "--diag で cookie/リダイレクトを確認してください"
        )

    soup = BeautifulSoup(found_r.text, "html.parser")

    if diag:
        # HTML をファイルに保存してコンソールのエンコーディング問題を回避
        dump_html = Path(__file__).parent / "data" / "_diag_search.html"
        dump_html.parent.mkdir(exist_ok=True)
        dump_html.write_text(found_r.text, encoding="utf-8")
        print(f"  [診断] 検索ページ HTML → {dump_html}")

        lines_out: list[str] = ["\n===== フォーム診断 ====="]
        for form in soup.find_all("form"):
            lines_out.append(
                f"\n[FORM] action={form.get('action')} "
                f"method={form.get('method')}"
            )
            for el in form.find_all(
                ["input", "select", "button", "textarea"]
            ):
                tag = el.name
                ename = el.get("name", "")
                etype = el.get("type", "")
                evalue = el.get("value", "")
                if tag == "select":
                    opts = [
                        (o.get("value", ""), o.get_text().strip())
                        for o in el.find_all("option")
                    ]
                    lines_out.append(f"  <select name={ename!r}> opts={opts}")
                else:
                    lines_out.append(
                        f"  <{tag} type={etype!r} "
                        f"name={ename!r} value={evalue!r}>"
                    )
        lines_out.append("=======================\n")
        dump_txt = Path(__file__).parent / "data" / "_diag_forms.txt"
        dump_txt.write_text("\n".join(lines_out), encoding="utf-8")
        print(f"  [診断] フォーム構造 → {dump_txt}")

    form = soup.find("form")
    if form is None:
        raise RuntimeError(
            "フォームが見つかりません。--diag で構造を確認してください"
        )

    action = form.get("action", "/hks-web-public/search")
    if not action.startswith("http"):
        action = (
            ORIGIN + action
            if action.startswith("/")
            else BASE + "/" + action
        )

    fields: dict[str, str] = {}
    selects: dict[str, list[str]] = {}

    for inp in form.find_all("input"):
        name = inp.get("name", "")
        value = inp.get("value", "")
        if name:
            fields[name] = value

    for sel in form.find_all("select"):
        name = sel.get("name", "")
        opts = [
            o.get("value", "")
            for o in sel.find_all("option")
            if o.get("value")
        ]
        if name:
            selects[name] = opts
            fields[name] = opts[0] if opts else ""

    return action, fields, selects


def _build_form_params(
    area_code: str, date_from: str, date_to: str
) -> list[tuple[str, str]]:
    """検索・CSV ダウンロード共通のフォームパラメータを構築する。"""
    params: list[tuple[str, str]] = []

    # エリアチェックボックス
    if area_code in ("99", ""):
        for code in ["99"] + [f"{i:02d}" for i in range(1, 11)]:
            params.append(("areaCheckbox", code))
    else:
        params.append(("areaCheckbox", area_code))

    # 発電方式: すべて
    for fc in FUEL_CODES:
        params.append(("hatudenHosikiCheckbox", fc))

    # 対象日
    params.extend([
        ("tgtDateDateFrom", date_from),
        ("tgtDateDateTo", date_to),
    ])

    # 発電所・ユニット絞り込み（空 = すべて）
    params.extend([("htdnsCd", ""), ("htdnsNm", ""), ("unitNm", "")])
    return params


def fetch_csv(
    session: requests.Session,
    area_code: str,
    date_from: str,
    date_to: str,
    diag: bool,
) -> str:
    """OCCTO ユニット別発電実績 CSV をダウンロードして返す。

    手順:
      1) POST /info/hks/search  … AJAX 検索でサーバ側セッションに結果を格納
      2) GET  /info/hks/downloadCsv … セッション結果を CSV として取得
    （フォームに method 属性なし → CSV 取得は GET、HKSAS002.js より確認）
    """
    params = _build_form_params(area_code, date_from, date_to)

    # Step 1: AJAX 検索
    if diag:
        print(f"  [診断] AJAX POST {SEARCH_URL}")
        print(f"  params: {params}")
    r1 = session.post(
        SEARCH_URL, data=params, timeout=TIMEOUT, allow_redirects=True
    )
    r1.raise_for_status()
    if diag:
        print(f"  [診断] search 応答 ({r1.status_code}) {r1.text[:500]}")

    # Step 2: CSV 取得（GET）
    if diag:
        print(f"  [診断] GET {CSV_URL} params={params}")
    r2 = session.get(
        CSV_URL, params=params, timeout=TIMEOUT, allow_redirects=True
    )
    r2.raise_for_status()

    ctype = r2.headers.get("Content-Type", "")
    if (
        "csv" not in ctype
        and "octet-stream" not in ctype
        and "ms-excel" not in ctype
        and "application/vnd" not in ctype
    ):
        if diag:
            dump = Path(__file__).parent / "data" / "_diag_csv_response.html"
            dump.write_text(r2.text, encoding="utf-8")
            print(f"  [診断] 非 CSV レスポンス ({ctype}) → {dump}")
        raise RuntimeError(
            f"CSV ではなく {ctype!r} が返りました（--diag で詳細確認）"
        )

    for enc in ("utf-8-sig", "utf-8", "cp932"):
        try:
            return r2.content.decode(enc, errors="strict")
        except UnicodeDecodeError:
            continue
    return r2.content.decode("cp932", errors="replace")


def save(
    area_label: str,
    date_from: str,
    date_to: str,
    text: str,
    also_json: bool,
) -> Path:
    OUT_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    slug = date_from.replace("/", "") + "_" + date_to.replace("/", "")
    path = OUT_DIR / f"occto_{area_label}_{slug}_{stamp}.csv"
    latest = OUT_DIR / "occto_latest.csv"

    path.write_text(text, encoding="utf-8-sig", newline="")
    latest.write_text(text, encoding="utf-8-sig", newline="")

    if also_json:
        rows = list(csv.DictReader(io.StringIO(text)))
        jpath = OUT_DIR / "occto_latest.json"
        jpath.write_text(
            json.dumps(rows, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        print(f"  JSON: {jpath} ({len(rows)} 件)")
    return path


def run_area(
    session: requests.Session,
    area_code: str,
    area_label: str,
    date_from: str,
    date_to: str,
    also_json: bool,
    diag: bool,
) -> None:
    for attempt in range(1, RETRIES + 1):
        try:
            text = fetch_csv(session, area_code, date_from, date_to, diag)
            break
        except (requests.RequestException, RuntimeError) as e:
            if attempt == RETRIES:
                raise
            wait = 10 * attempt
            print(
                f"  リトライ {attempt}/{RETRIES - 1}: {e} → {wait}s 待機",
                file=sys.stderr,
            )
            time.sleep(wait)

    lines = text.count("\n")
    path = save(area_label, date_from, date_to, text, also_json)
    print(f"  保存: {path} ({len(text) / 1e3:.0f} KB, 約{lines:,}行)")


def month_end(d: date) -> date:
    """月末日を返す。"""
    if d.month == 12:
        return date(d.year + 1, 1, 1) - timedelta(days=1)
    return date(d.year, d.month + 1, 1) - timedelta(days=1)


def iter_months(start: date, end: date):
    """start 月から end 月まで (from_str, to_str) を月単位で yield する。"""
    cur = date(start.year, start.month, 1)
    while cur <= end:
        last = min(month_end(cur), end)
        yield cur.strftime("%Y/%m/%d"), last.strftime("%Y/%m/%d")
        if cur.month == 12:
            cur = date(cur.year + 1, 1, 1)
        else:
            cur = date(cur.year, cur.month + 1, 1)


def already_fetched(area_label: str, date_from_str: str) -> bool:
    """date_from_str の年月ファイルが data/ に存在すれば True。
    ファイル名は occto_{area}_{YYYYMMDD}_{YYYYMMDD}_*.csv の形式。
    """
    prefix = date_from_str.replace("/", "")   # "2024/04/01" → "20240401"
    return any(OUT_DIR.glob(f"occto_{area_label}_{prefix}_*.csv"))


def main() -> None:
    ap = argparse.ArgumentParser(description="OCCTO ユニット別発電実績 自動取得")
    ap.add_argument(
        "--area", default="東京",
        help="エリア名（all で全エリア）。例: 東京 / all",
    )
    ap.add_argument(
        "--from", dest="dt_from", default="",
        help="期間開始 例: 2026/03/01",
    )
    ap.add_argument(
        "--to", dest="dt_to", default="",
        help="期間終了 例: 2026/03/31",
    )
    ap.add_argument(
        "--history", action="store_true",
        help="--since から昨日まで月単位で全エリア一括取得（既存ファイルはスキップ）",
    )
    ap.add_argument(
        "--since", default="2024/03/01",
        help="--history モードの開始日（デフォルト: 2024/03/01）",
    )
    ap.add_argument("--json", action="store_true", help="JSON も出力")
    ap.add_argument(
        "--diag", action="store_true",
        help="フォーム構造を診断表示して終了",
    )
    args = ap.parse_args()

    today = datetime.now()

    # ---- --history モード ------------------------------------------------
    if args.history:
        since = datetime.strptime(args.since.strip(), "%Y/%m/%d").date()
        yesterday = (today - timedelta(days=2)).date()   # 速報値は2日程度遅延
        targets = list(AREA_CODES.items())
        months = list(iter_months(since, yesterday))
        total = len(months) * len(targets)
        print(
            f"OCCTO 全履歴取得: {since} 〜 {yesterday}"
            f"  ({len(months)} ヶ月 × {len(targets)} エリア = {total} リクエスト)"
        )
        session = make_session()
        print("  免責事項への同意 …")
        accept_disclaimer(session)
        done = skipped = errors = 0
        for mi, (mfrom, mto) in enumerate(months, 1):
            for ai, (label, code) in enumerate(targets):
                if already_fetched(label, mfrom):
                    skipped += 1
                    continue
                if done + errors > 0 or ai > 0:
                    time.sleep(5)
                print(
                    f"  [{mi}/{len(months)}] {mfrom}〜{mto}  {label}"
                    f"  (済:{done} スキップ:{skipped} エラー:{errors})"
                )
                try:
                    run_area(
                        session, code, label, mfrom, mto,
                        args.json, diag=False
                    )
                    done += 1
                    # セッション切れ対策: 50リクエストごとに再ログイン
                    if done % 50 == 0:
                        print("  [セッション更新]")
                        session = make_session()
                        accept_disclaimer(session)
                except Exception as e:
                    errors += 1
                    print(f"  エラー: {e}", file=sys.stderr)
        print(
            f"\n完了: 取得={done} スキップ={skipped} エラー={errors}\n"
            "出典明記: 電力広域的運営推進機関（OCCTO）ユニット別発電実績公開システム"
        )
        return

    # ---- 通常モード -------------------------------------------------------
    dt_from = (
        args.dt_from.strip()
        if args.dt_from
        else (today - timedelta(days=90)).strftime("%Y/%m/%d")
    )
    dt_to = (
        args.dt_to.strip()
        if args.dt_to
        else (today - timedelta(days=60)).strftime("%Y/%m/%d")
    )

    if args.area.lower() == "all":
        targets = list(AREA_CODES.items())
    elif args.area in AREA_CODES:
        targets = [(args.area, AREA_CODES[args.area])]
    elif args.area in AREA_CODES.values():
        lbl = next(k for k, v in AREA_CODES.items() if v == args.area)
        targets = [(lbl, args.area)]
    else:
        print(
            f"不明なエリア: {args.area}. 指定可能: {', '.join(AREA_CODES)}",
            file=sys.stderr,
        )
        sys.exit(1)

    names = [name for name, _ in targets]
    print(f"OCCTO 取得: エリア={names} 期間={dt_from}〜{dt_to}")

    session = make_session()
    print("  免責事項への同意 …")
    accept_disclaimer(session, diag=args.diag)

    if args.diag:
        print("  フォーム構造診断 …")
        get_search_form(session, diag=True)
        print("  fetch_csv 診断 …")

    for i, (label, code) in enumerate(targets):
        if i > 0:
            time.sleep(5)
        print(f"\n[{label} ({code})] 取得中 …")
        try:
            run_area(
                session, code, label, dt_from, dt_to, args.json, diag=False
            )
        except Exception as e:
            print(f"  エラー: {e}", file=sys.stderr)
            print("  --diag で詳細を確認してください", file=sys.stderr)

    print(
        "\n完了。出典明記: "
        "電力広域的運営推進機関（OCCTO）ユニット別発電実績公開システム"
    )


if __name__ == "__main__":
    main()
