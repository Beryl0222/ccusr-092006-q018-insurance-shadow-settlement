import assert from "node:assert/strict";
import test from "node:test";
import { makeService, standardSnapshotInput, historyEvent, runFullReplay, drainJob } from "./helpers/fixtures.js";
import { ConflictError, EnclaveViolation, GateError, NotFoundError } from "../src/domain/errors.js";

function seed(service, events = [historyEvent()], overrides = {}) {
  service.ingestHistory(events);
  const { snapshot } = service.freezeCatalog(standardSnapshotInput(overrides));
  return snapshot;
}

test("摄入：重复事件只保留一次；同号异内容拒绝", () => {
  const t = makeService();
  const e = historyEvent();
  const first = t.service.ingestHistory([e]);
  assert.deepEqual(first.ingested, ["h-1"]);
  const again = t.service.ingestHistory([e]);
  assert.deepEqual(again.duplicates, ["h-1"]);
  assert.equal(t.service.listHistory().length, 1);
  assert.throws(
    () => t.service.ingestHistory([historyEvent({ lines: [{ line_ref: "x", local_code: "L99", quantity: 1, charged_amount: 1 }] })]),
    ConflictError,
  );
  t.cleanup();
});

test("摄入：未脱敏数据进不了获准环境", () => {
  const t = makeService();
  assert.throws(() => t.service.ingestHistory([historyEvent({ subject_ref: "110101199001011234" })]), EnclaveViolation);
  assert.throws(() => t.service.ingestHistory([historyEvent({ patient_name: "张三" })]), EnclaveViolation);
  t.cleanup();
});

test("全量重放：分片完成后作业 COMPLETED，现行/候选结果分别保存", () => {
  const t = makeService();
  const snap = seed(t.service, [
    historyEvent({ event_ref: "h1", lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }] }),
    historyEvent({ event_ref: "h2", lines: [{ line_ref: "a", local_code: "L05", quantity: 1, charged_amount: 10 }] }),
  ]);
  const job = runFullReplay(t.service, snap.snapshot_id, { shardCount: 3 });
  assert.equal(job.status, "COMPLETED");
  assert.equal(job.total, 2);
  const c1 = t.service.resolveComparison(snap.snapshot_id, "h1").comparison;
  assert.ok(c1.current_result);
  assert.ok(c1.candidate_result);
  assert.notEqual(c1.current_total, undefined);
  const summary = t.service.diffSummary(snap.snapshot_id);
  assert.equal(summary.categories.CODE_MISSING, 1);
  assert.equal(summary.lines, 2);
  t.cleanup();
});

test("幂等：同一事件重复进入只保留一次有效比较（跨作业/跨重启）", () => {
  const t = makeService();
  const snap = seed(t.service);
  // 相同 request_id 重试 -> 复用同一作业
  const j1 = runFullReplay(t.service, snap.snapshot_id, { requestId: "req-1" });
  const j1retry = runFullReplay(t.service, snap.snapshot_id, { requestId: "req-1" });
  assert.equal(j1retry.job_id, j1.job_id);
  // 不同 request_id -> 独立作业，但比较记录按 (快照,事件) 去重
  const j2 = runFullReplay(t.service, snap.snapshot_id, { requestId: "req-2" });
  assert.notEqual(j2.job_id, j1.job_id);
  assert.equal(j2.status, "COMPLETED");
  const restarted = t.restart();
  const j3 = runFullReplay(restarted, snap.snapshot_id, { requestId: "req-3" });
  assert.equal(j3.total, 1);
  const only = restarted.resolveComparison(snap.snapshot_id, "h-1").comparison;
  assert.equal(only.event_ref, "h-1");
  t.cleanup();
});

test("暂停/恢复：暂停中的作业拒绝领片，恢复后续跑完成", () => {
  const t = makeService();
  const events = Array.from({ length: 25 }, (_, i) =>
    historyEvent({ event_ref: `h${i}`, lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }] }));
  const snap = seed(t.service, events);
  const { job } = t.service.createJob({ snapshot_id: snap.snapshot_id, shard_count: 1 });
  t.service.leaseShard(job.job_id, { owner: "w", shard: 0, lease_ms: 3_600_000 });
  t.service.pauseJob(job.job_id);
  const stopped = t.service.runShard(job.job_id, 0, { owner: "w", max_items: 50 });
  assert.equal(stopped.stop_reason, "PAUSED");
  assert.equal(stopped.cursor, 0);
  assert.throws(() => t.service.leaseShard(job.job_id, { owner: "w2", shard: 0 }), ConflictError);
  t.service.resumeJob(job.job_id);
  t.clock.advance(1000);
  const ran = t.service.runShard(job.job_id, 0, { owner: "w", max_items: 50 });
  assert.equal(ran.stop_reason, "COMPLETED");
  assert.equal(ran.cursor, 25);
  assert.equal(t.service.getJob(job.job_id).status, "COMPLETED");
  t.cleanup();
});

test("checkpoint：时间预算用尽时保存游标，下次从断点继续且不重复计数", () => {
  const t = makeService();
  const events = Array.from({ length: 25 }, (_, i) =>
    historyEvent({ event_ref: `h${i}`, lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }] }));
  const snap = seed(t.service, events);
  const { job } = t.service.createJob({ snapshot_id: snap.snapshot_id, shard_count: 1 });
  t.service.leaseShard(job.job_id, { owner: "w", shard: 0, lease_ms: 3_600_000 });
  // 极小条目预算 + 极大时间预算，靠 max_items 切出多轮
  const r1 = t.service.runShard(job.job_id, 0, { owner: "w", max_items: 10 });
  assert.equal(r1.processed, 10);
  const r2 = t.service.runShard(job.job_id, 0, { owner: "w", max_items: 10 });
  assert.equal(r2.processed, 10);
  const r3 = t.service.runShard(job.job_id, 0, { owner: "w", max_items: 10 });
  assert.equal(r3.processed, 5);
  assert.equal(r3.stop_reason, "COMPLETED");
  t.cleanup();
});

test("租约：过期后可被其他工作者接管；有效期内不可抢占", () => {
  const t = makeService();
  const snap = seed(t.service, Array.from({ length: 5 }, (_, i) =>
    historyEvent({ event_ref: `h${i}` })));
  const { job } = t.service.createJob({ snapshot_id: snap.snapshot_id, shard_count: 1 });
  t.service.leaseShard(job.job_id, { owner: "w1", shard: 0, lease_ms: 1000 });
  assert.throws(() => t.service.leaseShard(job.job_id, { owner: "w2", shard: 0 }), ConflictError);
  t.clock.advance(1001);
  assert.doesNotThrow(() => t.service.leaseShard(job.job_id, { owner: "w2", shard: 0 }));
  t.cleanup();
});

test("租约栅栏：分片易主后旧持有者再跑被拒，不会重复/越权写入", () => {
  const t = makeService();
  const snap = seed(t.service, Array.from({ length: 8 }, (_, i) =>
    historyEvent({ event_ref: `h${i}` })));
  const { job } = t.service.createJob({ snapshot_id: snap.snapshot_id, shard_count: 1 });
  t.service.leaseShard(job.job_id, { owner: "w1", shard: 0, lease_ms: 1000 });
  const r1 = t.service.runShard(job.job_id, 0, { owner: "w1", max_items: 3 });
  assert.equal(r1.cursor, 3);
  // 租约过期，w2 接管 -> 纪元 +1
  t.clock.advance(1001);
  t.service.leaseShard(job.job_id, { owner: "w2", shard: 0, lease_ms: 1000 });
  // w1 若误以为自己仍持有租约继续跑：同步栅栏因 owner 不匹配直接拒绝
  assert.throws(() => t.service.runShard(job.job_id, 0, { owner: "w1", max_items: 3 }), ConflictError);
  // 游标未被 w1 推进，w2 从断点继续
  const r2 = t.service.runShard(job.job_id, 0, { owner: "w2", max_items: 100 });
  assert.equal(r2.cursor, 8);
  assert.equal(r2.stop_reason, "COMPLETED");
  t.cleanup();
});

test("重启恢复：新进程从账本重放，接着完成作业", () => {
  const t = makeService();
  const snap = seed(t.service, Array.from({ length: 12 }, (_, i) =>
    historyEvent({ event_ref: `h${i}` })));
  const { job } = t.service.createJob({ snapshot_id: snap.snapshot_id, shard_count: 2 });
  t.service.leaseShard(job.job_id, { owner: "w", shard: 0, lease_ms: 3_600_000 });
  t.service.runShard(job.job_id, 0, { owner: "w", max_items: 3 });
  const restarted = t.restart();
  const view = restarted.getJob(job.job_id);
  assert.equal(view.shards[0].cursor, 3);
  assert.equal(view.status, "PENDING");
  restarted.leaseShard(job.job_id, { owner: "w", shard: 0, lease_ms: 3_600_000 });
  restarted.runShard(job.job_id, 0, { owner: "w", max_items: 100 });
  restarted.leaseShard(job.job_id, { owner: "w", shard: 1, lease_ms: 3_600_000 });
  restarted.runShard(job.job_id, 1, { owner: "w", max_items: 100 });
  assert.equal(restarted.getJob(job.job_id).status, "COMPLETED");
  t.cleanup();
});

test("增量重算：专家补充映射后只重算受影响集合，其余沿修订链继承", () => {
  const t = makeService();
  const snap = seed(t.service, [
    historyEvent({ event_ref: "affected", lines: [{ line_ref: "a", local_code: "L05", quantity: 1, charged_amount: 10 }] }),
    historyEvent({ event_ref: "untouched", lines: [{ line_ref: "a", local_code: "L01", quantity: 1, charged_amount: 50 }] }),
  ]);
  runFullReplay(t.service, snap.snapshot_id);
  const before = t.service.resolveComparison(snap.snapshot_id, "affected").comparison;
  assert.equal(before.diffs[0].category, "CODE_MISSING");

  const rev = t.service.reviseMappings(snap.snapshot_id, {
    add: [{ local_code: "L05", national_code: "N01", basis: "专家补充" }],
  });
  assert.deepEqual(rev.changed_local_codes, ["L05"]);
  assert.deepEqual(rev.affected_event_refs, ["affected"]);

  const inc = t.service.createJob({ snapshot_id: rev.snapshot.snapshot_id, mode: "INCREMENTAL", shard_count: 1 });
  assert.deepEqual(inc.job.shards[0].refs, ["affected"]);
  drainJob(t.service, inc.job);

  // 受影响事件在子快照上重新求值
  const after = t.service.resolveComparison(rev.snapshot.snapshot_id, "affected");
  assert.equal(after.source_snapshot_id, rev.snapshot.snapshot_id);
  assert.notEqual(after.comparison.diffs[0].category, "CODE_MISSING");
  // 未受影响事件沿用父快照结论
  const inherited = t.service.resolveComparison(rev.snapshot.snapshot_id, "untouched");
  assert.equal(inherited.source_snapshot_id, snap.snapshot_id);

  // 不能对基线快照建增量作业
  assert.throws(() => t.service.createJob({ snapshot_id: snap.snapshot_id, mode: "INCREMENTAL" }), /INCREMENTAL/);
  // 无实质变化的修订被拒绝（避免产生内容哈希相同、修订链不同的非法快照）
  assert.throws(
    () => t.service.reviseMappings(snap.snapshot_id, { add: [{ local_code: "L01", national_code: "N01" }] }),
    /没有产生任何变化/,
  );
  t.cleanup();
});

test("下钻：汇总 -> 类别明细 -> 规则依据原文（含规则/费率/映射定义）", () => {
  const t = makeService();
  const snap = seed(t.service, [
    historyEvent({ event_ref: "h1", lines: [{ line_ref: "cap", local_code: "L01", quantity: 5, charged_amount: 250 }] }),
    historyEvent({ event_ref: "h2", lines: [{ line_ref: "miss", local_code: "L05", quantity: 1, charged_amount: 10 }] }),
  ]);
  runFullReplay(t.service, snap.snapshot_id);
  const drill = t.service.diffDrill(snap.snapshot_id, "AMOUNT_CHANGE");
  assert.equal(drill.count >= 1, true);
  const row = drill.rows.find((r) => r.event_ref === "h1");
  assert.equal(row.candidate_amount, 80);
  const basis = t.service.ruleBasis(snap.snapshot_id, "h1", "cap");
  const capRule = basis.classification_basis.find((r) => r.reason === "QUANTITY_CAPPED");
  assert.equal(capRule.rule.id, "cap-n01");
  assert.equal(capRule.rule.max_quantity, 2);
  const rateReason = basis.candidate.reasons.find((r) => r.reason === "RATE_APPLIED");
  assert.equal(rateReason.rate.rate, 40);
  assert.throws(() => t.service.ruleBasis(snap.snapshot_id, "h1", "nope"), NotFoundError);
  t.cleanup();
});
