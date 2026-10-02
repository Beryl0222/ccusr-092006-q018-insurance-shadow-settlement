// 测试共用夹具：可控时钟、临时获准环境目录、标准快照输入构造器。
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../../src/store/ledger.js";
import { ShadowService } from "../../src/service/ShadowService.js";

export function controllableClock(startIso = "2026-09-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return {
    now: () => new Date(t),
    advance(ms) {
      t += ms;
      return new Date(t).toISOString();
    },
    set(iso) {
      t = Date.parse(iso);
    },
    millis: () => t,
  };
}

export function tempEnclave(label = "shadow-test") {
  const dir = mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return {
    dir,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function makeService({ clock } = {}) {
  const env = tempEnclave();
  const clk = clock ?? controllableClock();
  const ledger = new Ledger(env.dir).ensure();
  const service = new ShadowService(ledger, { now: clk.now });
  return {
    service,
    ledger,
    dir: env.dir,
    clock: clk,
    restart() {
      const fresh = new ShadowService(new Ledger(env.dir).ensure(), { now: clk.now });
      return fresh;
    },
    cleanup: env.cleanup,
  };
}

export function historyEvent(overrides = {}) {
  return {
    event_ref: "h-1",
    subject_ref: "pseudo_ab12cd",
    region: "R1",
    service_date: "2026-03-01T10:00:00.000Z",
    facility_level: "t3",
    lines: [{ line_ref: "l1", local_code: "L01", quantity: 1, charged_amount: 10 }],
    ...overrides,
  };
}

// 内容丰富的标准快照：覆盖 映射/范围/互斥/限量/费率 各路径。
export function standardSnapshotInput(overrides = {}) {
  return {
    region: "R1",
    national_catalog: {
      version: "NAT-2026-1",
      effective_from: "2026-01-01",
      items: [
        { code: "N01", name: "国家项目01" },
        { code: "N02", name: "国家项目02" },
        { code: "N03", name: "国家项目03" },
        { code: "N04", name: "国家项目04" },
      ],
    },
    local_catalog: {
      version: "LOC-2020",
      effective_from: "2020-01-01",
      items: [
        { code: "L01", name: "本地01" },
        { code: "L02", name: "本地02" },
        { code: "L03", name: "本地03" },
        { code: "L04", name: "本地04" },
        { code: "L05", name: "本地05-无映射" },
      ],
    },
    mappings: [
      { mapping_id: "m01", local_code: "L01", national_code: "N01", basis: "标准映射" },
      { mapping_id: "m02", local_code: "L02", national_code: "N02", basis: "标准映射" },
      { mapping_id: "m03", local_code: "L03", national_code: "N03", basis: "标准映射" },
      { mapping_id: "m04", local_code: "L04", national_code: "N04", basis: "标准映射" },
    ],
    restrictions: [
      { id: "scope-n02-out", track: "candidate", rule_type: "scope", codes: ["N02"], scope: "excluded", basis: "N02 调整为不予支付" },
      { id: "mutex-n03-n04", track: "candidate", rule_type: "mutually_exclusive", codes: ["N03", "N04"], basis: "N03/N04 同次就医互斥" },
      { id: "cap-n01", track: "candidate", rule_type: "max_quantity", codes: ["N01"], max_quantity: 2, basis: "N01 每单不超过2单位" },
    ],
    sample_rates: [
      { id: "rate-l01", track: "current", code: "L01", facility_level: "t3", rate: 50, basis: "本地 L01 三级机构费率" },
      { id: "rate-l02", track: "current", code: "L02", facility_level: "t3", rate: 50, basis: "本地 L02 费率" },
      { id: "rate-l03", track: "current", code: "L03", facility_level: "t3", rate: 50, basis: "本地 L03 费率" },
      { id: "rate-l04", track: "current", code: "L04", facility_level: "t3", rate: 50, basis: "本地 L04 费率" },
      { id: "rate-n01", track: "candidate", code: "N01", facility_level: "t3", rate: 40, basis: "国家 N01 三级机构样例费率" },
      { id: "rate-n03", track: "candidate", code: "N03", facility_level: "t3", rate: 60, basis: "国家 N03 费率" },
      { id: "rate-n04", track: "candidate", code: "N04", facility_level: "t3", rate: 60, basis: "国家 N04 费率" },
    ],
    ...overrides,
  };
}

// 跑完一个快照的重放作业（单分片、注入时钟可控）。
// requestId 相同的重试会复用同一作业；显式重跑请换 requestId。
export function runFullReplay(service, snapshotId, { shardCount = 1, requestId = "default", mode = "FULL" } = {}) {
  const { job } = service.createJob({
    snapshot_id: snapshotId,
    mode,
    shard_count: shardCount,
    request_id: requestId,
  });
  if (job.status === "COMPLETED") return service.getJob(job.job_id);
  for (let i = 0; i < shardCount; i++) {
    service.leaseShard(job.job_id, { owner: "test-worker", shard: i, lease_ms: 3_600_000 });
    service.runShard(job.job_id, i, { owner: "test-worker", max_items: 10_000, time_budget_ms: 3_600_000 });
  }
  return service.getJob(job.job_id);
}

// 跑完一个已创建的作业（如 INCREMENTAL 作业）的全部分片。
export function drainJob(service, job) {
  for (let i = 0; i < job.shard_count; i++) {
    service.leaseShard(job.job_id, { owner: "test-worker", shard: i, lease_ms: 3_600_000 });
    service.runShard(job.job_id, i, { owner: "test-worker", max_items: 10_000, time_budget_ms: 3_600_000 });
  }
  return service.getJob(job.job_id);
}
