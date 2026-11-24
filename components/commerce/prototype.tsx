"use client";

import { useState } from "react";
import { ArrowDownLeft, ArrowUpRight, Check, ChevronRight, Plus } from "lucide-react";

const screens = ["購入", "購入詳細", "商品・SKU", "販売", "お金"] as const;
type Screen = (typeof screens)[number];
const lines = [
  { name: "ガラスボトル 250ml", detail: "数量で管理", qty: "24", amount: "12,000" },
  { name: "ギフトボックス", detail: "資材・残数の管理なし", qty: "30", amount: "3,000" },
];

export function CommercePrototype() {
  const [screen, setScreen] = useState<Screen>("購入");
  const [saved, setSaved] = useState(false);
  const [received, setReceived] = useState(true);
  return (
    <div className="commerce prototype">
      <div className="prototype-bar">
        <span>画面プレビュー · サンプルデータ</span>
        <span>入力は保存されません</span>
      </div>
      <nav className="commerce-tabs" aria-label="プレビュー画面">
        {screens.map((s) => (
          <button
            type="button"
            key={s}
            aria-current={s === screen ? "page" : undefined}
            onClick={() => {
              setScreen(s);
              setSaved(false);
            }}
          >
            {s}
          </button>
        ))}
      </nav>
      <header className="commerce-heading">
        <div>
          <p className="commerce-overline">2026年11月</p>
          <h1>{screen === "購入" ? "購入を記録" : screen === "販売" ? "販売を記録" : screen}</h1>
        </div>
        {screen === "商品・SKU" && (
          <button className="button" onClick={() => setSaved(true)}>
            <Plus size={16} />
            SKUを一括登録
          </button>
        )}
      </header>
      {screen === "購入" && (
        <div className="commerce-editor">
          <div className="commerce-fields">
            <label className="field">
              購入日
              <input type="date" defaultValue="2026-11-10" />
            </label>
            <label className="field">
              取引先
              <input defaultValue="みなと商店" />
            </label>
          </div>
          <section className="commerce-section">
            <div className="commerce-section-heading">
              <h2>購入したもの</h2>
              <button className="commerce-text-button" onClick={() => setSaved(true)}>
                <Plus size={16} />
                明細を追加
              </button>
            </div>
            <div className="commerce-list">
              {lines.map((l) => (
                <div className="commerce-row" key={l.name}>
                  <div>
                    <strong>{l.name}</strong>
                    <span className="commerce-secondary">{l.detail}</span>
                  </div>
                  <span>{l.qty} 個</span>
                  <span className="commerce-number">¥{l.amount}</span>
                </div>
              ))}
            </div>
          </section>
          <details className="commerce-disclosure">
            <summary>
              送料・手数料・税額<span>¥800</span>
            </summary>
            <div className="commerce-fields">
              <label className="field">
                送料
                <input defaultValue="800" inputMode="numeric" />
              </label>
              <label className="field">
                配分方法
                <select defaultValue="value">
                  <option value="value">商品金額比</option>
                  <option>数量比</option>
                  <option>重量比</option>
                  <option>容積比</option>
                  <option>明細均等</option>
                  <option>手動</option>
                </select>
              </label>
            </div>
          </details>
          <details className="commerce-disclosure">
            <summary>
              支払い・メモ<span>未入力</span>
            </summary>
            <label className="field">
              支払口座
              <select>
                <option>後から記録</option>
                <option>事業用口座</option>
              </select>
            </label>
          </details>
          <label className="commerce-checkbox">
            <input
              type="checkbox"
              checked={received}
              onChange={(e) => setReceived(e.target.checked)}
            />
            受取済み
          </label>
          <footer className="commerce-save">
            <div>
              <span className="commerce-secondary">購入合計</span>
              <strong className="commerce-total">¥15,800</strong>
            </div>
            <button className="button" onClick={() => setSaved(true)}>
              {received ? "保存して入庫" : "購入を保存"}
            </button>
          </footer>
        </div>
      )}
      {screen === "購入詳細" && (
        <div className="commerce-editor">
          <div className="commerce-record-title">
            <div>
              <h2>みなと商店</h2>
              <span className="commerce-secondary">2026年11月10日 · P-000128</span>
            </div>
            <span className="commerce-badge">受取済み</span>
          </div>
          <div className="commerce-list">
            {lines.map((l) => (
              <div className="commerce-row" key={l.name}>
                <div>
                  <strong>{l.name}</strong>
                  <span className="commerce-secondary">{l.qty} 個</span>
                </div>
                <span className="commerce-number">¥{l.amount}</span>
              </div>
            ))}
          </div>
          <div className="commerce-summary-line">
            <span>送料</span>
            <span>¥800</span>
          </div>
          <div className="commerce-summary-line">
            <strong>購入合計</strong>
            <strong>¥15,800</strong>
          </div>
          <div className="commerce-action-row">
            {["配送・受取", "費用を追加", "支払いを記録"].map((label) => (
              <button key={label} className="button secondary" onClick={() => setSaved(true)}>
                {label}
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
          <details className="commerce-disclosure">
            <summary>原価の内訳</summary>
            <p>ガラスボトル ¥12,640 · ギフトボックス ¥3,160</p>
          </details>
          <details className="commerce-disclosure">
            <summary>記録の履歴</summary>
            <p>11月10日 購入・受取を記録</p>
          </details>
        </div>
      )}
      {screen === "商品・SKU" && (
        <div>
          <div className="commerce-toolbar">
            <input aria-label="商品を検索" placeholder="商品名・SKUで検索" />
            <span className="commerce-secondary">2件</span>
          </div>
          <div className="commerce-list">
            {[
              { name: "ガラスボトル 250ml", detail: "BOTTLE-250", count: "24 個", cost: "¥527" },
              {
                name: "リネンジャケット",
                detail: "LINEN-001 · 1点もの",
                count: "1 点",
                cost: "¥2,400",
              },
            ].map((p) => (
              <label className="commerce-row commerce-select-row" key={p.name}>
                <input type="checkbox" aria-label={`${p.name}を選択`} />
                <div>
                  <strong>{p.name}</strong>
                  <span className="commerce-secondary">{p.detail}</span>
                </div>
                <span>{p.count}</span>
                <span className="commerce-number">
                  {p.cost}
                  <small>単位原価</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
      {screen === "販売" && (
        <div className="commerce-editor">
          <label className="field">
            SKU
            <select>
              <option>ガラスボトル 250ml · 2本セット</option>
              <option>リネンジャケット</option>
            </select>
          </label>
          <div className="commerce-fields">
            <label className="field">
              完了日
              <input type="date" defaultValue="2026-11-10" />
            </label>
            <label className="field">
              数量
              <input type="number" defaultValue="1" min="1" />
            </label>
            <label className="field">
              販路
              <select>
                <option>オンラインストア</option>
                <option>フリーマーケット</option>
              </select>
            </label>
            <label className="field">
              商品代金
              <input defaultValue="2400" inputMode="numeric" />
            </label>
          </div>
          <div className="commerce-section">
            <div className="commerce-fields">
              <label className="field">
                販売手数料
                <input defaultValue="120" inputMode="numeric" />
              </label>
              <label className="field">
                送料
                <input defaultValue="450" inputMode="numeric" />
              </label>
            </div>
          </div>
          <details className="commerce-disclosure">
            <summary>商品ID・購入者・メモ</summary>
            <div className="commerce-fields">
              <label className="field">
                商品ID
                <input />
              </label>
              <label className="field">
                購入者
                <input />
              </label>
            </div>
          </details>
          <footer className="commerce-save">
            <div>
              <span className="commerce-secondary">見込み利益</span>
              <strong className="commerce-total">¥726</strong>
            </div>
            <button className="button" onClick={() => setSaved(true)}>
              販売を記録
            </button>
          </footer>
        </div>
      )}
      {screen === "お金" && (
        <div>
          <div className="commerce-account-grid">
            {[
              { name: "事業用口座", value: "¥184,200" },
              { name: "販売サービス残高", value: "¥32,840" },
            ].map((a) => (
              <div className="commerce-account" key={a.name}>
                <span className="commerce-secondary">{a.name}</span>
                <strong>{a.value}</strong>
              </div>
            ))}
          </div>
          <div className="commerce-section-heading">
            <h2>最近の入出金</h2>
            <button className="button secondary" onClick={() => setSaved(true)}>
              <Plus size={16} />
              記録
            </button>
          </div>
          <div className="commerce-list">
            {[
              {
                name: "商品販売",
                detail: "11月10日 · オンラインストア",
                value: "+ ¥1,830",
                incoming: true,
              },
              {
                name: "購入代金",
                detail: "11月10日 · みなと商店",
                value: "− ¥15,800",
                incoming: false,
              },
            ].map((r) => (
              <div className="commerce-row" key={r.name}>
                <span className="commerce-flow-icon">
                  {r.incoming ? <ArrowDownLeft size={19} /> : <ArrowUpRight size={19} />}
                </span>
                <div>
                  <strong>{r.name}</strong>
                  <span className="commerce-secondary">{r.detail}</span>
                </div>
                <span className="commerce-number">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {saved && (
        <div className="commerce-toast" role="status">
          <Check size={16} />
          プレビューの操作を確認しました。データは保存していません。
        </div>
      )}
    </div>
  );
}
