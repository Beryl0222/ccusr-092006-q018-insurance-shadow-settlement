import assert from "node:assert/strict";
import test from "node:test";
import { buildWorld, ingestAll, refsWith } from "./helpers.js";
import { historicalClaims, mappingRevision2, REGION_A, REGION_B } from "../examples/fixtures.js";
import { ReleaseGatekeeper } from "../src/release.js";

async function qualifiedWorld() {
  const world = await buildWorld();
  await ingestAll(world, historicalClaims());
  const revA = await world.svc.reviseMapping(
    { region: REGION_A, revision: 1, content: mappingRevision2(), supersedes_revision: 0 });
  const revB = await world.svc.reviseMapping(
    { region: REGION_B, revision: 1, content: mappingRevision2(), supersedes_revision: 0 });
  const refs = refsWith(world, { [REGION_A]: revA.snapshot.content_hash, [REGION_B]: revB.snapshot.content_hash });
  await world.svc.startReplayJob({ jobId: "full", exerciseId: "round-1", shardCount: 3, refs });
  await world.svc.runJob("full");
  const gate = new ReleaseGatekeeper(world.store);
  const catalogVersion = world.frozen.cand_catalog.content_hash;
  return { world, gate, catalogVersion };
}

async function reviewBatch(gate, batchId, members, verdictFor = () => "MATCH") {
  for (const [i, claimId] of members.entries()) {
    await gate.recordRecheck({
      batchId, claimId,
      reviewerToken: `rv-${(i + 0x100000).toString(16)}`,
      verdict: verdictFor(claimId),
    });
  }
}

test("未签署或未完成复核时不具备发布资格", async () => {
  const { world, gate, catalogVersion } = await qualifiedWorld();
  const batch = await gate.drawSample({
    batchId: "smp-1", catalogVersion, fraction: 1, seed: "round-1", region: REGION_A,
  });
  await reviewBatch(gate, "smp-1", batch.members);

  const { decision, gate_results } = await gate.evaluate({
    catalogVersion, batchId: "smp-1", requiredRegions: [REGION_A, REGION_B],
    minSampleFraction: 1, minConsistency: 1,
  });
  assert.equal(decision, "NOT_QUALIFIED");
  const regionGate = gate_results.find((g) => g.name === "REGION_SIGNOFF");
  assert.equal(regionGate.passed, false);
  // 判定只落事件，不存在发布动作
  assert.ok(world.store.events().some((e) => e.kind === "RELEASE_QUALIFIED"));
});

test("抽样复核一致率达标且各地区按当前修订签署后具备发布资格", async () => {
  const { world, gate, catalogVersion } = await qualifiedWorld();
  const batch = await gate.drawSample({
    batchId: "smp-2", catalogVersion, fraction: 1, seed: "round-1", region: REGION_A,
  });
  await reviewBatch(gate, "smp-2", batch.members);
  await gate.signRegion({ region: REGION_A, catalogVersion, signerToken: "sg-aaaaaa" });
  await gate.signRegion({ region: REGION_B, catalogVersion, signerToken: "sg-bbbbbb" });

  const { decision, gate_results } = await gate.evaluate({
    catalogVersion, batchId: "smp-2", requiredRegions: [REGION_A, REGION_B],
    minSampleFraction: 1, minConsistency: 0.95,
  });
  assert.equal(decision, "QUALIFIED");
  assert.deepEqual(gate_results.map((g) => [g.name, g.passed]), [
    ["SAMPLING", true],
    ["RECHECK_CONSISTENCY", true],
    ["RESULTS_CURRENT", true],
    ["NO_CODE_MISSING", true],
    ["REGION_SIGNOFF", true],
  ]);
});

test("抽样可复算：同参数两次抽样成员一致", async () => {
  const { gate, catalogVersion } = await qualifiedWorld();
  const b1 = await gate.drawSample({ batchId: "smp-a", catalogVersion, fraction: 0.5, seed: "seed-x", region: REGION_A });
  const b2 = await gate.drawSample({ batchId: "smp-b", catalogVersion, fraction: 0.5, seed: "seed-x", region: REGION_A });
  assert.deepEqual(b1.members, b2.members);
});

test("复核存在不一致结论时一致率门槛失败", async () => {
  const { gate, catalogVersion } = await qualifiedWorld();
  const batch = await gate.drawSample({
    batchId: "smp-3", catalogVersion, fraction: 1, seed: "round-1", region: REGION_A,
  });
  await reviewBatch(gate, "smp-3", batch.members, (id) => (id === batch.members[0] ? "MISMATCH" : "MATCH"));
  await gate.signRegion({ region: REGION_A, catalogVersion, signerToken: "sg-aaaaaa" });
  await gate.signRegion({ region: REGION_B, catalogVersion, signerToken: "sg-bbbbbb" });

  const { decision, gate_results } = await gate.evaluate({
    catalogVersion, batchId: "smp-3", requiredRegions: [REGION_A, REGION_B],
    minSampleFraction: 1, minConsistency: 0.95,
  });
  assert.equal(decision, "NOT_QUALIFIED");
  const recheckGate = gate_results.find((g) => g.name === "RECHECK_CONSISTENCY");
  assert.equal(recheckGate.passed, false);
  assert.ok(recheckGate.detail.consistency < 0.95);
});

test("签署后映射又被修订：旧签署失效，须重算并重签才合格", async () => {
  const { world, gate, catalogVersion } = await qualifiedWorld();
  const batch = await gate.drawSample({
    batchId: "smp-4", catalogVersion, fraction: 1, seed: "round-1", region: REGION_A,
  });
  await reviewBatch(gate, "smp-4", batch.members);
  await gate.signRegion({ region: REGION_A, catalogVersion, signerToken: "sg-aaaaaa" });
  await gate.signRegion({ region: REGION_B, catalogVersion, signerToken: "sg-bbbbbb" });

  // 签署后 A 地区又出修订（内容等价改动也形成新修订号）
  const rev2 = await world.svc.reviseMapping(
    { region: REGION_A, revision: 2, content: mappingRevision2(), supersedes_revision: 1,
      changedCodes: ["L001"] });
  const refs = refsWith(world, {
    [REGION_A]: rev2.snapshot.content_hash,
    [REGION_B]: world.store.currentMapping(REGION_B).content_hash,
  });
  await world.svc.startIncrementalReplay({ jobId: "incr", exerciseId: "round-2", refs, region: REGION_A });
  await world.svc.runJob("incr");

  const before = await gate.evaluate({
    catalogVersion, batchId: "smp-4", requiredRegions: [REGION_A, REGION_B],
    minSampleFraction: 1, minConsistency: 0.95,
  });
  assert.equal(before.decision, "NOT_QUALIFIED");
  assert.equal(before.gate_results.find((g) => g.name === "REGION_SIGNOFF").passed, false);

  // 按新修订重签后合格
  await gate.signRegion({ region: REGION_A, catalogVersion, signerToken: "sg-cccccc" });
  const after = await gate.evaluate({
    catalogVersion, batchId: "smp-4", requiredRegions: [REGION_A, REGION_B],
    minSampleFraction: 1, minConsistency: 0.95,
  });
  assert.equal(after.decision, "QUALIFIED");
});

test("复核结论不可篡改、签署不可重复", async () => {
  const { gate, catalogVersion } = await qualifiedWorld();
  const batch = await gate.drawSample({
    batchId: "smp-5", catalogVersion, fraction: 1, seed: "round-1", region: REGION_A,
  });
  await gate.recordRecheck({ batchId: "smp-5", claimId: batch.members[0], reviewerToken: "rv-aaaaaa", verdict: "MATCH" });
  await assert.rejects(
    () => gate.recordRecheck({ batchId: "smp-5", claimId: batch.members[0], reviewerToken: "rv-bbbbbb", verdict: "MISMATCH" }),
    /已有复核结论/,
  );
  await gate.signRegion({ region: REGION_A, catalogVersion, signerToken: "sg-aaaaaa" });
  await assert.rejects(
    () => gate.signRegion({ region: REGION_A, catalogVersion, signerToken: "sg-bbbbbb" }),
    /勿重复签署/,
  );
});
