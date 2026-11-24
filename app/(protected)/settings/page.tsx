import Link from "next/link";
import { ChevronRight } from "lucide-react";
const groups = [
  {
    name: "日常の入力",
    description: "入力時に選ぶ項目や、よく使う設定です。",
    items: [
      ["sales-channels", "販路・配送方法", "販売先、手数料、配送の既定値"],
      ["suppliers", "取引先", "仕入先と購入時の既定値"],
      ["accounts", "口座", "現金・預金・カードなどの入出金先"],
      ["income-expenses", "収支の項目", "その他の経費・収入の分類"],
      ["storage-locations", "保管場所", "商品の受取・移動・棚卸の場所"],
    ],
  },
  {
    name: "事業・年度",
    description: "誰が、どの事業・年度へ記録するかを管理します。",
    items: [
      ["operators", "入力者", "記録する担当者"],
      ["business-units", "部門", "商品や取引を管理する事業の区分"],
      ["reporting-entities", "申告主体", "取引の帰属先となる事業主・法人"],
      ["fiscal-years", "会計年度", "入力対象の期間と年度ロック"],
    ],
  },
  {
    name: "運用",
    description: "アプリ全体の設定と、データを守るための操作です。",
    items: [
      ["workspace", "ワークスペース", "共有する物販帳の名前・基本設定"],
      ["security", "セキュリティ", "ログインと認証の設定"],
      ["backup", "バックアップ", "保存状況と復元の手順"],
    ],
  },
];
export default function SettingsPage() {
  return (
    <div className="commerce">
      <header className="commerce-heading">
        <h1>設定</h1>
      </header>
      <div className="settings-groups">
        {groups.map((group) => (
          <section key={group.name}>
            <h2>{group.name}</h2>
            <p className="commerce-caption">{group.description}</p>
            {group.items.map(([path, name, description]) => (
              <Link key={path} className="commerce-row" href={`/settings/${path}`}>
                <div>
                  <strong>{name}</strong>
                  <span className="commerce-secondary">{description}</span>
                </div>
                <ChevronRight size={16} />
              </Link>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
