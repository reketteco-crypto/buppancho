import { createServer as httpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const target = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
if (
  !target ||
  !["127.0.0.1", "localhost"].includes(target.hostname) ||
  target.port !== "55432" ||
  !/^\/buppancho_phase2_restored_[a-z0-9_]+_test$/.test(target.pathname)
)
  throw new Error("HTTPS復旧試験は独立したrestored専用DBを指定してください。");
const temporary = resolve(".tmp") + sep;
function pem(name) {
  const path = resolve(process.env[name] ?? "");
  if (!path.startsWith(temporary)) throw new Error("証明書は試験用.tmp内に配置してください。");
  return readFileSync(path);
}
const cert = pem("PHASE2_TLS_CERT"),
  key = pem("PHASE2_TLS_KEY");
const app = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3104"],
  {
    env: {
      ...process.env,
      BUPPANCHO_TEST_INSTANCE: "phase2",
      APP_URL: "https://localhost:3443",
      ALLOWED_ORIGINS: "localhost:3443",
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);
const server = httpsServer({ cert, key, minVersion: "TLSv1.2" }, (request, response) => {
  if (request.headers.host !== "localhost:3443") {
    response.writeHead(400).end();
    return;
  }
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: 3104,
      path: request.url,
      method: request.method,
      headers: {
        ...request.headers,
        host: "localhost:3443",
        "x-forwarded-host": "localhost:3443",
        "x-forwarded-proto": "https",
      },
    },
    (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    },
  );
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
});
server.listen(3443, "127.0.0.1");
function stop() {
  server.close();
  app.kill();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
app.on("exit", (code) => {
  server.close();
  process.exitCode = code ?? 1;
});
server.on("error", () => {
  app.kill();
  process.exitCode = 1;
});
