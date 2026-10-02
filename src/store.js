// 影子事件存储：只追加（append-only）事件日志 + 状态归约。
//
// 关键不变量：
//   - 事件一旦写入不可修改；任何"变化"都以新事件表达（映射新版本、比较被取代）。
//   - 同一 claim_id 重复进入：内容相同则幂等忽略，内容不同则拒绝（防碰撞）。
//   - 每条历史事件在任一时刻只有一条"有效比较"：新比较通过 supersedes_event_id
//     显式取代旧比较，归约状态里只保留最新一条。

import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { DATA_SCOPE, validateEvent } from "./insurance_shadow_settlement.js";
import { FrozenArtifact, FreezeRegistry } from "./freeze.js";
import { SINKS } from "./environment.js";

export class ShadowEventStore {
  constructor(boundary, filePath, clock = () => new Date().toISOString()) {
    boundary.assertSink(SINKS.SHADOW_EVENT_LOG);
    boundary.assertPathInside(filePath);
    this.boundary = boundary;
    this.filePath = filePath;
    this.clock = clock;
    this._seq = 0;
    this._eventIds = new Set();
    this._writeChain = Promise.resolve();
    this._state = freshState();
  }

  static open(boundary, filePath, clock) {
    const store = new ShadowEventStore(boundary, filePath, clock);
    if (existsSync(filePath)) {
      for (const line of readFileSync(filePath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        store._ingestEnvelope(JSON.parse(line));
      }
    }
    return store;
  }

  // 追加事件。event_id 相同时幂等返回既有事件；校验或领域不变量失败则拒绝写入。
  append(kind, subjectId, payload, { eventId, occurredAt } = {}) {
    this.boundary.assertApproved();
    this._writeChain = this._writeChain.then(async () => {
      const event_id = eventId ?? `evt-${String(this._seq + 1).padStart(6, "0")}-${randomBytes(4).toString("hex")}`;
      if (this._eventIds.has(event_id)) return;
      const record = {
        event_id,
        kind,
        occurred_at: occurredAt ?? this.clock(),
        subject_id: subjectId,
        payload,
        data_scope: DATA_SCOPE,
      };
      const problems = validateEvent(record);
      if (problems.length) throw new Error(`事件校验失败:${problems.join(",")}`);
      this._guardDomainInvariants(record);
      const envelope = { seq: this._seq + 1, ...record };
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, JSON.stringify(envelope) + "\n");
      this._ingestEnvelope(envelope);
    });
    return this._writeChain;
  }

  _guardDomainInvariants(record) {
    const p = record.payload;
    if (record.kind === "CLAIM_INGESTED") {
      const existing = this._state.claims.get(p.claim.claim_id);
      if (existing && existing.claim_hash !== p.claim_hash) {
        throw new Error(`claim_id ${p.claim.claim_id} 重复进入但内容哈希不同，拒绝写入`);
      }
    }
    if (record.kind === "MAPPING_REVISED") {
      const revisions = this._state.mappingRevisions.get(p.region) ?? [];
      const latest = revisions[revisions.length - 1];
      if (latest && p.revision <= latest.revision) {
        throw new Error(`地区 ${p.region} 映射修订号必须递增（最新 ${latest.revision}）`);
      }
      if (latest && p.supersedes_revision !== latest.revision) {
        throw new Error("映射修订必须显式基于最新修订号 supersedes_revision");
      }
    }
    if (record.kind === "REPLAY_STARTED" && this._state.jobs.has(p.job_id)) {
      throw new Error(`作业 ${p.job_id} 已存在`);
    }
  }

  _ingestEnvelope(envelope) {
    if (this._eventIds.has(envelope.event_id)) return; // 重放日志时幂等
    this._seq = Math.max(this._seq, envelope.seq);
    this._eventIds.add(envelope.event_id);
    reduce(this._state, envelope);
  }

  get state() {
    return this._state;
  }

  events() {
    return [...this._state.events];
  }

  effectiveComparison(claimId) {
    return this._state.comparisons.get(claimId) ?? null;
  }

  job(jobId) {
    return this._state.jobs.get(jobId) ?? null;
  }

  currentMapping(region) {
    const revisions = this._state.mappingRevisions.get(region) ?? [];
    return revisions[revisions.length - 1] ?? null;
  }

  // 从事件日志重建冻结注册表。重放作业通过内容哈希精确引用快照，
  // 因此映射修订只按哈希登记（evaluate 仅按哈希取用），不参与生效时间线。
  rebuildRegistry() {
    const registry = new FreezeRegistry();
    for (const e of this._state.events) {
      if (e.kind === "CATALOG_FROZEN") {
        const p = e.payload;
        registry.put(new FrozenArtifact({
          artifact_type: p.artifact_type,
          side: p.side,
          region: p.region,
          version: p.version,
          content: p.content,
          frozen_at: p.frozen_at,
          effective_from: p.effective_from,
          effective_to: p.effective_to ?? null,
        }));
      } else if (e.kind === "MAPPING_REVISED") {
        const p = e.payload;
        registry.put(new FrozenArtifact({
          artifact_type: "MAPPING",
          side: "CANDIDATE",
          region: p.region,
          version: String(p.revision),
          content: p.content,
          frozen_at: e.occurred_at,
          effective_from: e.occurred_at,
          effective_to: null,
        }), { timeline: false });
      }
    }
    return registry;
  }
}

function freshState() {
  return {
    seq: 0,
    events: [],
    claims: new Map(),
    comparisons: new Map(),
    jobs: new Map(),
    mappingRevisions: new Map(),
    samples: new Map(),
    rechecks: new Map(),
    signoffs: new Map(),
    decisions: [],
  };
}

function reduce(state, e) {
  state.seq = e.seq;
  state.events.push(e);
  const p = e.payload;
  switch (e.kind) {
    case "CLAIM_INGESTED": {
      if (!state.claims.has(p.claim.claim_id)) {
        state.claims.set(p.claim.claim_id, { claim: p.claim, claim_hash: p.claim_hash, seq: e.seq });
      }
      break;
    }
    case "MAPPING_REVISED": {
      const list = state.mappingRevisions.get(p.region) ?? [];
      list.push({
        event_id: e.event_id,
        seq: e.seq,
        revision: p.revision,
        supersedes_revision: p.supersedes_revision,
        changed_local_codes: p.changed_local_codes,
        content_hash: p.content_hash,
        occurred_at: e.occurred_at,
      });
      state.mappingRevisions.set(p.region, list);
      break;
    }
    case "REPLAY_STARTED": {
      state.jobs.set(p.job_id, {
        job_id: p.job_id,
        exercise_id: p.exercise_id,
        kind: p.kind,
        status: "RUNNING",
        shard_count: p.shard_count,
        plan: p.plan,
        refs: p.refs,
        scope: p.scope ?? { kind: "ALL" },
        cursors: Object.fromEntries(p.plan.map((shard, i) => [String(i), shard.cursor ?? 0])),
        processed: 0,
        skipped: 0,
        seq: e.seq,
      });
      break;
    }
    case "REPLAY_PAUSED": {
      const job = state.jobs.get(p.job_id);
      if (job) job.status = "PAUSED";
      break;
    }
    case "REPLAY_RESUMED": {
      const job = state.jobs.get(p.job_id);
      if (job && job.status === "PAUSED") job.status = "RUNNING";
      break;
    }
    case "REPLAY_CHECKPOINT": {
      const job = state.jobs.get(p.job_id);
      if (job) {
        job.cursors[String(p.shard)] = p.cursor;
        if (typeof p.processed === "number") job.processed = p.processed;
        if (typeof p.skipped === "number") job.skipped = p.skipped;
      }
      break;
    }
    case "REPLAY_COMPLETED": {
      const job = state.jobs.get(p.job_id);
      if (job) {
        job.status = "COMPLETED";
        job.processed = p.processed;
        job.skipped = p.skipped;
      }
      break;
    }
    case "COMPARISON_PRODUCED": {
      state.comparisons.set(p.claim_id, { event_id: e.event_id, seq: e.seq, ...p });
      break;
    }
    case "SAMPLE_DRAWN": {
      state.samples.set(p.batch_id, { ...p, drawn_seq: e.seq });
      break;
    }
    case "RECHECK_RECORDED": {
      state.rechecks.set(`${p.batch_id}|${p.claim_id}`, { ...p, seq: e.seq });
      break;
    }
    case "REGION_SIGNED": {
      state.signoffs.set(p.region, { event_id: e.event_id, seq: e.seq, ...p });
      break;
    }
    case "RELEASE_QUALIFIED": {
      state.decisions.push({ event_id: e.event_id, seq: e.seq, ...p });
      break;
    }
    default:
      break;
  }
}
