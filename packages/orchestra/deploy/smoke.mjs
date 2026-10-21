import process from "node:process";
import console from "node:console";
import { setTimeout as sleep } from "node:timers/promises";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

// Run from the repository root after building apo-single-vm:local.
const file = fileURLToPath(new URL("./compose.smoke.yml", import.meta.url));
const project = `apo-smoke-${process.pid}`;
const compose = (...args) =>
  execFileSync("docker", ["compose", "-p", project, "-f", file, ...args], {
    encoding: "utf8",
    timeout: 240_000,
  });
const run = (service, script, ...args) =>
  compose(
    "exec",
    "-T",
    service,
    "node",
    "--input-type=module",
    "-e",
    script,
    ...args,
  ).trim();
const check = (label) => console.log(`PASS ${label}`);
const fetchScript = `const r=await fetch('http://127.0.0.1:3300'+process.argv[1],{method:process.argv[2],headers:JSON.parse(process.argv[3]),...(process.argv[4]?{body:process.argv[4]}:{})});console.log(JSON.stringify({status:r.status,body:await r.text(),cookie:r.headers.get('set-cookie')}));`;
const request = (
  path,
  method = "GET",
  headers = {},
  body = "",
  service = "demo",
) =>
  JSON.parse(
    run(service, fetchScript, path, method, JSON.stringify(headers), body),
  );
const json = (path, headers) => {
  const r = request(path, "GET", headers);
  assert.equal(r.status, 200, r.body);
  return JSON.parse(r.body);
};
try {
  compose("up", "-d", "--wait", "--wait-timeout", "150", "demo");
  assert.equal(run("demo", "console.log(process.getuid())"), "1000");
  const processes = run(
    "demo",
    `import fs from 'node:fs';const names=fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n));const children=names.flatMap(n=>{try{const cmd=fs.readFileSync('/proc/'+n+'/cmdline','utf8');return cmd.split('\\0')[1]==='dist/main.js'?[fs.readlinkSync('/proc/'+n+'/cwd').split('/').at(-1)]:[]}catch{return []}});console.log(JSON.stringify(children.sort()));`,
  );
  assert.deepEqual(JSON.parse(processes), [
    "agent-orchestrator",
    "durable-ledger",
    "orchestra",
    "pay-core",
  ]);
  for (const port of [3000, 3100, 3200]) {
    assert.equal(
      run(
        "demo",
        `const os=await import('node:os');const ip=Object.values(os.networkInterfaces()).flat().find(a=>a.family==='IPv4'&&!a.internal).address;try{await fetch('http://'+ip+':${port}/healthz',{signal:AbortSignal.timeout(2000)});console.log('exposed')}catch{console.log('internal')}`,
      ),
      "internal",
    );
  }
  const schemas = compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-U",
    "apo",
    "-d",
    "apo",
    "-Atc",
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('public','ledger','agent','orchestra') ORDER BY 1",
  ).trim();
  assert.equal(schemas, "agent\nledger\norchestra\npublic");
  check(
    "four migrated services, non-root runtime, loopback-only internal listeners",
  );
  for (const asset of ["/public/htmx.min.js", "/public/experiment-client.js"]) {
    const result = request(asset);
    assert.equal(result.status, 200);
    assert.ok(result.body.length > 1000);
  }
  const home = request("/");
  assert.equal(home.status, 200);
  assert.ok(home.body.includes("<html"));
  assert.ok(home.cookie?.includes("apo_customer_id="));
  const cookie = home.cookie.split(";")[0];
  const headers = {
    cookie,
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  // Explicit dev registration travels through exactly the public callback route.
  const registration = request("/api/inngest", "PUT");
  assert.equal(registration.status, 200, registration.body);
  await sleep(2000);
  const challenge = request(
    "/ui/challenges",
    "POST",
    headers,
    "scenario=duplicates",
  );
  assert.equal(challenge.status, 200, challenge.body);
  const id = JSON.parse(challenge.body).intent.id;
  let intent;
  for (let i = 0; i < 90; i++) {
    intent = json(`/api/intents/${id}`, { cookie }).intent;
    if (intent.status === "completed" || intent.status === "failed") break;
    await sleep(1000);
  }
  assert.equal(intent.status, "completed", JSON.stringify(intent));
  const evidence = json(`/api/intents/${id}/evidence`, { cookie }).evidence;
  assert.equal(evidence.statusSource, "inngest");
  assert.equal(evidence.payment.availability, "known");
  assert.equal(evidence.payment.snapshot.capturedAmount, 50000);
  assert.equal(evidence.ledger.entries.length, 2);
  assert.ok(
    evidence.journal.attempts.some(
      (a) => a.step === "capture" && a.outcome === "succeeded",
    ),
  );
  assert.equal(request(`/api/intents/${id}`).status, 404);
  assert.equal(request("/internal/grant", "POST").status, 404);
  assert.equal(request("/api/inngest/workflows").status, 404);
  const replay = request(`/api/intents/${id}/redeliver`, "POST", { cookie });
  assert.equal(replay.status, 200, replay.body);
  assert.equal(JSON.parse(replay.body).invariantVerified, true, replay.body);
  assert.equal(JSON.parse(replay.body).receipts.length, 10);
  const replayed = json(`/api/intents/${id}/evidence`, { cookie }).evidence;
  assert.deepEqual(
    replayed.ledger.entries.map((e) => e.id),
    evidence.ledger.entries.map((e) => e.id),
  );
  check(
    "assets, browser session ownership, real challenge/workflow/payment/journal and replay evidence",
  );
  compose("restart", "demo");
  compose("up", "-d", "--wait", "--wait-timeout", "150", "demo");
  const persisted = json(`/api/intents/${id}/evidence`, { cookie }).evidence;
  assert.deepEqual(
    persisted.ledger.entries.map((e) => e.id),
    evidence.ledger.entries.map((e) => e.id),
  );
  assert.equal(
    json(`/api/intents/${id}`, { cookie }).intent.status,
    "completed",
  );
  check("database records persist across complete container restart");
  compose(
    "--profile",
    "cloud-check",
    "up",
    "-d",
    "--wait",
    "--wait-timeout",
    "150",
    "cloud-check",
  );
  const unsigned = request(
    "/api/inngest?fnId=payment-execute&stepId=step",
    "POST",
    { "content-type": "application/json" },
    "{}",
    "cloud-check",
  );
  assert.equal(unsigned.status, 401, unsigned.body);
  check("cloud-mode unsigned callback rejected with network egress disabled");
  run(
    "demo",
    `import fs from 'node:fs';for(const n of fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n))){try{if(fs.readlinkSync('/proc/'+n+'/cwd')==='/repo/packages/pay-core'){process.kill(Number(n),'SIGKILL');break}}catch{}}`,
  );
  const container = compose("ps", "-aq", "demo").trim();
  const exit = execFileSync("docker", ["wait", container], {
    encoding: "utf8",
    timeout: 25_000,
  }).trim();
  assert.equal(exit, "1");
  check("unexpected child failure exits whole container nonzero");
  const start = Date.now();
  compose("stop", "cloud-check");
  assert.ok(Date.now() - start < 20_000);
  const cloudContainer = compose("ps", "-aq", "cloud-check").trim();
  assert.equal(
    execFileSync(
      "docker",
      ["inspect", "--format", "{{.State.ExitCode}}", cloudContainer],
      { encoding: "utf8" },
    ).trim(),
    "0",
  );
  check("SIGTERM stops all children cleanly within platform kill budget");
} catch (error) {
  console.error(compose("logs", "--tail", "100"));
  throw error;
} finally {
  compose("--profile", "cloud-check", "down", "-v", "--remove-orphans");
}
