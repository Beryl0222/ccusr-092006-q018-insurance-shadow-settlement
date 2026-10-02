import assert from "node:assert/strict";
import test from "node:test";
import { makeService, standardSnapshotInput, historyEvent, runFullReplay } from "./helpers/fixtures.js";
import { GateError, ConflictError } from "../src/domain/errors.js";

function seedScenario(service) {
  // 两条费用行：一条映射缺失（CODE_MISSING），一条金额变化（AMOUNT_CHANGE）
  service.ingestHistory([
    historyEvent({
      event_ref: "h1",
      lines: [
        { line_ref: "miss", local_code: "L05", quantity: 1, charged_amount: 10 },
        { line_ref: "amt", local_code: "L01", quantity: 1, charged_amount: 50 },
      ],
    }),
  ]);
  const { snapshot } = service.freezeCatalog(standardSnapshotInput());
  runFullReplay(service, snapshot.snapshot_id);
  return snapshot;
}

test("抽样：计划确定可复现（同种子同结果），分层覆盖高风险类别", () => {
  const t = makeService();
  const snap = seedScenario(t.service);
  const a = t.service.createReviewPlan(snap.snapshot_id, { seed: "S" });
  const b = t.service.createReviewPlan(snap.snapshot_id, { seed: "S" });
  assert.equal(b.duplicate, true);
  assert.equal(b.plan.plan_id, a.plan.plan_id);
  const plan = a.plan;
  const strata = Object.groupBy(plan.items, (i) => i.category);
  // CODE_MISSING 层 100% 抽样
  assert.equal(strata.CODE_MISSING.length, 1);
  assert.ok(strata.AMOUNT_CHANGE.length >= 1);
  // 不同种子：这里两层都小，样本集合一致；换用纯 MATCH 大数据验证洗牌差异在 http 测试外省略
  t.cleanup();
});

test("门槛：未全部复核 -> 不可签署", () => {
  const t = makeService();
  const snap = seedScenario(t.service);
  const { plan } = t.service.createReviewPlan(snap.snapshot_id);
  assert.equal(t.service.reviewGate(plan.plan_id).meets, false);
  assert.throws(
    () => t.service.signRegion({ region: "R1", snapshot_id: snap.snapshot_id, signer: "gov" }),
    GateError,
  );
  t.cleanup();
});

test("门槛：全部 AGREE -> 通过并可签署；签署绑定快照内容哈希", () => {
  const t = makeService();
  const snap = seedScenario(t.service);
  const { plan } = t.service.createReviewPlan(snap.snapshot_id);
  for (const item of plan.items) {
    t.service.recordReview(plan.plan_id, item.item_id, { verdict: "AGREE", by: "rv" });
  }
  const gate = t.service.reviewGate(plan.plan_id);
  assert.equal(gate.meets, true);
  assert.equal(gate.disagreement_rate, 0);
  const sig = t.service.signRegion({ region: "R1", snapshot_id: snap.snapshot_id, signer: "gov-li" });
  assert.equal(sig.signature.content_hash, snap.content_hash);
  assert.equal(sig.duplicate, false);
  // 重复签署幂等
  assert.equal(t.service.signRegion({ region: "R1", snapshot_id: snap.snapshot_id, signer: "gov-li" }).duplicate, true);
  // 已复核结论不可改写
  assert.throws(
    () => t.service.recordReview(plan.plan_id, plan.items[0].item_id, { verdict: "DISAGREE" }),
    ConflictError,
  );
  t.cleanup();
});

test("门槛：分歧率超阈值 -> 不通过、不能签署", () => {
  const t = makeService();
  const snap = seedScenario(t.service);
  const { plan } = t.service.createReviewPlan(snap.snapshot_id, {
    strata: {
      CODE_MISSING: { rate: 1 },
      RULE_CONFLICT: { rate: 1 },
      SCOPE_CHANGE: { rate: 1 },
      AMOUNT_CHANGE: { rate: 1 },
      MATCH: { rate: 1 },
    },
  });
  const [first, ...rest] = plan.items;
  t.service.recordReview(plan.plan_id, first.item_id, { verdict: "DISAGREE" });
  for (const item of rest) t.service.recordReview(plan.plan_id, item.item_id, { verdict: "AGREE" });
  const gate = t.service.reviewGate(plan.plan_id, { max_disagreement_rate: 0.05 });
  assert.equal(gate.meets, false);
  assert.ok(gate.disagreement_rate > 0.05);
  assert.throws(() => t.service.signRegion({ region: "R1", snapshot_id: snap.snapshot_id, signer: "gov" }), GateError);
  // 放宽阈值后通过
  assert.equal(t.service.reviewGate(plan.plan_id, { max_disagreement_rate: 0.6 }).meets, true);
  t.cleanup();
});

test("发布资格：所有成员地区签署同一国家版本才发证；证书仅影子有效", () => {
  const t = makeService();
  const r1 = seedScenario(t.service);

  // R1 完成复核并签署
  let plan = t.service.createReviewPlan(r1.snapshot_id).plan;
  for (const item of plan.items) t.service.recordReview(plan.plan_id, item.item_id, { verdict: "AGREE" });
  t.service.signRegion({ region: "R1", snapshot_id: r1.snapshot_id, signer: "gov-r1" });

  // R2：同国家版本、不同地区
  t.service.ingestHistory([historyEvent({ event_ref: "r2h", region: "R2" })]);
  const r2 = t.service.freezeCatalog(standardSnapshotInput({ region: "R2" })).snapshot;
  runFullReplay(t.service, r2.snapshot_id);
  plan = t.service.createReviewPlan(r2.snapshot_id).plan;
  for (const item of plan.items) t.service.recordReview(plan.plan_id, item.item_id, { verdict: "AGREE" });

  // R2 未签署 -> 检查不合格，issue 抛门槛错误
  const pending = t.service.createReleaseCampaign({
    name: "首批",
    members: [{ snapshot_id: r1.snapshot_id }, { snapshot_id: r2.snapshot_id }],
  }).campaign;
  const eligibility = t.service.releaseEligibility(pending);
  assert.equal(eligibility.eligible, false);
  assert.deepEqual(eligibility.blockers.map((b) => b.region), ["R2"]);
  assert.throws(() => t.service.issueRelease(pending), GateError);

  t.service.signRegion({ region: "R2", snapshot_id: r2.snapshot_id, signer: "gov-r2" });
  const issued = t.service.issueRelease(pending);
  assert.equal(issued.certificate.scope, "SHADOW_RELEASE_ELIGIBILITY_ONLY");
  assert.equal(issued.certificate.national_version, "NAT-2026-1");
  assert.deepEqual(issued.certificate.evidence.map((e) => e.region).sort(), ["R1", "R2"]);
  t.cleanup();
});

test("发布活动：国家目录版本不一致或地区重复被拒", () => {
  const t = makeService();
  const r1 = seedScenario(t.service);
  const other = t.service.freezeCatalog(
    standardSnapshotInput({
      region: "R9",
      national_catalog: { version: "NAT-2026-2", effective_from: "2026-01-01", items: [{ code: "N01" }] },
      local_catalog: { version: "Lx", items: [{ code: "L01" }] },
      mappings: [{ local_code: "L01", national_code: "N01" }],
      restrictions: [],
      sample_rates: [],
    }),
  ).snapshot;
  assert.throws(
    () => t.service.createReleaseCampaign({ members: [{ snapshot_id: r1.snapshot_id }, { snapshot_id: other.snapshot_id }] }),
    /国家目录版本不一致/,
  );
  assert.throws(
    () => t.service.createReleaseCampaign({ members: [{ snapshot_id: r1.snapshot_id }, { snapshot_id: r1.snapshot_id }] }),
    /同一地区/,
  );
  t.cleanup();
});
