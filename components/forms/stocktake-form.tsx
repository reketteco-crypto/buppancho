"use client";
import { useRef, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { z } from "zod";
import type { stocktakeRecordSchema } from "@/lib/validation/workflow";
import { useSubmit, type InputContext } from "@/components/forms/workflow-forms";
import { useSharedValuation } from "@/components/forms/shared-valuation-preview";
import { HydratedForm } from "@/components/forms/hydrated-form";

export function StocktakeForm(props: {
  context: InputContext;
  blocked?: boolean;
  revision: string;
  today: string;
  variants: { id: string; label: string }[];
  locations: { id: string; name: string }[];
  initial?: z.input<typeof stocktakeRecordSchema>;
  initialVariant?: string;
}) {
  const action = useSubmit("STOCKTAKE", props.context, "inventory");
  const router = useRouter(),
    form = useRef<HTMLFormElement>(null);
  const [variantId, setVariantId] = useState(
    props.initial?.variantId ?? props.initialVariant ?? props.variants[0]?.id ?? "",
  );
  const [locationId, setLocationId] = useState(props.initial?.locationId ?? "");
  const [countedQuantity, setQuantity] = useState(props.initial?.countedQuantity.toString() ?? "");
  const [countedDate, setDate] = useState(props.initial?.countedDate ?? props.today);
  const [unitCostJpy, setCost] = useState(props.initial?.unitCostJpy ?? "");
  const [reason, setReason] = useState(props.initial?.reason ?? "");
  const [search, setSearch] = useState("");
  const payload = {
    variantId,
    locationId,
    countedQuantity: /^\d+$/.test(countedQuantity) ? Number(countedQuantity) : null,
    countedDate,
    unitCostJpy,
    reason,
    inventoryRevision: props.revision,
  };
  const preview = useSharedValuation(
    "STOCKTAKE",
    props.context,
    payload,
    !props.blocked &&
      !action.pending &&
      !!variantId &&
      !!locationId &&
      !!reason.trim() &&
      /^\d+$/.test(countedQuantity),
  );
  const fields = { ...preview.fields, ...action.result.fields };
  useEffect(() => {
    if (action.result.error)
      form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [action.result]);
  return (
    <HydratedForm
      ref={form}
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (preview.ready) void action.submit({ ...payload, ...preview.confirmation });
      }}
    >
      {action.feedback}
      {(preview.code === "CONFLICT" || action.result.code === "CONFLICT") && (
        <button type="button" className="button secondary" onClick={() => router.refresh()}>
          実測値を保持して最新の在庫を読み直す
        </button>
      )}
      <fieldset disabled={action.pending || props.blocked}>
        <label className="field">
          <span>商品を検索</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        <label className="field">
          <span>数えた商品（数量管理）</span>
          <select value={variantId} onChange={(e) => setVariantId(e.target.value)} required>
            <option value="">選択してください</option>
            {props.variants
              .filter((v) => v.id === variantId || v.label.includes(search))
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
          </select>
        </label>
        <label className="field">
          <span>数えた保管場所</span>
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} required>
            <option value="">選択してください</option>
            {props.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>数えた日（日本時間）</span>
          <input
            type="date"
            value={countedDate}
            onChange={(e) => setDate(e.target.value)}
            min={`${props.context.year}-01-01`}
            max={`${props.context.year}-12-31`}
            required
            aria-invalid={!!fields.countedDate}
          />
          {fields.countedDate && <span className="field-error">{fields.countedDate}</span>}
        </label>
        <label className="field">
          <span>確認した実測数量（個）</span>
          <input
            type="number"
            min={0}
            max={1000000}
            step={1}
            value={countedQuantity}
            onChange={(e) => setQuantity(e.target.value)}
            required
            aria-invalid={!!fields.countedQuantity}
          />
          {fields.countedQuantity && <span className="field-error">{fields.countedQuantity}</span>}
        </label>
        <label className="field">
          <span>増加する商品の1個原価（円・増加時のみ必須）</span>
          <input
            inputMode="numeric"
            pattern="[0-9]+"
            value={unitCostJpy}
            onChange={(e) => setCost(e.target.value)}
            aria-invalid={!!fields.unitCostJpy}
          />
          {fields.unitCostJpy && <span className="field-error">{fields.unitCostJpy}</span>}
        </label>
        <label className="field">
          <span>数量を確認した理由（必須）</span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            required
            aria-invalid={!!fields.reason}
          />
          {fields.reason && <span className="field-error">{fields.reason}</span>}
        </label>
        <p className="message">
          販売用の管理対象数の訂正です。発送済み・返送待ちを含む場合があるため、手元にない確保在庫を数え漏れとして減らさないでください。販売・返品・廃棄の代わりには使用しません。
        </p>
        {preview.panel}
        <button className="button" disabled={!preview.ready || action.pending}>
          実測数量と影響を確認して記録する
        </button>
        <p className="muted">
          差が0個でも確認履歴を残します。実測値と差分は後から自動変更しません。未送信の入力を画面を閉じた後まで復元できるとは限りません。
        </p>
      </fieldset>
    </HydratedForm>
  );
}
