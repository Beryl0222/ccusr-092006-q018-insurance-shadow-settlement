import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { buildWorld, ingestAll, refsWith, approvedBoundary } from "./helpers.js";
import { ShadowEventStore } from "../src/store.js";
import { ShadowSettlementService } from "../src/service.js";
import { historicalClaims, mappingRevision1, mappingRevision2, REGION_A, REGION_B } from "../examples/fixtures.js";
import { diffSummary, drillDown, diffDetail } from "../src/diffs.js";
import { DIFF_KINDS } from "../src/insurance_shadow_settlement.js";

async function worldWithClaims() {
  const world = await buildWorld();
  await ingestAll(world, historicalClaims());
  return world;
}

test("历史事件重复进入：内容相同幂等，内容不同拒绝", async () => {
  const world = await worldWithClaims();
  const claims = historicalClaims();
  const again = await world.svc.ingestClaim(claims[0]);
  assert.equal(again.deduped, true);
  assert.equal(world.store.state.claims.size, 6);

  const tampered = { ...claims[0], lines: [{ line_id: "l1", local_code: "L002", quantity: 9 }] };
  await assert.rejects(() => world.svc.ingestClaim(tampered), /内容哈希不同/);
});

test("未脱敏事件被拒绝接入", async () => {
  const world = await buildWorld();
  const bad = {
    claim_id: "clm-aaaaaa", patient_token: "pat-aaaaaa", region: REGION_A, setting: "OPD",
    service_date: "2026-03-10",
    lines: [{ line_id: "l1", local_code: "L001", quantity: 1, patient_name: "张某" }],
  };
  await assert.rejects(() => world.svc.ingestClaim(bad), /脱敏校验/);
});

test("全量重放：现行与候选结果分别保存，差异三类可下钻到规则依据", async () => {
  const world = await worldWithClaims();
  const rev1 = await world.svc.reviseMapping(
    { region: REGION_A, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  const rev1b = await world.svc.reviseMapping(
    { region: REGION_B, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  void rev1b;

  await world.svc.startReplayJob({
    jobId: "job-full-1", exerciseId: "exercise-round-1", shardCount: 3,
    refs: refsWith(world, { [REGION_A]: rev1.snapshot.content_hash, [REGION_B]: rev1.snapshot.content_hash }),
  });
  const job = await world.svc.runJob("job-full-1");
  assert.equal(job.status, "COMPLETED");
  assert.equal(job.processed, 6);

  const summary = diffSummary(world.store);
  assert.equal(summary.claims_compared, 6);
  assert.equal(summary.by_kind.CODE_MISSING, 2); // A、B 两地区各一条 L009
  assert.ok(summary.by_kind.RULE_CONFLICT >= 1);
  assert.ok(summary.by_kind.SCOPE_CHANGE >= 2); // L005 排除、L006 限量

  // 二级下钻
  const missingRows = drillDown(world.store, { kind: DIFF_KINDS.CODE_MISSING });
  assert.equal(missingRows.count, 2);
  assert.deepEqual(missingRows.rows.map((r) => r.local_code).sort(), ["L009", "L009"]);

  // 三级下钻：规则依据
  const detail = diffDetail(world.store, "clm-bbbbbb");
  const conflict = detail.diffs.find((d) => d.kind === DIFF_KINDS.RULE_CONFLICT);
  assert.equal(conflict.rule_basis[0].rule_id, "NR-003-EXCL");
  assert.match(conflict.rule_basis[0].artifact_hash, /^sha256:/);

  // 现行侧结果独立保存、未被候选影响
  const c = world.store.effectiveComparison("clm-dddddd");
  const incL006 = c.incumbent.line_results.find((l) => l.local_code === "L006");
  assert.equal(incL006.line_eligible, 50); // 5 * 10
  assert.equal(c.candidate.line_results.find((l) => l.local_code === "L006").line_eligible, 24);
});

test("同一事件重复处理只保留一条有效比较", async () => {
  const world = await worldWithClaims();
  const rev1 = await world.svc.reviseMapping(
    { region: REGION_A, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  await world.svc.reviseMapping(
    { region: REGION_B, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });

  const refs = refsWith(world, { [REGION_A]: rev1.snapshot.content_hash, [REGION_B]: rev1.snapshot.content_hash });
  await world.svc.startReplayJob({ jobId: "j1", exerciseId: "ex", shardCount: 2, refs });
  await world.svc.runJob("j1");
  // 再跑一个覆盖同样集合的作业：全部应跳过，不产生新比较事件
  await world.svc.startReplayJob({ jobId: "j2", exerciseId: "ex", shardCount: 2, refs });
  const job2 = await world.svc.runJob("j2");
  assert.equal(job2.skipped, 6);
  assert.equal(job2.processed, 0);
  const comparisons = world.store.events().filter((e) => e.kind === "COMPARISON_PRODUCED");
  assert.equal(comparisons.length, 6);
  for (const id of world.store.state.claims.keys()) {
    assert.ok(world.store.effectiveComparison(id));
  }
});

test("分片作业可暂停、恢复，游标续跑且跨进程重建状态", async () => {
  const world = await worldWithClaims();
  const rev1 = await world.svc.reviseMapping(
    { region: REGION_A, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  await world.svc.reviseMapping(
    { region: REGION_B, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  const refs = refsWith(world, { [REGION_A]: rev1.snapshot.content_hash, [REGION_B]: rev1.snapshot.content_hash });

  await world.svc.startReplayJob({ jobId: "jp", exerciseId: "ex", shardCount: 2, refs });
  let processedOnce = false;
  const paused = await world.svc.runJob("jp", {
    onProcess: async () => {
      if (!processedOnce) {
        processedOnce = true;
        await world.svc.pause("jp");
      }
    },
  });
  assert.equal(paused.status, "PAUSED");
  const processedSoFar = world.store.events().filter((e) => e.kind === "COMPARISON_PRODUCED").length;
  assert.ok(processedSoFar >= 1 && processedSoFar < 6);

  // 模拟进程重启：从日志重建 store/registry/service 后续跑
  const reopened = ShadowEventStore.open(world.boundary, join(world.root, "shadow-events.log"));
  const registry2 = reopened.rebuildRegistry();
  const svc2 = new ShadowSettlementService(reopened, registry2);
  await svc2.resume("jp");
  const done = await svc2.runJob("jp");
  assert.equal(done.status, "COMPLETED");
  assert.equal(reopened.state.comparisons.size, 6);
  assert.equal(done.processed, 6);
});

test("专家补充映射后仅重算真正受影响集合，旧比较被显式取代", async () => {
  const world = await worldWithClaims();
  const rev1 = await world.svc.reviseMapping(
    { region: REGION_A, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  await world.svc.reviseMapping(
    { region: REGION_B, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  const refs1 = refsWith(world, { [REGION_A]: rev1.snapshot.content_hash, [REGION_B]: rev1.snapshot.content_hash });
  await world.svc.startReplayJob({ jobId: "full", exerciseId: "round-1", shardCount: 3, refs: refs1 });
  await world.svc.runJob("full");

  // 专家补充 L009 映射（修订2）
  const rev2 = await world.svc.reviseMapping(
    { region: REGION_A, revision: 2, content: mappingRevision2(), supersedes_revision: 1 });
  assert.deepEqual(rev2.affected_claim_ids, ["clm-aaaaaa"]); // 只有含 L009 的 A 地区事件

  const refs2 = refsWith(world, { [REGION_A]: rev2.snapshot.content_hash, [REGION_B]: rev1.snapshot.content_hash });
  await world.svc.startIncrementalReplay({
    jobId: "incr-1", exerciseId: "round-2", refs: refs2, region: REGION_A,
  });
  const incr = await world.svc.runJob("incr-1");
  assert.equal(incr.processed, 1);

  // 该事件新比较取代旧比较，但事件日志保留两条历史（可追溯）
  const history = world.store.events().filter(
    (e) => e.kind === "COMPARISON_PRODUCED" && e.payload.claim_id === "clm-aaaaaa");
  assert.equal(history.length, 2);
  const effective = world.store.effectiveComparison("clm-aaaaaa");
  assert.equal(effective.event_id, history[1].event_id);
  assert.equal(effective.supersedes_event_id, history[0].event_id);
  assert.equal(effective.deps.mapping, rev2.snapshot.content_hash);
  assert.deepEqual(effective.diffs.map((d) => d.kind), []); // L009 补齐后无差异

  // 未受影响事件仍引用修订1，但不被新鲜度门槛视为过期（结转）
  const untouched = world.store.effectiveComparison("clm-bbbbbb");
  assert.equal(untouched.deps.mapping, rev1.snapshot.content_hash);
});

test("地区汇总可按地区过滤", async () => {
  const world = await worldWithClaims();
  const rev1 = await world.svc.reviseMapping(
    { region: REGION_A, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  await world.svc.reviseMapping(
    { region: REGION_B, revision: 1, content: mappingRevision1(), supersedes_revision: 0 });
  const refs = refsWith(world, { [REGION_A]: rev1.snapshot.content_hash, [REGION_B]: rev1.snapshot.content_hash });
  await world.svc.startReplayJob({ jobId: "j", exerciseId: "ex", shardCount: 2, refs });
  await world.svc.runJob("j");
  const aOnly = diffSummary(world.store, { region: REGION_A });
  assert.equal(aOnly.claims_compared, 5);
  assert.equal(aOnly.by_kind.CODE_MISSING, 1);
});

void approvedBoundary;
