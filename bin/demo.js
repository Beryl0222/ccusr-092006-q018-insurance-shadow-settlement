#!/usr/bin/env node
// 影子结算端到端演练演示（全部数据为虚构脱敏数据，数据落在 ./.shadow-demo 内）。
//
//   node bin/demo.js
//
// 演示覆盖：冻结 -> 分片重放（含暂停/恢复）-> 汇总下钻 -> 专家补充映射 ->
//           仅重算受影响集合 -> 抽样复核 -> 地区签署 -> 发布资格。
// 该脚本不连接任何真实系统。

import { rmSync } from "node:fs";
import { Ledger } from "../src/store/ledger.js";
import { ShadowService } from "../src/service/ShadowService.js";

const HOME = new URL("../.shadow-demo/", import.meta.url).pathname;
rmSync(HOME, { recursive: true, force: true });

const svc = new ShadowService(new Ledger(HOME).ensure());
const line = (s) => console.log(`\n=== ${s} ===`);

// 1) 脱敏历史结算事件进入获准环境（pseudo_ 伪标识）
line("1. 摄入脱敏历史事件");
svc.ingestHistory([
  {
    event_ref: "2026-h-1001", subject_ref: "pseudo_8f3a91", region: "CN-DEMO",
    service_date: "2026-03-12T09:20:00+08:00", facility_level: "t3",
    lines: [
      { line_ref: "01", local_code: "LOC-A01", quantity: 5, charged_amount: 250 },
      { line_ref: "02", local_code: "LOC-B07", quantity: 1, charged_amount: 50 },
      { line_ref: "03", local_code: "LOC-C99", quantity: 1, charged_amount: 80 }, // 暂无国家映射
    ],
  },
  {
    event_ref: "2026-h-1002", subject_ref: "pseudo_2c77d0", region: "CN-DEMO",
    service_date: "2026-08-05T14:00:00+08:00", facility_level: "t2",
    lines: [
      { line_ref: "01", local_code: "LOC-A01", quantity: 2, charged_amount: 100 },
      { line_ref: "02", local_code: "LOC-D12", quantity: 1, charged_amount: 60 },
    ],
  },
]);
console.log(`已入库历史事件：${svc.listHistory().length} 条`);

// 2) 冻结候选基线：国家目录 + 本地旧目录 + 地区映射 + 支付限制 + 样例费率
line("2. 冻结候选基线快照");
const { snapshot: base } = svc.freezeCatalog({
  region: "CN-DEMO",
  national_catalog: {
    version: "NAT-2026-FIRST-BATCH", effective_from: "2026-01-01",
    items: [{ code: "NAT-1001" }, { code: "NAT-2007" }, { code: "NAT-3012" }, { code: "NAT-4100" }],
  },
  local_catalog: {
    version: "LOCAL-LEGACY", effective_from: "2020-01-01",
    items: [{ code: "LOC-A01" }, { code: "LOC-B07" }, { code: "LOC-C99" }, { code: "LOC-D12" }],
  },
  mappings: [
    { local_code: "LOC-A01", national_code: "NAT-1001", basis: "地区标准映射" },
    { local_code: "LOC-B07", national_code: "NAT-2007", basis: "地区标准映射" },
    { local_code: "LOC-D12", national_code: "NAT-3012", basis: "地区标准映射" },
  ],
  restrictions: [
    { id: "scope-2007-out", track: "candidate", rule_type: "scope", codes: ["NAT-2007"], scope: "excluded", basis: "NAT-2007 并入综合项目，不再单列支付" },
    { id: "cap-1001", track: "candidate", rule_type: "max_quantity", codes: ["NAT-1001"], max_quantity: 3, basis: "NAT-1001 每次最多3单位" },
    { id: "mutex-3012-4100", track: "candidate", rule_type: "mutually_exclusive", codes: ["NAT-3012", "NAT-4100"], basis: "NAT-3012/NAT-4100 同次互斥" },
  ],
  sample_rates: [
    { track: "current", code: "LOC-A01", facility_level: "*", rate: 50, basis: "本地旧项目 A01 费率" },
    { track: "current", code: "LOC-B07", facility_level: "*", rate: 50, basis: "本地旧项目 B07 费率" },
    { track: "current", code: "LOC-D12", facility_level: "*", rate: 60, basis: "本地旧项目 D12 费率" },
    { track: "candidate", code: "NAT-1001", facility_level: "*", rate: 40, basis: "国家 1001 样例费率" },
    { track: "candidate", code: "NAT-3012", facility_level: "*", rate: 60, basis: "国家 3012 样例费率" },
  ],
});
console.log(`快照：${base.snapshot_id}（revision=${base.revision}，内容哈希 ${base.content_hash.slice(0, 16)}…）`);

// 3) 分片重放（3 分片），演示暂停/恢复
line("3. 分片重放（暂停后恢复）");
const { job } = svc.createJob({ snapshot_id: base.snapshot_id, mode: "FULL", shard_count: 3, request_id: "drill-r1" });
svc.leaseShard(job.job_id, { owner: "worker-a", shard: 0, lease_ms: 3_600_000 });
svc.pauseJob(job.job_id);
const stopped = svc.runShard(job.job_id, 0, { owner: "worker-a", max_items: 10 });
console.log(`暂停状态下领取分片后执行 -> stop_reason=${stopped.stop_reason}`);
svc.resumeJob(job.job_id);
for (let i = 0; i < 3; i++) {
  svc.leaseShard(job.job_id, { owner: "worker-a", shard: i, lease_ms: 3_600_000 });
  const r = svc.runShard(job.job_id, i, { owner: "worker-a", max_items: 100 });
  console.log(`分片 ${i}: 处理 ${r.processed} 条，结果=${r.stop_reason}`);
}
console.log(`作业状态：${svc.getJob(job.job_id).status}`);

// 4) 汇总与下钻
line("4. 差异汇总与规则依据下钻");
const summary = svc.diffSummary(base.snapshot_id);
console.log("分类计数：", summary.categories);
console.log(`现行合计 ${summary.current_total} / 候选合计 ${summary.candidate_total} / 差额 ${summary.total_delta}`);
const drill = svc.diffDrill(base.snapshot_id, "CODE_MISSING");
for (const row of drill.rows) {
  console.log(`- 缺失：${row.event_ref} / ${row.line_ref}（本地编码 ${row.local_code}）`);
}
const basis = svc.ruleBasis(base.snapshot_id, "2026-h-1001", "01");
console.log("h-1001/01 分类：", basis.category);
for (const r of basis.classification_basis) console.log("  依据：", r.basis ?? r.rule?.basis ?? r.reason);

// 5) 专家补充映射 -> 仅重算受影响集合
line("5. 专家补充映射，增量重算");
const revised = svc.reviseMappings(base.snapshot_id, {
  add: [{ local_code: "LOC-C99", national_code: "NAT-1001", basis: "专家会商补充：LOC-C99 等价 NAT-1001" }],
  note: "补齐 C99 映射",
}, { by: "expert-zhou" });
console.log(`子快照：${revised.snapshot.snapshot_id}，受影响本地编码：${revised.changed_local_codes}`);
console.log(`受影响事件：${revised.affected_event_refs.join(", ")}（另一条事件沿用父快照结论，不重算）`);
const inc = svc.createJob({ snapshot_id: revised.snapshot.snapshot_id, mode: "INCREMENTAL", shard_count: 1, request_id: "drill-inc1" });
svc.leaseShard(inc.job.job_id, { owner: "worker-b", shard: 0, lease_ms: 3_600_000 });
svc.runShard(inc.job.job_id, 0, { owner: "worker-b" });
console.log("增量后子快照视角：", svc.diffSummary(revised.snapshot.snapshot_id).categories);

// 6) 抽样复核 -> 地区签署 -> 发布资格
line("6. 抽样复核与签署门槛");
const { plan } = svc.createReviewPlan(revised.snapshot.snapshot_id, { seed: "demo-seed" });
console.log(`抽样计划 ${plan.plan_id}：${plan.items.length} 个样本项（高风险类别全量）`);
for (const item of plan.items) {
  svc.recordReview(plan.plan_id, item.item_id, { verdict: "AGREE", by: "reviewer-chen", note: "分类与依据正确" });
}
const gate = svc.reviewGate(plan.plan_id);
console.log(`复核门槛：${gate.meets ? "通过" : "未通过"}（分歧率 ${gate.disagreement_rate}）`);
const sig = svc.signRegion({ region: "CN-DEMO", snapshot_id: revised.snapshot.snapshot_id, signer: "bureau-yang" });
console.log(`地区签署：${sig.signature.region} @ ${sig.signature.content_hash.slice(0, 12)}…`);

const campaign = svc.createReleaseCampaign({
  name: "首批国家目录演练",
  members: [{ snapshot_id: revised.snapshot.snapshot_id }],
}).campaign;
const certificate = svc.issueRelease(campaign).certificate;
console.log(`发布资格证书：${certificate.release_id}`);
console.log(`证书效力范围：${certificate.scope}（仅获准环境内，不向真实结算下发任何内容）`);
