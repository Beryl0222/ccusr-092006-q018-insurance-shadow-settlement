// 影子结算端到端演练演示（全部数据虚构）：
//   node examples/demo.mjs
//
// 展示：冻结 → 脱敏接入 → 分片重放（暂停/恢复）→ 差异下钻 →
//       专家补充映射后增量重算 → 抽样复核与地区签署 → 发布资格判定 → 合规导出。

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentBoundary, SINKS, redactForExport } from "../src/environment.js";
import { FreezeRegistry } from "../src/freeze.js";
import { ShadowEventStore } from "../src/store.js";
import { ShadowSettlementService } from "../src/service.js";
import { diffSummary, drillDown, diffDetail } from "../src/diffs.js";
import { ReleaseGatekeeper } from "../src/release.js";
import {
  REGIONS, REGION_A, REGION_B, NATIONAL,
  incumbentCatalog, incumbentRestriction, incumbentRates,
  candidateCatalog, candidateRestriction, candidateRates,
  mappingRevision1, mappingRevision2, historicalClaims,
} from "./fixtures.js";

const log = (title, body) => {
  console.log(`\n=== ${title} ===`);
  if (body !== undefined) console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
};

const root = mkdtempSync(join(tmpdir(), "shadow-demo-"));
const boundary = new EnvironmentBoundary({
  envId: "env-shadow-approved",
  approvedEnvIds: ["env-shadow-approved"],
  allowedRoots: [root],
});
const registry = new FreezeRegistry();
const store = ShadowEventStore.open(boundary, join(root, "shadow-events.log"));
const svc = new ShadowSettlementService(store, registry);

// 1. 冻结 ------------------------------------------------------------------
for (const region of REGIONS) {
  for (const [type, ctor, verPrefix] of [
    ["CATALOG", incumbentCatalog, "local-cat"],
    ["RESTRICTION", incumbentRestriction, "local-res"],
    ["RATE_TABLE", incumbentRates, "local-rate"],
  ]) {
    await svc.freeze({
      artifact_type: type, side: "INCUMBENT", region, version: `${verPrefix}-2025-${region}`,
      content: ctor(region), frozen_at: "2025-01-01T00:00:00+08:00",
      effective_from: "2025-01-01T00:00:00+08:00",
    });
  }
}
const candCatalog = await svc.freeze({
  artifact_type: "CATALOG", side: "CANDIDATE", region: NATIONAL, version: "national-v1",
  content: candidateCatalog(), frozen_at: "2026-08-01T00:00:00+08:00", effective_from: "2026-08-01T00:00:00+08:00",
});
const candRestriction = await svc.freeze({
  artifact_type: "RESTRICTION", side: "CANDIDATE", region: NATIONAL, version: "national-res-v1",
  content: candidateRestriction(), frozen_at: "2026-08-01T00:00:00+08:00", effective_from: "2026-08-01T00:00:00+08:00",
});
const candRate = await svc.freeze({
  artifact_type: "RATE_TABLE", side: "CANDIDATE", region: NATIONAL, version: "national-rate-v1",
  content: candidateRates(), frozen_at: "2026-08-01T00:00:00+08:00", effective_from: "2026-08-01T00:00:00+08:00",
});
log("1. 冻结完成", { shadowRoot: root, candidateCatalog: candCatalog.content_hash });

// 2. 脱敏历史事件接入（重复进入只保留一次） --------------------------------
const claims = historicalClaims();
for (const claim of claims) await svc.ingestClaim(claim);
const dup = await svc.ingestClaim(claims[0]);
log("2. 历史事件接入", { ingested: store.state.claims.size, duplicateDeduped: dup.deduped });

// 3. 第一轮地区映射（L009 缺失）并全量分片重放，演示暂停/恢复 --------------
const rev1A = (await svc.reviseMapping({ region: REGION_A, revision: 1, content: mappingRevision1(), supersedes_revision: 0 })).snapshot;
const rev1B = (await svc.reviseMapping({ region: REGION_B, revision: 1, content: mappingRevision1(), supersedes_revision: 0 })).snapshot;
const refs1 = {
  incumbent: { region: "AUTO" },
  candidate: {
    region: "AUTO", catalog: candCatalog.content_hash, restriction: candRestriction.content_hash,
    rate: candRate.content_hash, mapping: { [REGION_A]: rev1A.content_hash, [REGION_B]: rev1B.content_hash },
  },
};
await svc.startReplayJob({ jobId: "round1-full", exerciseId: "exercise-2026Q4", shardCount: 3, refs: refs1 });
let pausedOnce = false;
const paused = await svc.runJob("round1-full", {
  onProcess: async (job) => {
    if (!pausedOnce && job.processed === 2) {
      pausedOnce = true;
      await svc.pause("round1-full");
    }
  },
});
log("3a. 处理两条后暂停", { status: paused.status, cursors: paused.cursors });
await svc.resume("round1-full");
const finished = await svc.runJob("round1-full");
log("3b. 恢复后完成", { status: finished.status, processed: finished.processed, skipped: finished.skipped });

// 4. 差异三级下钻 -----------------------------------------------------------
log("4a. 差异汇总（第一轮）", diffSummary(store));
log("4b. 编码缺失下钻", drillDown(store, { kind: "CODE_MISSING" }).rows);
log("4c. 组合规则冲突的规则依据",
  diffDetail(store, "clm-bbbbbb").diffs
    .filter((d) => d.kind === "RULE_CONFLICT")
    .map((d) => ({ line: d.line_id, message: d.message, rule_basis: d.rule_basis })));

// 5. 专家补充 L009 映射 → 只重算受影响集合 ---------------------------------
const rev2A = (await svc.reviseMapping({ region: REGION_A, revision: 2, content: mappingRevision2(), supersedes_revision: 1 })).snapshot;
const rev2B = (await svc.reviseMapping({ region: REGION_B, revision: 2, content: mappingRevision2(), supersedes_revision: 1 })).snapshot;
const refs2 = {
  incumbent: { region: "AUTO" },
  candidate: {
    region: "AUTO", catalog: candCatalog.content_hash, restriction: candRestriction.content_hash,
    rate: candRate.content_hash, mapping: { [REGION_A]: rev2A.content_hash, [REGION_B]: rev2B.content_hash },
  },
};
await svc.startIncrementalReplay({ jobId: "round2-incr-a", exerciseId: "exercise-2026Q4", refs: refs2, region: REGION_A });
await svc.runJob("round2-incr-a");
await svc.startIncrementalReplay({ jobId: "round2-incr-b", exerciseId: "exercise-2026Q4", refs: refs2, region: REGION_B });
const incr = await svc.runJob("round2-incr-b");
log("5. 增量重算（两地区各仅重算含 L009 的事件）", { reprocessedLastJob: incr.processed });
log("   第二轮汇总（编码缺失归零）", diffSummary(store));

// 6. 抽样复核 + 地区签署 + 发布资格 ----------------------------------------
const gate = new ReleaseGatekeeper(store);
const batch = await gate.drawSample({
  batchId: "smp-final", catalogVersion: candCatalog.content_hash,
  fraction: 1, seed: "audit-2026Q4", region: REGION_A,
});
for (const [i, claimId] of batch.members.entries()) {
  await gate.recordRecheck({
    batchId: "smp-final", claimId,
    reviewerToken: `rv-${(i + 0x100000).toString(16)}`, verdict: "MATCH",
  });
}
const first = await gate.evaluate({
  catalogVersion: candCatalog.content_hash, batchId: "smp-final",
  requiredRegions: [REGION_A, REGION_B], minSampleFraction: 1, minConsistency: 0.95,
});
log("6a. 签署前判定", { decision: first.decision, gates: first.gate_results.map((g) => `${g.name}=${g.passed}`) });
await gate.signRegion({ region: REGION_A, catalogVersion: candCatalog.content_hash, signerToken: "sg-aaaaaa" });
await gate.signRegion({ region: REGION_B, catalogVersion: candCatalog.content_hash, signerToken: "sg-bbbbbb" });
const second = await gate.evaluate({
  catalogVersion: candCatalog.content_hash, batchId: "smp-final",
  requiredRegions: [REGION_A, REGION_B], minSampleFraction: 1, minConsistency: 0.95,
});
log("6b. 签署后判定（只判定，不发布）", { decision: second.decision, gates: second.gate_results.map((g) => `${g.name}=${g.passed}`) });

// 7. 合规导出与边界拒绝 -----------------------------------------------------
const pack = diffDetail(store, "clm-aaaaaa");
const [safe] = redactForExport([pack], { pepper: "pepper-stays-inside-approved-env" });
log("7a. 对外复核包（患者标识假名化、费率剥离）", {
  patient_ref: safe.claim_snapshot.patient_ref,
  hasPatientToken: "patient_token" in safe.claim_snapshot,
  candidateLine: safe.candidate.line_results[0],
});
try {
  boundary.assertSink(SINKS.PRODUCTION_SETTLEMENT);
} catch (err) {
  log("7b. 影子数据误入真实结算被拒", err.message);
}

console.log("\n演练完成。影子事件日志:", join(root, "shadow-events.log"));
