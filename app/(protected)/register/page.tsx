import Link from "next/link";
import { Boxes, PackagePlus, ArrowRightLeft } from "lucide-react";

const cards = [
  {
    href: "/purchases/new",
    title: "仕入れ登録",
    text: "新品の数量商品と中古の一点物を同じ画面から登録",
    icon: PackagePlus,
  },
  {
    href: "/inventory/operations/new",
    title: "在庫移動・調整",
    text: "場所移動、廃棄、紛失、私用、在庫増減",
    icon: ArrowRightLeft,
  },
  { href: "/inventory/new", title: "商品登録", text: "独立した商品マスターを作成", icon: Boxes },
];

export default function RegisterPage() {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Phase 1 / Entry</p>
          <h1>登録</h1>
          <p className="muted">現在選択中の販売部門へ記録します。</p>
        </div>
      </header>
      <div className="card-grid">
        {cards.map(({ href, title, text, icon: Icon }) => (
          <Link className="card card-link" href={href} key={href}>
            <div className="card-icon">
              <Icon size={21} />
            </div>
            <h2>{title}</h2>
            <p className="muted">{text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
