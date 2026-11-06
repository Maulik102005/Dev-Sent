import { spawnSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, createConnection } from "node:net";

// Tests own fresh Docker resources. Never load the developer's .env or truncate their database.
const suffix = randomUUID().slice(0, 8);
const postgres = `devsentinel-test-pg-${suffix}`;
const redis = `devsentinel-test-redis-${suffix}`;
const owned = [];
const hostNetworking = process.env.DEVSENTINEL_TEST_NETWORK === "host";
if (hostNetworking && process.platform !== "linux") throw new Error("Host-network test mode is Linux-only");
function docker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 120000 });
  if (result.status !== 0) throw new Error(`Docker test setup failed: ${result.stderr || result.error?.message}`);
  return result.stdout.trim();
}
function cleanup() {
  for (const name of owned) spawnSync("docker", ["rm", "--force", name], { stdio: "ignore", timeout: 10000 });
}
let child;
async function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 200 });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(true); });
    socket.once("timeout", () => { socket.destroy(); resolve(false); });
  });
}
async function availablePort() {
  for (let i = 0; i < 50; i++) {
    const port = Math.floor(Math.random() * (60000 - 35000) + 35000);
    if (await isPortFree(port)) return port;
  }
  throw new Error("Could not find free port");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { child?.kill(signal); cleanup(); process.exit(130); });
try {
  const requestedPgPort = await availablePort();
  docker(["run", "--detach", "--network", hostNetworking ? "host" : "bridge", "--name", postgres, "--label", "devsentinel.test=true", ...(hostNetworking ? [] : ["--publish", `127.0.0.1:${requestedPgPort}:5432`]), "--env", "POSTGRES_PASSWORD=devsentinel", "--env", "POSTGRES_USER=devsentinel", "--env", "POSTGRES_DB=devsentinel_test", "postgres:17-alpine", ...(hostNetworking ? ["postgres", "-c", "listen_addresses=127.0.0.1", "-p", String(requestedPgPort)] : [])]);
  owned.push(postgres);
  const requestedRedisPort = await availablePort();
  docker(["run", "--detach", "--network", hostNetworking ? "host" : "bridge", "--name", redis, "--label", "devsentinel.test=true", ...(hostNetworking ? [] : ["--publish", `127.0.0.1:${requestedRedisPort}:6379`]), "redis:7-alpine", ...(hostNetworking ? ["redis-server", "--bind", "127.0.0.1", "--port", String(requestedRedisPort)] : [])]);
  owned.push(redis);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    const check = spawnSync("docker", ["exec", postgres, "pg_isready", "-h", "127.0.0.1", "-p", String(hostNetworking ? requestedPgPort : 5432), "-U", "devsentinel", "-d", "devsentinel_test"], { stdio: "ignore", timeout: 3000 });
    if (check.status === 0) { ready = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!ready) {
    let logs = "";
    try { logs = docker(["logs", postgres]); } catch (e) { logs = String(e); }
    throw new Error(`Test PostgreSQL did not become ready. Container logs:\n${logs}`);
  }
  function publishedPort(name, port) {
    const info = JSON.parse(docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", name]));
    const binding = info?.[`${port}/tcp`]?.find((binding) => binding.HostIp === "127.0.0.1");
    if (!binding || !/^\d+$/.test(binding.HostPort)) {
      console.error(docker(["inspect", "--format", "{{json .State}} {{json .HostConfig.PortBindings}} {{json .HostConfig.NetworkMode}}", name]));
      throw new Error(`Test container ${name} has no loopback port binding: ${JSON.stringify(info)}`);
    }
    return binding.HostPort;
  }
  const pgPort = hostNetworking ? requestedPgPort : publishedPort(postgres, 5432);
  const redisPort = hostNetworking ? requestedRedisPort : publishedPort(redis, 6379);
  for (const port of [pgPort, redisPort]) {
    let reachable = false;
    for (let attempt = 0; attempt < 40; attempt++) {
      reachable = await new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port: Number(port), timeout: 500 });
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => { socket.destroy(); resolve(false); });
        socket.once("timeout", () => { socket.destroy(); resolve(false); });
      });
      if (reachable) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!reachable) {
      const name = port === pgPort ? postgres : redis;
      let logs = "";
      try { logs = docker(["logs", name]); } catch (e) { logs = String(e); }
      throw new Error(`Disposable test container ${name} on port ${port} is not reachable on loopback. Logs:\n${logs}`);
    }
  }
  console.log("Running integration tests against disposable PostgreSQL and Redis; your development data is untouched.");
  const vitestConfig = process.env.DEVSENTINEL_VITEST_CONFIG || "vitest.integration.config.ts";
  child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "--config", vitestConfig, ...process.argv.slice(2)], {
    stdio: "inherit", env: { ...process.env,
      TEST_DATABASE_URL: `postgres://devsentinel:devsentinel@127.0.0.1:${pgPort}/devsentinel_test`,
      TEST_REDIS_URL: `redis://127.0.0.1:${redisPort}`, DEVSENTINEL_ISOLATED_TESTS: "true",
    },
  });
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)); });
} finally { cleanup(); }
