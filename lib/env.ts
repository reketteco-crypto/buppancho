import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.string().startsWith("postgresql://"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  ALLOWED_ORIGINS: z.string().optional(),
  BACKUP_STATUS_FILE: z.string().default("/var/run/buppancho-backup/status.json"),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;
let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= serverEnvSchema.parse(process.env);
  return cached;
}
