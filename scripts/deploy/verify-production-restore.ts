import { Client } from "pg";
import { canonicalConstraintDefinition } from "../../lib/operations/constraint-definition";

function configuredUrl(value: string | undefined) {
  try {
    return new URL(value ?? "");
  } catch {
    throw new Error("照合先の接続設定を確認してください。秘密情報は表示していません。");
  }
}
const sourceUrl = configuredUrl(process.env.DATABASE_URL);
const targetUrl = configuredUrl(process.env.RESTORED_DATABASE_URL);
if (
  sourceUrl.hostname !== "postgres" ||
  sourceUrl.port !== "5432" ||
  sourceUrl.username !== "buppancho_prod" ||
  sourceUrl.pathname !== "/buppancho_prod" ||
  targetUrl.host !== sourceUrl.host ||
  targetUrl.username !== sourceUrl.username ||
  !/^\/buppancho_prod_restore_\d{14}_test$/.test(targetUrl.pathname)
)
  throw new Error("本番と専用の別復元先を確認できません。照合を停止します。");

const clients = [sourceUrl, targetUrl].map(
  (url) => new Client({ connectionString: url.href, connectionTimeoutMillis: 5000 }),
);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
try {
  await Promise.all(clients.map((client) => client.connect()));
  const snapshots = await Promise.all(
    clients.map(async (client, index) => {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const identity = await client.query<{ database: string; account: string }>(
        "SELECT current_database() AS database,current_user AS account",
      );
      if (
        identity.rows[0]?.database !==
          (index === 0 ? "buppancho_prod" : targetUrl.pathname.slice(1)) ||
        identity.rows[0]?.account !== "buppancho_prod"
      )
        throw new Error("復元照合の接続先を確認できません。照合を停止しました。");
      const tables = await client.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
      );
      const snapshot: Record<string, unknown> = {};
      for (const { tablename } of tables.rows) {
        const result = await client.query(
          `SELECT count(*)::text AS count, md5(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text)) AS digest FROM public.${quote(tablename)} t`,
        );
        snapshot[tablename] = result.rows[0];
      }
      snapshot.sequences = (
        await client.query(
          "SELECT sequencename,last_value::text FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename",
        )
      ).rows;
      snapshot.constraints = (
        await client.query<{
          table_name: string;
          conname: string;
          definition: string;
          validated: boolean;
          deferrable: boolean;
          deferred: boolean;
          enforced: boolean;
        }>(
          "SELECT c.conrelid::regclass::text AS table_name,c.conname,pg_get_constraintdef(c.oid) AS definition,c.convalidated AS validated,c.condeferrable AS deferrable,c.condeferred AS deferred,c.conenforced AS enforced FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' ORDER BY 1,2",
        )
      ).rows.map((constraint) => ({
        ...constraint,
        definition: canonicalConstraintDefinition(constraint.definition),
      }));
      snapshot.triggers = (
        await client.query(
          "SELECT t.tgrelid::regclass::text AS table_name,t.tgname,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1,2",
        )
      ).rows;
      snapshot.functions = (
        await client.query(
          "SELECT p.oid::regprocedure::text AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind IN ('f','p') ORDER BY 1",
        )
      ).rows;
      return { database: identity.rows[0]?.database, tables: tables.rowCount, snapshot };
    }),
  );
  if (
    snapshots[0]?.database !== "buppancho_prod" ||
    snapshots[1]?.database !== targetUrl.pathname.slice(1) ||
    !snapshots[0]?.tables ||
    JSON.stringify(snapshots[0].snapshot) !== JSON.stringify(snapshots[1]?.snapshot)
  )
    throw new Error("復元照合が一致しません。元DBを保持し、入力を再開せず調査してください。");
  console.log(
    `復元照合成功: ${snapshots[0].tables}テーブルの件数・全列ハッシュ、シーケンス、制約・トリガー・関数が一致しました。`,
  );
} catch (error) {
  // Never emit connection errors, hashes, credentials, or individual business rows.
  console.error(
    error instanceof Error && error.message.startsWith("復元照合")
      ? error.message
      : "復元先への接続または読み取り照合に失敗しました。秘密情報は表示していません。",
  );
  process.exitCode = 1;
} finally {
  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.query("ROLLBACK");
      } catch {
        // A connection may not have been established.
      } finally {
        await client.end();
      }
    }),
  );
}
