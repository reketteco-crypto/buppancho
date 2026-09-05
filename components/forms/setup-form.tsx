"use client";

import { useActionState, useState } from "react";
import { initialSetupAction } from "@/app/actions";
import { createClientUuid } from "@/lib/client-uuid";

type OperatorRow = { key: string; displayName: string };
type EntityRow = { key: string; displayName: string };
type ProfileRow = {
  reportingEntityKey: string;
  filingMethod: "BLUE" | "WHITE";
  consumptionTaxStatus: "" | "EXEMPT" | "TAXABLE" | "INVOICE_REGISTERED";
  blueDeductionTarget: "" | "NONE" | "DEDUCTION_100K" | "DEDUCTION_550K" | "DEDUCTION_650K";
  inventoryValuationMethod: "" | "SPECIFIC" | "LAST_PURCHASE_COST" | "GROSS_AVERAGE" | "OTHER";
  inventoryValuationMethodNote: string;
};
type UnitRow = {
  key: string;
  code: string;
  name: string;
  color: string;
  defaultOperatorKey: string;
  reportingEntityKey: string;
};

const newKey = (prefix: string) => `${prefix}_${createClientUuid()}`;

export function SetupForm({ initialWorkspaceName }: { initialWorkspaceName: string }) {
  const [state, action, pending] = useActionState(initialSetupAction, {});
  const [workspaceName, setWorkspaceName] = useState(initialWorkspaceName);
  const [year, setYear] = useState(2026);
  const [operators, setOperators] = useState<OperatorRow[]>([
    { key: "owner", displayName: "事業主" },
    { key: "apparel_operator", displayName: "アパレル担当" },
  ]);
  const [entities, setEntities] = useState<EntityRow[]>([
    { key: "owner_entity", displayName: "事業主" },
  ]);
  const [profiles, setProfiles] = useState<ProfileRow[]>([
    {
      reportingEntityKey: "owner_entity",
      filingMethod: "BLUE",
      consumptionTaxStatus: "",
      blueDeductionTarget: "",
      inventoryValuationMethod: "",
      inventoryValuationMethodNote: "",
    },
  ]);
  const [units, setUnits] = useState<UnitRow[]>([
    {
      key: "china_import",
      code: "CHINA_IMPORT",
      name: "中国輸入",
      color: "#2563eb",
      defaultOperatorKey: "owner",
      reportingEntityKey: "owner_entity",
    },
    {
      key: "apparel",
      code: "APPAREL",
      name: "アパレル",
      color: "#db2777",
      defaultOperatorKey: "apparel_operator",
      reportingEntityKey: "owner_entity",
    },
  ]);

  const payload = JSON.stringify({
    workspaceName,
    year,
    operators,
    reportingEntities: entities,
    fiscalYearProfiles: profiles,
    businessUnits: units.map((unit) => ({
      code: unit.code,
      name: unit.name,
      color: unit.color,
      defaultOperatorKey: unit.defaultOperatorKey,
      reportingEntityKey: unit.reportingEntityKey,
    })),
  });

  const addOperator = () =>
    setOperators((rows) => [...rows, { key: newKey("operator"), displayName: "新しい入力者" }]);
  const addEntity = () => {
    const key = newKey("entity");
    setEntities((rows) => [...rows, { key, displayName: "新しい申告主体" }]);
    setProfiles((rows) => [
      ...rows,
      {
        reportingEntityKey: key,
        filingMethod: "BLUE",
        consumptionTaxStatus: "",
        blueDeductionTarget: "",
        inventoryValuationMethod: "",
        inventoryValuationMethodNote: "",
      },
    ]);
  };
  const addUnit = () =>
    setUnits((rows) => [
      ...rows,
      {
        key: newKey("unit"),
        code: "NEW_UNIT",
        name: "新しい販売部門",
        color: "#176b52",
        defaultOperatorKey: operators[0]?.key ?? "",
        reportingEntityKey: entities[0]?.key ?? "",
      },
    ]);

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Initial setup</p>
          <h1>物販帳を準備する</h1>
          <p className="muted">
            入力者、販売部門、申告主体は分けて管理します。税務判断は自動で行いません。
          </p>
        </div>
        <span className="status-chip">{year}年度</span>
      </header>
      <form action={action} className="stack">
        <input type="hidden" name="setupPayload" value={payload} />
        {state.error ? (
          <p className="message error" role="alert">
            {state.error}
          </p>
        ) : null}

        <section className="card setup-section">
          <h2>1. ワークスペースと対象年度</h2>
          <div className="setup-grid">
            <label className="field">
              <span>表示名</span>
              <input
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
                maxLength={100}
                required
              />
            </label>
            <label className="field">
              <span>初期設定する年度</span>
              <input
                type="number"
                value={year}
                onChange={(event) => setYear(Number(event.target.value))}
                min={2000}
                max={2200}
                required
              />
            </label>
          </div>
        </section>

        <section className="card setup-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Operators</p>
              <h2>2. 入力者</h2>
            </div>
            <button className="button secondary" type="button" onClick={addOperator}>
              入力者を追加
            </button>
          </div>
          <div className="repeat-grid">
            {operators.map((operator, index) => {
              const referenced = units.some((unit) => unit.defaultOperatorKey === operator.key);
              return (
                <div className="repeat-row" key={operator.key}>
                  <label className="field">
                    <span>表示名</span>
                    <input
                      value={operator.displayName}
                      onChange={(event) =>
                        setOperators((rows) =>
                          rows.map((row, rowIndex) =>
                            rowIndex === index ? { ...row, displayName: event.target.value } : row,
                          ),
                        )
                      }
                      maxLength={50}
                      required
                    />
                  </label>
                  <button
                    className="button secondary"
                    type="button"
                    disabled={operators.length === 1 || referenced}
                    onClick={() =>
                      setOperators((rows) => rows.filter((row) => row.key !== operator.key))
                    }
                  >
                    削除
                  </button>
                </div>
              );
            })}
          </div>
          <p className="muted">部門で選択中の入力者は、先に部門の割当を変更すると削除できます。</p>
        </section>

        <section className="card setup-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Reporting entities</p>
              <h2>3. 申告主体と年度設定</h2>
            </div>
            <button className="button secondary" type="button" onClick={addEntity}>
              申告主体を追加
            </button>
          </div>
          <div className="stack">
            {entities.map((entity, index) => {
              const profile = profiles.find((item) => item.reportingEntityKey === entity.key)!;
              const referenced = units.some((unit) => unit.reportingEntityKey === entity.key);
              const updateProfile = (next: Partial<ProfileRow>) =>
                setProfiles((rows) =>
                  rows.map((row) =>
                    row.reportingEntityKey === entity.key ? { ...row, ...next } : row,
                  ),
                );
              return (
                <div className="setup-section" key={entity.key}>
                  <div className="section-heading">
                    <label className="field">
                      <span>申告主体名</span>
                      <input
                        value={entity.displayName}
                        onChange={(event) =>
                          setEntities((rows) =>
                            rows.map((row, rowIndex) =>
                              rowIndex === index
                                ? { ...row, displayName: event.target.value }
                                : row,
                            ),
                          )
                        }
                        maxLength={50}
                        required
                      />
                    </label>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={entities.length === 1 || referenced}
                      onClick={() => {
                        setEntities((rows) => rows.filter((row) => row.key !== entity.key));
                        setProfiles((rows) =>
                          rows.filter((row) => row.reportingEntityKey !== entity.key),
                        );
                      }}
                    >
                      削除
                    </button>
                  </div>
                  <div className="setup-grid">
                    <label className="field">
                      <span>申告方式</span>
                      <select
                        value={profile.filingMethod}
                        onChange={(event) =>
                          updateProfile({
                            filingMethod: event.target.value as ProfileRow["filingMethod"],
                            blueDeductionTarget:
                              event.target.value === "WHITE" ? "NONE" : profile.blueDeductionTarget,
                          })
                        }
                      >
                        <option value="BLUE">青色</option>
                        <option value="WHITE">白色</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>消費税区分</span>
                      <select
                        value={profile.consumptionTaxStatus}
                        required
                        onChange={(event) =>
                          updateProfile({
                            consumptionTaxStatus: event.target
                              .value as ProfileRow["consumptionTaxStatus"],
                          })
                        }
                      >
                        <option value="" disabled>
                          確認して選択
                        </option>
                        <option value="EXEMPT">免税事業者</option>
                        <option value="TAXABLE">課税事業者</option>
                        <option value="INVOICE_REGISTERED">インボイス登録事業者</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>青色申告特別控除の目標</span>
                      <select
                        value={profile.blueDeductionTarget}
                        required
                        disabled={profile.filingMethod === "WHITE"}
                        onChange={(event) =>
                          updateProfile({
                            blueDeductionTarget: event.target
                              .value as ProfileRow["blueDeductionTarget"],
                          })
                        }
                      >
                        <option value="" disabled>
                          確認して選択
                        </option>
                        <option value="NONE">なし</option>
                        <option value="DEDUCTION_100K">10万円</option>
                        <option value="DEDUCTION_550K">55万円</option>
                        <option value="DEDUCTION_650K">65万円</option>
                      </select>
                    </label>
                    <label className="field">
                      <span>棚卸資産の評価方法</span>
                      <select
                        value={profile.inventoryValuationMethod}
                        required
                        onChange={(event) =>
                          updateProfile({
                            inventoryValuationMethod: event.target
                              .value as ProfileRow["inventoryValuationMethod"],
                          })
                        }
                      >
                        <option value="" disabled>
                          確認して選択
                        </option>
                        <option value="SPECIFIC">個別法</option>
                        <option value="LAST_PURCHASE_COST">最終仕入原価法</option>
                        <option value="GROSS_AVERAGE">総平均法</option>
                        <option value="OTHER">その他</option>
                      </select>
                    </label>
                    {profile.inventoryValuationMethod === "OTHER" ? (
                      <label className="field">
                        <span>「その他」の方法</span>
                        <input
                          value={profile.inventoryValuationMethodNote}
                          onChange={(event) =>
                            updateProfile({ inventoryValuationMethodNote: event.target.value })
                          }
                          maxLength={200}
                          required
                        />
                      </label>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="card setup-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Business units</p>
              <h2>4. 販売部門と年度別割当</h2>
            </div>
            <button className="button secondary" type="button" onClick={addUnit}>
              販売部門を追加
            </button>
          </div>
          <div className="stack">
            {units.map((unit, index) => {
              const entity = entities.find((item) => item.key === unit.reportingEntityKey);
              const filingMethod = profiles.find(
                (item) => item.reportingEntityKey === unit.reportingEntityKey,
              )?.filingMethod;
              const update = (next: Partial<UnitRow>) =>
                setUnits((rows) =>
                  rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...next } : row)),
                );
              return (
                <div className="setup-section" key={unit.key}>
                  <div className="section-heading">
                    <strong>{unit.name || `販売部門 ${index + 1}`}</strong>
                    <button
                      className="button secondary"
                      type="button"
                      disabled={units.length === 1}
                      onClick={() => setUnits((rows) => rows.filter((row) => row.key !== unit.key))}
                    >
                      削除
                    </button>
                  </div>
                  <div className="setup-grid">
                    <label className="field">
                      <span>部門コード</span>
                      <input
                        value={unit.code}
                        onChange={(event) => update({ code: event.target.value.toUpperCase() })}
                        pattern="[A-Z0-9_]+"
                        maxLength={40}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>販売部門名</span>
                      <input
                        value={unit.name}
                        onChange={(event) => update({ name: event.target.value })}
                        maxLength={80}
                        required
                      />
                    </label>
                    <label className="field">
                      <span>表示色</span>
                      <input
                        type="color"
                        value={unit.color}
                        onChange={(event) => update({ color: event.target.value })}
                      />
                    </label>
                    <label className="field">
                      <span>{year}年度の主な入力者</span>
                      <select
                        value={unit.defaultOperatorKey}
                        onChange={(event) => update({ defaultOperatorKey: event.target.value })}
                      >
                        {operators.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span>{year}年度の申告主体</span>
                      <select
                        value={unit.reportingEntityKey}
                        onChange={(event) => update({ reportingEntityKey: event.target.value })}
                      >
                        {entities.map((item) => (
                          <option key={item.key} value={item.key}>
                            {item.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="field">
                      <span>申告方式</span>
                      <strong>
                        {entity
                          ? `${entity.displayName}の${filingMethod === "WHITE" ? "白色" : "青色"}申告`
                          : "未選択"}
                      </strong>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <p className="notice">
          所得の帰属や税務区分は、届出と実際の経営実態を確認して選択してください。
        </p>
        <button className="button" type="submit" disabled={pending}>
          {pending ? "保存しています…" : "内容を確認して初期設定を完了"}
        </button>
      </form>
    </div>
  );
}
