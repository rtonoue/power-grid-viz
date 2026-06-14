# 発電実績 × HJKS 可視化アプリ（プロトタイプ）

発電機の**発電実績**と、HJKS（発電情報公開システム）の**停止・出力低下情報**を、
地図上で高速かつ分かりやすく可視化するための試作アプリです。

> **データソースの内訳**
> - 発電所・ユニット・停止/出力低下・供給可能量: **HJKS 実データ**
>   （出典: JEPX 発電情報公開システム。242発電所 / 659ユニット / 約55,800イベント）
> - 発電実績: **OCCTO ユニット別発電実績の実データ**
>   （出典: 電力広域的運営推進機関（OCCTO）ユニット別発電実績公開システム。30分粒度）
>   - OCCTO 非公開のユニット（製鉄系共同火力など）は「非公開」と表示し合成値を出しません
>   - 多軸機（GTCC）は実績粒度に合わせ系列ユニットに集約（軸別サブユニットは非表示）
>   - 廃止ユニットは「廃止」と表示。2024/04 より前に廃止（OCCTO実績なし）のものは非表示
> - 連系線の潮流・座標の一部: サンプル値/概算（概算位置はツールチップに明記）

## データパイプライン

```
HJKS  ──(fetch_hjks.py)──► data/hjks_*_latest.csv
        ──(build_data.py)──► hjks_data.js  （2MB・重複排除・数値タイムスタンプ・廃止/軸別フラグ）
OCCTO ──(fetch_occto.py)─► data/occto_*.csv ──► data/occto_all.parquet（中間）
        ──(build_occto.py)─► occto_data.js （Uint16 base64・HJKSキーへ段階照合）
                                  ▲
        master/haishi_*.csv（手動管理の廃止リスト）── build_data.py が参照
        ──► ブラウザ（index.html）
```

データ更新手順:
```powershell
uv run fetch_hjks.py all      # HJKS から最新を取得（data/）
uv run fetch_occto.py --history  # OCCTO を公開開始(2024/03)から取得（data/）
uv run build_data.py          # HJKS + 廃止リスト → hjks_data.js
uv run build_occto.py         # OCCTO → occto_data.js（hjks_data.js を先に生成）
# → ブラウザをリロード
```
※ `build_occto.py` は照合に `hjks_data.js` を読むため、`build_data.py` を先に実行すること。

### レスポンス最適化（実測値）
- 生データ8.8MBを前処理で**2MBに圧縮**（重複排除・過去イベントの原因テキスト除去・インデックス参照化）
- 日時は build 時に数値化 → ブラウザでの Date パースなし。**ロード+デコード 70ms**
- 停止イベントは「長期(>90日)/短期」に分離し短期は**二分探索** →
  全発電所ステータス計算 1ms、最重ケース（水力120ユニット×7日×時粒度）58ms
- 地図マーカーは Canvas 描画（preferCanvas）、ツールチップは初ホバー時に遅延生成

---

## 実装した機能

| 要望 | 実装 |
|---|---|
| 地図上に全発電所をマーク、ホバーでスペック表示 | ✅ 燃料色のマーカー＋ホバーで号機別スペック・現在の供給可能量/実績 |
| ズームアウトでエリア単位の発電量と連系線を可視化 | ✅ zoom 7 未満でエリア集約マーカー＋連系線（運用容量・潮流・利用率） |
| 発電所/号機を選択→供給可能量と発電実績（期間・粒度を選択） | ✅ クリックで選択、号機ドロップダウン、期間（カレンダー）＋粒度（時/日/月）、プリセット |
| マスタ登録グループごとの集約発電量 | ✅ 事業者／燃料種別／カスタムグループで合算グラフ＋地図ハイライト |
| HJKS の停止・低下情報 | ✅ マーカーのリング色（停止=赤／出力低下=黄）＋現在のイベント一覧、供給可能量へ反映 |
| 発電実績を OCCTO 実データへ接続 | ✅ ユニット別30分実績を段階照合で接続（非公開/廃止/多軸を判別） |

---

## 起動方法

ビルド不要です。地図タイルとライブラリ（Leaflet / Chart.js）は CDN から読み込みます
（＝ブラウザがインターネットに接続できれば動きます）。

**A. 一番簡単：ダブルクリック**
`index.html` をブラウザで開くだけ。

**B. ローカルサーバ経由（推奨・将来の拡張に安全）— uv 管理の Python を使用**
```powershell
cd C:\Users\rtono\Projects\power-grid-viz
uv run --python 3.13 -- python -m http.server 5500
# → ブラウザで http://localhost:5500 を開く
```
※ `http.server` は標準ライブラリのため追加インストールは発生しません。
Python 本体は uv が管理するものを使います（pip / システム Python を汚しません）。

---

## ファイル構成

```
power-grid-viz/
├─ index.html        画面レイアウト
├─ styles.css        スタイル
├─ data.js           静的マスタ（燃料色・エリア・連系線・カスタムグループ）
├─ sim.js            デコード＋供給可能量／発電実績ロジック（OCCTO実データ優先）
├─ app.js            地図・グラフ・パネルのUIロジック
├─ fetch_hjks.py     HJKS 取得スクリプト
├─ fetch_occto.py    OCCTO 取得スクリプト
├─ build_data.py     HJKS + 廃止リスト → hjks_data.js
├─ build_occto.py    OCCTO → occto_data.js
├─ master/           手動管理メタデータ（公開可）
│  ├─ haishi_units.csv    廃止確定リスト（発電所コード, ユニット名）
│  └─ haishi_review.csv   廃止候補レビュー（判定: 廃止/要確認）
├─ data/             OCCTO/HJKS 生データ・中間（gitignore＝公開不可）
├─ hjks_data.js      生成物（gitignore）
└─ occto_data.js     生成物（gitignore）
```

## 公開リポジトリとデータの扱い

OCCTO / HJKS の**実データは現状公開できない**ため `.gitignore` で除外しています。
公開（追跡）するのは **ソースコード一式** と **`master/`（廃止リスト等の手動管理メタデータ）**
です。廃止ユニット情報は公的に公表される内容のため公開対象としています。

| 区分 | 対象 |
|---|---|
| 公開（git管理） | `*.py` / `*.js`（コード）/ `index.html` / `styles.css` / `data.js` / `master/` / `README.md` |
| 非公開（gitignore） | `data/`（生CSV・parquet・レポート）/ `hjks_data.js` / `occto_data.js` |

そのため**クローン直後はアプリ用データ（`hjks_data.js` / `occto_data.js`）が存在しません**。
動かすには上記「データ更新手順」で `data/` を用意し、`build_data.py` → `build_occto.py`
を実行して生成してください。

---

## HJKS 自動取得スクリプト（fetch_hjks.py）

HJKS の画面に公式に用意されている「CSVダウンロード」機能を HTTP で実行します
（HTML スクレイピングではありません）。

```powershell
uv run fetch_hjks.py outages                              # 停止情報 全件
uv run fetch_hjks.py outages --from 2026/06/01 --to 2026/06/13 --json
uv run fetch_hjks.py outages --area 東京                  # エリア絞り込み
uv run fetch_hjks.py unit                                 # 発電所・ユニットマスタ
uv run fetch_hjks.py all                                  # 2種まとめて
# ※ unit_status 画面は公式CSV機能が無いため対象外（outagesから導出可能）
```

出力は `data/` 配下（UTF-8 BOM 付き CSV + `--json` で JSON も）。

**仕様メモ**
- 期間指定（停止期間）は「指定範囲と停止期間が重なる案件」を返すサーバ仕様。
  厳密な絞り込みは取得後にローカルで行うのが確実
- 復旧予定日 `9999/12/31` は「復旧未定」の意味
- HJKS サーバは古い TLS 設定のため、このスクリプトは HJKS への接続に限り
  レガシー暗号を許可している（証明書検証は維持）

**利用上の注意（重要）**
- データの著作権は JEPX に帰属。利用時は出典
  「JEPX 発電情報公開システム (HJKS)」を明記すること
- 社内利用・控えめな取得頻度（10分以上の間隔推奨）で運用すること
- 生データの外部公開・再配布・商用サービスへの組込は JEPX への
  事前確認が必要（hjks@jepx.org / 03-5765-5477）

## 実データ接続に向けて（次ステップ）

このプロトタイプは「見た目と操作感」を確認するためのものです。実運用化するなら：

1. **データ層の分離**：発電実績は OCCTO 実データへ接続済み（非公開ユニットのみ合成値）。
   実運用ではブラウザ同梱の `*_data.js` を API/DB 配信へ置換し、`buildSeries()` の
   入出力（`{labels, actual, available}`）を保てば `app.js` は無改修。
2. **HJKS取込**：公開情報を定期取得→正規化し、`OUTAGES` 相当へマッピング。
   号機マスタ（資源コード等）との突合キー設計が要。
3. **性能**：号機数・期間が増えると時系列集計が重くなるため、サーバ側で事前集計
   （日次/月次のマテビュー）し、フロントは取得のみにする。
4. **地図**：発電所が多い場合はマーカークラスタリング、エリア境界ポリゴン表示、
   ベクタタイル化（MapLibre）を検討。

---

## 既知の簡略化

- 揚水のポンプ運転（負の出力）は簡略表示。
- 連系線の潮流・利用率は固定のサンプル値（時系列ではない）。
- エリア集約は「現在時刻（2026-06-13 12:00）」断面の値。
