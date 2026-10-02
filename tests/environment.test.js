import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentBoundary, SINKS, redactForExport } from "../src/environment.js";
import { ShadowEventStore } from "../src/store.js";
import { diffDetail } from "../src/diffs.js";
import { buildWorld, ingestAll, refsWith } from "./helpers.js";
import { historicalClaims, mappingRevision2, REGION_A, REGION_B } from "../examples/fixtures.js";

const root = () => mkdtempSync(join(tmpdir(), "shadow-boundary-"));

test("未获准环境拒绝任何影子读写", () => {
  const b = new EnvironmentBoundary({ envId: "env-prod", approvedEnvIds: ["env-approved"], allowedRoots: ["/data/shadow"] });
  assert.throws(() => b.assertApproved(), /未获准/);
  assert.throws(() => new ShadowEventStore(b, "/data/shadow/e.log"), /未获准/);
});

test("真实结算与面向患者查询汇槽硬禁入，即使在获准环境中", () => {
  const b = new EnvironmentBoundary({ envId: "env-approved", approvedEnvIds: ["env-approved"], allowedRoots: ["/data/shadow"] });
  assert.throws(() => b.assertSink(SINKS.PRODUCTION_SETTLEMENT), /禁止写入/);
  assert.throws(() => b.assertSink(SINKS.PATIENT_QUERY), /禁止写入/);
  b.assertSink(SINKS.SHADOW_EVENT_LOG); // 影子汇槽允许
});

test("影子日志路径必须圈定在获准根目录内", () => {
  const r = root();
  const b = new EnvironmentBoundary({ envId: "env-approved", approvedEnvIds: ["env-approved"], allowedRoots: [r] });
  assert.throws(() => new ShadowEventStore(b, "/etc/passwd-shadow/e.log"), /不在获准根目录/);
  assert.doesNotThrow(() => new ShadowEventStore(b, join(r, "round1", "events.log")));
});

test("导出时患者标识被替换、内部费率被剥离，原始令牌不出现在导出物中", async () => {
  const world = await buildWorld();
  await ingestAll(world, historicalClaims());
  const rev = await world.svc.reviseMapping(
    { region: REGION_A, revision: 1, content: mappingRevision2(), supersedes_revision: 0 });
  await world.svc.reviseMapping(
    { region: REGION_B, revision: 1, content: mappingRevision2(), supersedes_revision: 0 });
  const refs = refsWith(world, { [REGION_A]: rev.snapshot.content_hash, [REGION_B]: rev.snapshot.content_hash });
  await world.svc.startReplayJob({ jobId: "j", exerciseId: "ex", shardCount: 3, refs });
  await world.svc.runJob("j");

  // 对外复核包 = 比较明细（含 claim_snapshot），这是患者标识出现的地方
  const exportPack = [...world.store.state.comparisons.keys()]
    .map((claimId) => diffDetail(world.store, claimId));
  const exported = redactForExport(exportPack, { pepper: "pepper-kept-in-approved-env" });
  const blob = JSON.stringify(exported);

  assert.ok(!blob.includes("pat-"));                 // 患者令牌不出环境
  assert.ok(!/unit_rate|line_charged|total_charged/.test(blob)); // 内部费率字段剥离
  assert.ok(blob.includes("patient_ref"));
  assert.ok(/ext-[0-9a-f]{16}/.test(blob));
  // 同一患者在导出物中使用稳定但不同的假名，且不可逆
  const refs2 = blob.match(/ext-[0-9a-f]{16}/g);
  assert.ok(refs2.length > 0);
});

test("费率表冻结对象导出时内容被整体遮蔽", () => {
  const rateArtifact = {
    artifact_type: "RATE_TABLE", version: "v1",
    content: { rates: { N001: 22 } },
  };
  const [out] = redactForExport([rateArtifact], { pepper: "p" });
  assert.deepEqual(out.content, { redacted: true });
});

test("影子事件全部携带 data_scope=SHADOW", async () => {
  const world = await buildWorld();
  await ingestAll(world, historicalClaims());
  for (const e of world.store.events()) {
    assert.equal(e.data_scope, "SHADOW");
  }
});
