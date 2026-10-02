import assert from "node:assert/strict";
import test from "node:test";
import { makeService, standardSnapshotInput, historyEvent, runFullReplay } from "./helpers/fixtures.js";
import { createShadowServer } from "../src/server/http.js";

async function withServer(service) {
  const server = createShadowServer(service);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const call = async (method, path, body, { role = "analyst", actor = "tester", headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-shadow-role": role,
        "x-shadow-actor": actor,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, headers: res.headers, json };
  };
  return {
    call,
    close: async () => {
      // undici 默认 keep-alive 会挂住 server.close()，先断开全部连接。
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("HTTP：健康检查带 shadow lane 标记且禁缓存", async () => {
  const t = makeService();
  const http = await withServer(t.service);
  const res = await http.call("GET", "/shadow/health");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-shadow-lane"), "1");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.json.data.lane, "shadow");
  await http.close();
  t.cleanup();
});

test("HTTP：患者/真实通道路径一律 403，影子数据不可能从这些路径取出", async () => {
  const t = makeService();
  const http = await withServer(t.service);
  for (const p of ["/patient/claims/h1", "/production/settle", "/live/claims", "/settle/outbox"]) {
    const res = await http.call("GET", p);
    assert.equal(res.status, 403, p);
    assert.equal(res.json.error.code, "ENCLAVE_VIOLATION");
  }
  // 非 /shadow 前缀也不提供服务
  assert.equal((await http.call("GET", "/claims")).status, 404);
  await http.close();
  t.cleanup();
});

test("HTTP：患者角色即使打 /shadow 也被拒绝；观察者看不到内部费率", async () => {
  const t = makeService();
  const http = await withServer(t.service);
  t.service.ingestHistory([historyEvent()]);
  const snap = t.service.freezeCatalog(standardSnapshotInput()).snapshot;
  runFullReplay(t.service, snap.snapshot_id);

  const patientRes = await http.call("GET", `/shadow/snapshots/${snap.snapshot_id}/summary`, undefined, { role: "patient" });
  assert.equal(patientRes.status, 403);

  const observer = await http.call("GET", `/shadow/snapshots/${snap.snapshot_id}/basis?event_ref=h-1&line_ref=l1`, undefined, { role: "observer" });
  assert.equal(observer.status, 200);
  const body = JSON.stringify(observer.json.data);
  assert.ok(!/"rate"\s*:/.test(body), "观察者响应中不得出现内部费率字段");

  const analyst = await http.call("GET", `/shadow/snapshots/${snap.snapshot_id}/basis?event_ref=h-1&line_ref=l1`);
  assert.ok(/"rate"\s*:/.test(JSON.stringify(analyst.json.data)));
  await http.close();
  t.cleanup();
});

test("HTTP 端到端：冻结 -> 摄入 -> 分片作业 -> 下钻 -> 复核 -> 签署 -> 发证", async () => {
  const t = makeService();
  const http = await withServer(t.service);

  const ingest = await http.call("POST", "/shadow/history/ingest", [historyEvent()]);
  assert.deepEqual(ingest.json.data.ingested, ["h-1"]);
  // 未脱敏数据经 HTTP 同样被挡
  const leak = await http.call("POST", "/shadow/history/ingest", [historyEvent({ subject_ref: "110101199001011234" })]);
  assert.equal(leak.status, 403);

  const frozen = await http.call("POST", "/shadow/snapshots/freeze", standardSnapshotInput());
  const snapId = frozen.json.data.snapshot.snapshot_id;
  assert.equal(frozen.status, 200);

  const created = await http.call("POST", "/shadow/jobs", { snapshot_id: snapId, shard_count: 2 });
  const jobId = created.json.data.job.job_id;
  for (let i = 0; i < 2; i++) {
    await http.call("POST", `/shadow/jobs/${jobId}/shards/${i}/lease`, { lease_ms: 3_600_000 });
    await http.call("POST", `/shadow/jobs/${jobId}/shards/${i}/run`, { max_items: 100 });
  }
  assert.equal((await http.call("GET", `/shadow/jobs/${jobId}`)).json.data.job.status, "COMPLETED");

  const summary = await http.call("GET", `/shadow/snapshots/${snapId}/summary`);
  assert.equal(summary.json.data.lines, 1);

  const plan = await http.call("POST", `/shadow/snapshots/${snapId}/review-plans`, {});
  for (const item of plan.json.data.plan.items) {
    const r = await http.call("POST", `/shadow/review-plans/${plan.json.data.plan.plan_id}/items/${item.item_id}/review`, { verdict: "AGREE" });
    assert.equal(r.status, 200);
  }
  const gate = await http.call("GET", `/shadow/review-plans/${plan.json.data.plan.plan_id}/gate`);
  assert.equal(gate.json.data.meets, true);

  const sign = await http.call("POST", "/shadow/regions/sign", { region: "R1", snapshot_id: snapId }, { actor: "gov-li" });
  assert.equal(sign.status, 200);

  const check = await http.call("POST", "/shadow/releases/check", { members: [{ snapshot_id: snapId }] });
  assert.equal(check.json.data.eligibility.eligible, true);
  const issue = await http.call("POST", "/shadow/releases/issue", { members: [{ snapshot_id: snapId }] });
  assert.equal(issue.json.data.certificate.scope, "SHADOW_RELEASE_ELIGIBILITY_ONLY");

  await http.close();
  t.cleanup();
});

test("HTTP：暂停后 run 立即让路，恢复后作业可继续", async () => {
  const t = makeService();
  const http = await withServer(t.service);
  t.service.ingestHistory([historyEvent({ event_ref: "h1" }), historyEvent({ event_ref: "h2" })]);
  const snapId = t.service.freezeCatalog(standardSnapshotInput()).snapshot.snapshot_id;
  const jobId = (await http.call("POST", "/shadow/jobs", { snapshot_id: snapId, shard_count: 1 })).json.data.job.job_id;
  await http.call("POST", `/shadow/jobs/${jobId}/shards/0/lease`, { lease_ms: 3_600_000 });
  await http.call("POST", `/shadow/jobs/${jobId}/pause`, {});
  const stopped = await http.call("POST", `/shadow/jobs/${jobId}/shards/0/run`, { max_items: 10 });
  assert.equal(stopped.json.data.stop_reason, "PAUSED");
  await http.call("POST", `/shadow/jobs/${jobId}/resume`, {});
  t.clock.advance(5000);
  const ran = await http.call("POST", `/shadow/jobs/${jobId}/shards/0/run`, { max_items: 10 });
  assert.equal(ran.json.data.stop_reason, "COMPLETED");
  await http.close();
  t.cleanup();
});
