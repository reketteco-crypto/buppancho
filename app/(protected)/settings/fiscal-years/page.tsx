import { MasterForm } from "@/components/forms/master-form";
import { requireSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import {
  copyFiscalYearAction,
  saveBusinessUnitAssignmentAction,
  saveFiscalYearProfileAction,
  updateFiscalYearStatusAction,
} from "@/app/actions";
import { FiscalProfileFields } from "@/components/forms/fiscal-profile-fields";

const statusLabel = { OPEN: "使用中", CLOSING: "決算処理中", LOCKED: "ロック済み" } as const;

export default async function FiscalYearsPage() {
  const session = await requireSession();
  const db = getDb();
  const workspaceId = session.userAccount.workspaceId;
  const [profiles, entities, units, operators] = await Promise.all([
    db.fiscalYearProfile.findMany({
      where: { reportingEntity: { workspaceId } },
      include: {
        reportingEntity: true,
        assignments: { include: { businessUnit: true, defaultOperator: true } },
      },
      orderBy: [{ year: "desc" }, { reportingEntity: { displayName: "asc" } }],
    }),
    db.reportingEntity.findMany({
      where: { workspaceId, active: true },
      orderBy: { createdAt: "asc" },
    }),
    db.businessUnit.findMany({
      where: { workspaceId, active: true },
      orderBy: { createdAt: "asc" },
    }),
    db.operator.findMany({ where: { workspaceId, active: true }, orderBy: { createdAt: "asc" } }),
  ]);
  const years = [...new Set(profiles.map((profile) => profile.year))].sort((a, b) => b - a);
  const newestYear = years[0] ?? 2026;

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">Fiscal years</p>
          <h1>会計年度と年度別割当</h1>
          <p className="muted">
            申告方式は申告主体・年度単位、主な入力者と帰属先は販売部門・年度単位で管理します。
          </p>
        </div>
      </header>

      <section className="card stack" style={{ marginBottom: 24 }}>
        <h2>翌年度をコピー</h2>
        <MasterForm action={copyFiscalYearAction} className="context-form">
          <label className="field">
            <span>コピー元年度</span>
            <select name="sourceYear" defaultValue={newestYear}>
              {years.map((year) => (
                <option key={year} value={year}>
                  {year}年
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>コピー先年度</span>
            <input
              type="number"
              name="targetYear"
              min={2000}
              max={2200}
              defaultValue={newestYear + 1}
              required
            />
          </label>
          <button className="button" disabled={years.length === 0}>
            年度設定と割当をコピー
          </button>
        </MasterForm>
        <p className="muted">
          コピー先に設定がある場合は実行しません。コピー元年度は変更されません。
        </p>
      </section>

      {years.map((year) => {
        const yearProfiles = profiles.filter((profile) => profile.year === year);
        return (
          <section className="stack year-section" key={year}>
            <div className="section-heading">
              <div>
                <p className="eyebrow">Annual settings</p>
                <h2>{year}年度</h2>
              </div>
            </div>
            <div className="card-grid">
              {yearProfiles.map((profile) => (
                <MasterForm
                  action={saveFiscalYearProfileAction}
                  alternateActions={{ status: updateFiscalYearStatusAction }}
                  className="card stack"
                  key={profile.id}
                >
                  <input type="hidden" name="revision" value={profile.revision} />
                  <input type="hidden" name="year" value={year} />
                  <input type="hidden" name="reportingEntityId" value={profile.reportingEntityId} />
                  {profile.status === "CLOSING" ? (
                    <input type="hidden" name="confirmClosing" value="on" />
                  ) : null}
                  <div className="section-heading">
                    <div>
                      <span className="status-chip">{statusLabel[profile.status]}</span>
                      <h2 style={{ marginTop: 10 }}>{profile.reportingEntity.displayName}</h2>
                    </div>
                    <strong>{profile.filingMethod === "BLUE" ? "青色" : "白色"}申告</strong>
                  </div>
                  <fieldset disabled={profile.status === "LOCKED"} className="plain-fieldset">
                    <FiscalProfileFields values={profile} />
                    <button className="button secondary" style={{ marginTop: 16 }}>
                      年度設定を保存
                    </button>
                  </fieldset>
                  {profile.status !== "LOCKED" ? (
                    <div className="status-actions">
                      {profile.status === "OPEN" ? (
                        <button
                          className="button secondary"
                          data-master-action="status"
                          name="status"
                          value="CLOSING"
                        >
                          決算処理中にする
                        </button>
                      ) : (
                        <button
                          className="button secondary"
                          data-master-action="status"
                          name="status"
                          value="OPEN"
                        >
                          使用中へ戻す
                        </button>
                      )}
                      {profile.status === "CLOSING" ? (
                        <button
                          className="button danger"
                          data-master-action="status"
                          name="status"
                          value="LOCKED"
                        >
                          年度をロック
                        </button>
                      ) : null}
                      <input type="hidden" name="id" value={profile.id} />
                    </div>
                  ) : null}
                </MasterForm>
              ))}
            </div>

            <section className="card stack">
              <h3>販売部門の年度別割当</h3>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>販売部門</th>
                      <th>主な入力者</th>
                      <th>申告主体・申告方式</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {units.map((unit) => {
                      const assignment = yearProfiles
                        .flatMap((profile) => profile.assignments)
                        .find((item) => item.businessUnitId === unit.id);
                      const selectedProfile = assignment
                        ? yearProfiles.find(
                            (profile) => profile.id === assignment.fiscalYearProfileId,
                          )
                        : undefined;
                      const locked = selectedProfile?.status === "LOCKED";
                      return (
                        <tr key={unit.id}>
                          <td>
                            <strong>{unit.name}</strong>
                            <br />
                            <span className="muted">{unit.code}</span>
                          </td>
                          <td colSpan={3}>
                            <MasterForm
                              action={saveBusinessUnitAssignmentAction}
                              className="assignment-form"
                            >
                              <input
                                type="hidden"
                                name="revision"
                                value={assignment?.revision ?? "NEW"}
                              />
                              <input
                                type="hidden"
                                name="fiscalVersions"
                                value={JSON.stringify(
                                  Object.fromEntries(yearProfiles.map((p) => [p.id, p.revision])),
                                )}
                              />
                              <input type="hidden" name="year" value={year} />
                              <input type="hidden" name="businessUnitId" value={unit.id} />
                              {selectedProfile?.status === "CLOSING" ? (
                                <input type="hidden" name="confirmClosing" value="on" />
                              ) : null}
                              <select
                                aria-label={`${unit.name}の主な入力者`}
                                name="defaultOperatorId"
                                defaultValue={assignment?.defaultOperatorId ?? operators[0]?.id}
                                disabled={locked}
                              >
                                {operators.map((operator) => (
                                  <option key={operator.id} value={operator.id}>
                                    {operator.displayName}
                                  </option>
                                ))}
                              </select>
                              <select
                                aria-label={`${unit.name}の申告主体`}
                                name="fiscalYearProfileId"
                                defaultValue={
                                  assignment?.fiscalYearProfileId ?? yearProfiles[0]?.id
                                }
                                disabled={locked}
                              >
                                {yearProfiles.map((profile) => (
                                  <option key={profile.id} value={profile.id}>
                                    {profile.reportingEntity.displayName}（
                                    {profile.filingMethod === "BLUE" ? "青色" : "白色"}）
                                  </option>
                                ))}
                              </select>
                              <button
                                className="button secondary"
                                disabled={locked || yearProfiles.length === 0}
                              >
                                {assignment ? "割当を変更" : "割当を追加"}
                              </button>
                            </MasterForm>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </section>
        );
      })}

      <section className="card stack" style={{ marginTop: 28 }}>
        <h2>申告主体の年度設定を追加</h2>
        <MasterForm action={saveFiscalYearProfileAction} className="stack">
          <input type="hidden" name="revision" value="NEW" />
          <div className="setup-grid">
            <label className="field">
              <span>年度</span>
              <input
                type="number"
                name="year"
                min={2000}
                max={2200}
                defaultValue={newestYear + 1}
                required
              />
            </label>
            <label className="field">
              <span>申告主体</span>
              <select name="reportingEntityId">
                {entities.map((entity) => (
                  <option key={entity.id} value={entity.id}>
                    {entity.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <FiscalProfileFields />
          <button className="button">年度設定を保存</button>
        </MasterForm>
      </section>
      <p className="notice" style={{ marginTop: 20 }}>
        所得の帰属は自由に選べるものではありません。実際の経営実態と届出を確認して設定してください。
      </p>
    </div>
  );
}
