import { Client } from "pg";

// Read-only verification. Creation and restoration of the destination must be
// performed explicitly, with the application stopped, before running this tool.
const sourceUrl = process.env.TEST_DATABASE_URL;
const restoredUrl = process.env.RESTORED_TEST_DATABASE_URL;
if (!sourceUrl || !restoredUrl) throw new Error("照合元・復元先のテストDB URLを指定してください。");
const source = new URL(sourceUrl),
  restored = new URL(restoredUrl);
if (![source, restored].every((url) => url.pathname.endsWith("_test")))
  throw new Error("末尾が _test の専用DBだけを照合できます。");
if (source.host === restored.host && source.pathname === restored.pathname)
  throw new Error("同じDBを復元結果として照合できません。");

const clients = [
  new Client({ connectionString: sourceUrl }),
  new Client({ connectionString: restoredUrl }),
];
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
try {
  await Promise.all(clients.map((client) => client.connect()));
  await Promise.all(
    clients.map((client) => client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")),
  );
  const snapshots = await Promise.all(
    clients.map(async (client) => {
      const tables = await client.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      const results: Record<string, { count: string; digest: string | null }> = {};
      for (const { tablename } of tables.rows) {
        // Hash inside PostgreSQL; never print business records, passwords or session data.
        const result = await client.query<{ count: string; digest: string | null }>(
          `SELECT count(*)::text AS count, md5(string_agg(to_jsonb(t)::text, E'\\n' ORDER BY to_jsonb(t)::text)) AS digest FROM public.${quote(tablename)} t`,
        );
        results[tablename] = result.rows[0]!;
      }
      const sequences = await client.query<{ sequencename: string; last_value: string | null }>(
        "SELECT sequencename, last_value::text FROM pg_sequences WHERE schemaname = 'public' ORDER BY sequencename",
      );
      for (const sequence of sequences.rows)
        results[`sequence:${sequence.sequencename}`] = { count: "0", digest: sequence.last_value };
      return results;
    }),
  );
  const names = [...new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot)))];
  const mismatches = names.filter(
    (name) => JSON.stringify(snapshots[0]![name]) !== JSON.stringify(snapshots[1]![name]),
  );
  if (mismatches.length) throw new Error(`復元内容が一致しないテーブル: ${mismatches.join(", ")}`);
  const rows = Object.values(snapshots[0]!).reduce((sum, value) => sum + BigInt(value.count), 0n);
  console.log(
    `復元照合成功: public の ${names.filter((name) => !name.startsWith("sequence:")).length} テーブル、${rows} 行の件数・全列ハッシュ、および ${names.filter((name) => name.startsWith("sequence:")).length} シーケンスの値が一致しました。`,
  );
} finally {
  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.query("ROLLBACK");
      } finally {
        await client.end();
      }
    }),
  );
}
