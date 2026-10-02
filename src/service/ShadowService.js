// 影子结算应用服务：用例编排层。
//
// 职责边界：
//   - 所有状态变化都通过 Ledger 落事件，内存状态由 reducer 回放，重启可恢复；
//   - 命令型事件使用由内容派生的确定性 event_id，重复提交天然幂等；
//   - 重放只读取已冻结快照与脱敏历史，产出的比较结果带 shadow lane 标记；
//   - 不提供任何指向真实结算/患者通道的写出口。

import { randomUUID } from "node:crypto";
import { SYSTEM_SUBJECT } from "../domain/events.js";
import { hashJson, sha256Hex } from "../domain/hash.js";
import {
  ConflictError,
  GateError,
  NotFoundError,
  ValidationError,
} from "../domain/errors.js";
import { sanitizeHistoryEvent, markShadowLane } from "../domain/enclave.js";
import { freezeSnapshot, reviseMappings, mappingDelta } from "../domain/catalog.js";
import { replayEvent, DIFF_CATEGORIES } from "../domain/replay.js";
import { replayAll, reduce, cmpKey } from "../store/reducer.js";

const LEASE_DEFAULT_MS = 30_000;
const CHECKPOINT_EVERY = 10;

const DEFAULT_STRATA = Object.freeze({
  CODE_MISSING: { rate: 1, min: 0, max: 200 },
  RULE_CONFLICT: { rate: 1, min: 0, max: 200 },
  SCOPE_CHANGE: { rate: 1, min: 0, max: 200 },
  AMOUNT_CHANGE: { rate: 0.1, min: 10, max: 100 },
  MATCH: { rate: 0.02, min: 5, max: 50 },
});

const round4 = (n) => Math.round(n * 10000) / 10000;

export class ShadowService {
  constructor(ledger, { now = () => new Date() } = {}) {
    this.ledger = ledger;
    this.clock = now;
    this.state = replayAll(ledger.load());
  }

  #nowIso() {
    return this.clock().toISOString();
  }

  // 提交事件：确定性 id 冲突时按调用方策略处理。
  #commit(kind, subjectId, payload, eventId = randomUUID()) {
    const record = {
      event_id: eventId,
      kind,
      occurred_at: this.#nowIso(),
      subject_id: subjectId,
      payload,
    };
    this.ledger.append(record); // 重复 id 抛 ConflictError
    // 立刻回放进内存状态，保证后续读到最新值。
    reduce(this.state, record);
    return record;
  }

  #commitIdempotent(kind, subjectId, payload, deterministicId) {
    if (this.ledger.hasEvent(deterministicId)) {
      return { record: null, duplicate: true };
    }
    return { record: this.#commit(kind, subjectId, payload, deterministicId), duplicate: false };
  }

  // ---- 历史事件摄入（脱敏 + 幂等）-------------------------------------

  ingestHistory(rawEvents, { by = SYSTEM_SUBJECT } = {}) {
    if (!Array.isArray(rawEvents)) throw new ValidationError("ingestHistory 需要事件数组");
    const ingested = [];
    const duplicates = [];
    for (const raw of rawEvents) {
      const event = sanitizeHistoryEvent(raw);
      const content_hash = hashJson(event);
      const eventId = `evt_hi_${content_hash.slice(0, 16)}`;

      const known = this.state.history.get(event.event_ref);
      if (known) {
        if (hashJson(known) !== content_hash) {
          throw new ConflictError("同一 event_ref 出现不同内容，拒绝覆盖", { event_ref: event.event_ref });
        }
        duplicates.push(event.event_ref);
        continue;
      }
      const { duplicate } = this.#commitIdempotent(
        "HISTORY_INGESTED",
        event.subject_ref,
        { event, content_hash, ingested_by: by },
        eventId,
      );
      (duplicate ? duplicates : ingested).push(event.event_ref);
    }
    return markShadowLane({ ingested, duplicates, total_known: this.state.history.size });
  }

  listHistory() {
    return markShadowLane([...this.state.history.values()]);
  }

  // ---- 快照冻结与映射修订 ---------------------------------------------

  freezeCatalog(input, { by = SYSTEM_SUBJECT } = {}) {
    const snapshot = freezeSnapshot(input, { frozenAt: this.#nowIso(), createdBy: by });
    const eventId = `evt_cf_${snapshot.content_hash.slice(0, 16)}`;
    const { duplicate } = this.#commitIdempotent(
      "CATALOG_FROZEN",
      SYSTEM_SUBJECT,
      { snapshot, frozen_by: by },
      eventId,
    );
    return markShadowLane({ snapshot, duplicate });
  }

  #requireSnapshot(snapshotId) {
    const s = this.state.snapshots.get(snapshotId);
    if (!s) throw new NotFoundError("快照不存在", { snapshot_id: snapshotId });
    return s;
  }

  getSnapshot(snapshotId) {
    return markShadowLane(this.#requireSnapshot(snapshotId));
  }

  listSnapshots(region = null) {
    const all = [...this.state.snapshots.values()];
    return markShadowLane(region ? all.filter((s) => s.region === region) : all);
  }

  reviseMappings(parentSnapshotId, { add = [], retire = [], note = null } = {}, { by = "expert" } = {}) {
    const parent = this.#requireSnapshot(parentSnapshotId);
    const child = reviseMappings(parent, parent.revision + 1, { add, retire, note, by, frozenAt: this.#nowIso() });
    const changedCodes = [...mappingDelta(parent, child)];
    if (changedCodes.length === 0) {
      // 无实质变化会造成内容哈希相同而修订链不同的非法记录，显式拒绝。
      throw new ValidationError("映射修订没有产生任何变化（补充与现状等价或退役条目不存在）");
    }
    const eventId = `evt_mr_${child.content_hash.slice(0, 16)}`;
    if (this.ledger.hasEvent(eventId)) {
      return markShadowLane({ snapshot: this.state.snapshots.get(child.snapshot_id), duplicate: true });
    }
    const affected_refs = this.#eventsTouchingCodes(parent.region, changedCodes);
    this.#commit("MAPPING_REVISED", by, {
      snapshot: child,
      parent_snapshot_id: parent.snapshot_id,
      changed_local_codes: changedCodes,
      affected_event_refs: affected_refs,
      note,
    }, eventId);
    return markShadowLane({
      snapshot: child,
      duplicate: false,
      changed_local_codes: changedCodes,
      affected_event_refs: affected_refs,
    });
  }

  #eventsTouchingCodes(region, codes) {
    const codeSet = new Set(codes);
    const refs = [];
    for (const event of this.state.history.values()) {
      if (event.region !== region) continue;
      if (event.lines.some((l) => codeSet.has(l.local_code))) refs.push(event.event_ref);
    }
    return refs.sort();
  }

  // ---- 分片重放作业 ----------------------------------------------------

  #jobTargets(snapshot, mode) {
    const refs =
      mode === "FULL"
        ? [...this.state.history.values()].filter((e) => e.region === snapshot.region).map((e) => e.event_ref)
        : null;
    return refs;
  }

  createJob({ snapshot_id, mode = "FULL", shard_count = 4, request_id = "default" } = {}) {
    if (!snapshot_id) throw new ValidationError("缺少 snapshot_id");
    const snapshot = this.#requireSnapshot(snapshot_id);
    if (!["FULL", "INCREMENTAL"].includes(mode)) throw new ValidationError("mode 必须是 FULL/INCREMENTAL");
    const shardCount = Math.max(1, Math.min(64, Number(shard_count) || 0));

    let refs;
    let parent_snapshot_id = null;
    if (mode === "FULL") {
      refs = this.#jobTargets(snapshot, mode);
    } else {
      if (!snapshot.parent_snapshot_id) {
        throw new ValidationError("INCREMENTAL 作业需要由映射修订产生的子快照");
      }
      parent_snapshot_id = snapshot.parent_snapshot_id;
      const parent = this.#requireSnapshot(parent_snapshot_id);
      refs = this.#eventsTouchingCodes(snapshot.region, [...mappingDelta(parent, snapshot)]);
    }
    refs.sort();

    const shards = Array.from({ length: shardCount }, (_, idx) => ({
      idx,
      status: "PENDING",
      cursor: 0,
      lease_epoch: 0,
      lease_owner: null,
      lease_until: null,
      completed_at: null,
    }));
    // 确定性分配：同一 event_ref 在相同分片数下永远落入同一分片。
    for (const ref of refs) {
      const idx = Number(BigInt("0x" + hashJson(ref).slice(0, 8)) % BigInt(shardCount));
      shards[idx].refs = shards[idx].refs ?? [];
      shards[idx].refs.push(ref);
    }
    for (const s of shards) if (!s.refs) s.refs = [];

    const jobSeed = hashJson([snapshot.snapshot_id, mode, parent_snapshot_id, shardCount, request_id, refs]);
    const job_id = `job_${jobSeed.slice(0, 12)}`;
    if (this.state.jobs.has(job_id)) {
      return markShadowLane({ job: this.state.jobs.get(job_id), duplicate: true });
    }
    const job = {
      job_id,
      request_id: String(request_id),
      snapshot_id,
      parent_snapshot_id,
      region: snapshot.region,
      mode,
      shard_count: shardCount,
      targets_fingerprint: jobSeed,
      status: refs.length ? "PENDING" : "COMPLETED",
      created_at: this.#nowIso(),
      shards,
      counts: refs.length ? null : this.#aggregate(snapshot.snapshot_id, refs),
    };
    this.#commit("JOB_CREATED", SYSTEM_SUBJECT, { job }, `evt_jc_${job_id}`);
    if (!refs.length) {
      this.#commit("JOB_COMPLETED", SYSTEM_SUBJECT, { job_id, counts: job.counts }, `evt_jdone_${job_id}`);
    }
    return markShadowLane({ job, duplicate: false });
  }

  getJob(jobId) {
    const job = this.state.jobs.get(jobId);
    if (!job) throw new NotFoundError("作业不存在", { job_id: jobId });
    return markShadowLane(this.#jobView(job));
  }

  listJobs(snapshotId = null) {
    const all = [...this.state.jobs.values()];
    return markShadowLane((snapshotId ? all.filter((j) => j.snapshot_id === snapshotId) : all).map((j) => this.#jobView(j)));
  }

  #jobView(job) {
    const nowMs = this.clock().getTime();
    const view = structuredClone(job);
    let active = 0;
    for (const s of view.shards) {
      s.total = s.refs.length;
      if (s.status === "LEASED" && s.lease_until && Date.parse(s.lease_until) <= nowMs) {
        s.lease_state = "EXPIRED";
      } else if (s.status === "LEASED") {
        s.lease_state = "ACTIVE";
        active += 1;
      }
    }
    view.active_leases = active;
    view.processed = view.shards.reduce((n, s) => n + s.cursor, 0);
    view.total = view.shards.reduce((n, s) => n + s.refs.length, 0);
    return view;
  }

  pauseJob(jobId) {
    const job = this.#requireJob(jobId);
    if (job.status === "COMPLETED") throw new ConflictError("作业已完成，不能暂停");
    if (job.status === "PAUSED") return markShadowLane({ job: this.#jobView(job), duplicate: true });
    this.#commit("JOB_PAUSED", SYSTEM_SUBJECT, { job_id: jobId }, `evt_jp_${jobId}_${job.shards[0].lease_epoch + 1}_${randomUUID().slice(0, 8)}`);
    return markShadowLane({ job: this.#jobView(job) });
  }

  resumeJob(jobId) {
    const job = this.#requireJob(jobId);
    if (job.status !== "PAUSED") throw new ConflictError("仅暂停中的作业可以恢复", { status: job.status });
    this.#commit("JOB_RESUMED", SYSTEM_SUBJECT, { job_id: jobId }, `evt_jr_${jobId}_${Date.parse(this.#nowIso())}_${randomUUID().slice(0, 8)}`);
    return markShadowLane({ job: this.#jobView(job) });
  }

  #requireJob(jobId) {
    const job = this.state.jobs.get(jobId);
    if (!job) throw new NotFoundError("作业不存在", { job_id: jobId });
    return job;
  }

  // 租约一个分片：优先 PENDING，其次租约已过期的 LEASED（崩溃/停机后续跑）。
  leaseShard(jobId, { owner = "worker", lease_ms = LEASE_DEFAULT_MS, shard: wantIdx = null } = {}) {
    const job = this.#requireJob(jobId);
    if (job.status === "COMPLETED") throw new ConflictError("作业已完成");
    if (job.status === "PAUSED") throw new ConflictError("作业已暂停，恢复后才能领取分片");
    const nowMs = this.clock().getTime();

    let shard = null;
    if (wantIdx !== null) {
      shard = job.shards[Number(wantIdx)] ?? null;
      if (!shard) throw new NotFoundError("分片不存在", { shard: wantIdx });
      if (shard.status === "DONE") throw new ConflictError("分片已完成", { shard: wantIdx });
      if (shard.status === "LEASED") {
        const expired = !shard.lease_until || Date.parse(shard.lease_until) <= nowMs;
        if (!expired && shard.lease_owner !== owner) {
          throw new ConflictError("分片仍被有效租约占用", { owner: shard.lease_owner });
        }
        if (!expired && shard.lease_owner === owner) {
          return markShadowLane({ shard: this.#jobView(job).shards[shard.idx], renewed: false });
        }
      }
    } else {
      const pending = job.shards.find((s) => s.status === "PENDING");
      const expired = job.shards.find(
        (s) => s.status === "LEASED" && (!s.lease_until || Date.parse(s.lease_until) <= nowMs),
      );
      shard = pending ?? expired ?? null;
      if (!shard) return markShadowLane({ shard: null, exhausted: true });
    }

    const epoch = shard.lease_epoch + 1;
    const lease_until = new Date(nowMs + Math.max(1000, Number(lease_ms))).toISOString();
    this.#commit(
      "SHARD_LEASED",
      SYSTEM_SUBJECT,
      { job_id: jobId, shard: shard.idx, owner, lease_until, epoch },
      `evt_sl_${jobId}_${shard.idx}_${epoch}`,
    );
    return markShadowLane({ shard: this.#jobView(job).shards[shard.idx], leased: true });
  }

  // 工作者主循环：协作式暂停/租约到期即停；checkpoint 崩溃安全；比较幂等。
  runShard(jobId, shardIdx, {
    owner = "worker",
    max_items = 100,
    time_budget_ms = 1000,
  } = {}) {
    const job = this.#requireJob(jobId);
    const shard = job.shards[Number(shardIdx)];
    if (!shard) throw new NotFoundError("分片不存在", { shard: shardIdx });
    if (shard.status === "DONE") return markShadowLane({ done: true, already_completed: true });
    const nowMs = () => this.clock().getTime();
    if (shard.status !== "LEASED" || shard.lease_owner !== owner || !shard.lease_until || Date.parse(shard.lease_until) <= nowMs()) {
      throw new ConflictError("没有该分片的有效租约，请先 leaseShard", { shard: shardIdx });
    }
    // 租约纪元栅栏：易主后旧持有者即使醒来也必须立刻停手。
    const myEpoch = shard.lease_epoch;

    const snapshot = this.#requireSnapshot(job.snapshot_id);
    const deadline = nowMs() + Math.max(0, Number(time_budget_ms));
    let processed = 0;
    let comparisons = 0;
    let duplicates = 0;
    let stopReason = null;
    let lastCheckpoint = shard.cursor;

    const flushCheckpoint = () => {
      if (shard.cursor === lastCheckpoint) return;
      const live = this.state.jobs.get(jobId).shards[shard.idx];
      if (live.lease_epoch !== myEpoch || live.lease_owner !== owner) {
        throw new ConflictError("租约已易主，旧持有者不得写入检查点", { shard: shard.idx });
      }
      const evtId = `evt_sc_${jobId}_${shard.idx}_${shard.cursor}`;
      if (!this.ledger.hasEvent(evtId)) {
        this.#commit(
          "SHARD_CHECKPOINT",
          SYSTEM_SUBJECT,
          {
            job_id: jobId,
            shard: shard.idx,
            cursor: shard.cursor,
            epoch: myEpoch,
            owner,
            lease_until: shard.lease_until,
          },
          evtId,
        );
      }
      lastCheckpoint = shard.cursor;
    };

    while (shard.cursor < shard.refs.length && processed < max_items) {
      const live = this.state.jobs.get(jobId).shards[shard.idx];
      // 协作式暂停：工作者每条事件之间主动让路。
      if (this.state.jobs.get(jobId).status === "PAUSED") {
        stopReason = "PAUSED";
        break;
      }
      // 栅栏：租约纪元变化（被其他工作者接管）-> 立即停手，绝不继续写。
      if (live.lease_epoch !== myEpoch || live.lease_owner !== owner) {
        stopReason = "FENCED";
        break;
      }
      if (nowMs() >= deadline) {
        stopReason = "TIME_BUDGET";
        break;
      }
      if (!live.lease_until || Date.parse(live.lease_until) <= nowMs()) {
        stopReason = "LEASE_EXPIRED";
        break;
      }

      const ref = shard.refs[shard.cursor];
      const event = this.state.history.get(ref);
      const comparison = replayEvent(snapshot, event);
      comparison.replayed_at = this.#nowIso();
      markShadowLane(comparison);
      const evtId = `evt_cr_${hashJson(["CLAIM_REPLAYED", comparison.comparison_id]).slice(0, 16)}`;
      const { duplicate } = this.#commitIdempotent(
        "CLAIM_REPLAYED",
        event.subject_ref,
        { comparison },
        evtId,
      );
      if (duplicate) duplicates += 1;
      else comparisons += 1;

      shard.cursor += 1;
      processed += 1;
      if (shard.cursor % CHECKPOINT_EVERY === 0) flushCheckpoint();
    }

    flushCheckpoint();

    if (!stopReason && shard.cursor >= shard.refs.length) {
      this.#completeShard(job, shard);
      stopReason = "COMPLETED";
    }
    return markShadowLane({
      shard: shard.idx,
      processed,
      new_comparisons: comparisons,
      duplicate_comparisons: duplicates,
      cursor: shard.cursor,
      total: shard.refs.length,
      stop_reason: stopReason,
    });
  }

  #completeShard(job, shard) {
    this.#commit(
      "SHARD_COMPLETED",
      SYSTEM_SUBJECT,
      { job_id: job.job_id, shard: shard.idx, processed: shard.cursor },
      `evt_sdone_${job.job_id}_${shard.idx}`,
    );
    const allDone = job.shards.every((s) => s.status === "DONE");
    if (allDone && job.status !== "COMPLETED") {
      const refs = job.shards.flatMap((s) => s.refs);
      const counts = this.#aggregate(job.snapshot_id, refs);
      this.#commit(
        "JOB_COMPLETED",
        SYSTEM_SUBJECT,
        { job_id: job.job_id, counts },
        `evt_jdone_${job.job_id}`,
      );
      this.#commit(
        "DIFF_CLASSIFIED",
        SYSTEM_SUBJECT,
        { job_id: job.job_id, snapshot_id: job.snapshot_id, counts },
        `evt_dc_${job.job_id}`,
      );
    }
  }

  // ---- 比较读模型：汇总 -> 明细 -> 规则依据 ---------------------------

  // 沿修订链解析：子快照只重算受影响事件，其余沿用父快照结论。
  resolveComparison(snapshotId, eventRef) {
    let snap = this.#requireSnapshot(snapshotId);
    for (;;) {
      const hit = this.state.comparisons.get(cmpKey(snap.snapshot_id, eventRef));
      if (hit) return markShadowLane({ comparison: hit, source_snapshot_id: snap.snapshot_id });
      if (!snap.parent_snapshot_id) {
        throw new NotFoundError("该事件在快照链上尚无比较结果", { snapshot_id: snapshotId, event_ref: eventRef });
      }
      snap = this.#requireSnapshot(snap.parent_snapshot_id);
    }
  }

  #resolvedComparisons(snapshotId) {
    const snap = this.#requireSnapshot(snapshotId);
    const out = [];
    for (const event of this.state.history.values()) {
      if (event.region !== snap.region) continue;
      let cur = snap;
      let hit = null;
      let source = null;
      for (;;) {
        const found = this.state.comparisons.get(cmpKey(cur.snapshot_id, event.event_ref));
        if (found) {
          hit = found;
          source = cur.snapshot_id;
          break;
        }
        if (!cur.parent_snapshot_id) break;
        cur = this.#requireSnapshot(cur.parent_snapshot_id);
      }
      if (hit) out.push({ comparison: hit, source_snapshot_id: source });
    }
    return out;
  }

  #aggregate(snapshotId, refs = null) {
    const categories = Object.fromEntries(Object.values(DIFF_CATEGORIES).map((c) => [c, 0]));
    let lineTotal = 0;
    let currentTotal = 0;
    let candidateTotal = 0;
    const refSet = refs ? new Set(refs) : null;
    for (const { comparison } of this.#resolvedComparisons(snapshotId)) {
      if (refSet && !refSet.has(comparison.event_ref)) continue;
      lineTotal += comparison.diffs.length;
      currentTotal += comparison.current_total;
      candidateTotal += comparison.candidate_total;
      for (const d of comparison.diffs) categories[d.category] += 1;
    }
    return {
      events: refSet ? refSet.size : null,
      lines: lineTotal,
      categories,
      current_total: Math.round(currentTotal * 100) / 100,
      candidate_total: Math.round(candidateTotal * 100) / 100,
      total_delta: Math.round((candidateTotal - currentTotal) * 100) / 100,
    };
  }

  diffSummary(snapshotId) {
    this.#requireSnapshot(snapshotId);
    return markShadowLane({ snapshot_id: snapshotId, ...this.#aggregate(snapshotId) });
  }

  // 一级下钻：汇总类别 -> 命中的具体费用行。
  diffDrill(snapshotId, category, { limit = 200 } = {}) {
    if (!Object.values(DIFF_CATEGORIES).includes(category)) {
      throw new ValidationError("未知差异类别", { category });
    }
    const rows = [];
    for (const { comparison, source_snapshot_id } of this.#resolvedComparisons(snapshotId)) {
      for (const d of comparison.diffs) {
        if (d.category !== category) continue;
        rows.push({
          event_ref: comparison.event_ref,
          line_ref: d.line_ref,
          local_code: d.local_code,
          source_snapshot_id,
          current_codes: d.current.resolved_codes,
          candidate_codes: d.candidate.resolved_codes,
          current_status: d.current.status,
          candidate_status: d.candidate.status,
          current_amount: d.current.amount,
          candidate_amount: d.candidate.amount,
          amount_delta: d.amount_delta,
          undetermined: d.undetermined,
        });
      }
    }
    return markShadowLane({ category, count: rows.length, rows: rows.slice(0, limit) });
  }

  // 二级下钻：具体费用行 -> 规则依据原文（含规则/费率/映射定义）。
  ruleBasis(snapshotId, eventRef, lineRef) {
    const { comparison, source_snapshot_id } = this.resolveComparison(snapshotId, eventRef);
    const idx = comparison.diffs.findIndex((d) => String(d.line_ref) === String(lineRef));
    if (idx < 0) throw new NotFoundError("该费用行不存在", { line_ref: lineRef });
    const d = comparison.diffs[idx];
    const source = this.#requireSnapshot(source_snapshot_id);
    const resolveRules = (reasons) =>
      reasons.map((r) => {
        const extra = {};
        if (r.rule_id) {
          extra.rule = source.restrictions.find((x) => x.id === r.rule_id) ?? null;
        }
        if (r.rate_id) {
          extra.rate = source.rates.find((x) => x.id === r.rate_id) ?? null;
        }
        if (r.mapping_id) {
          extra.mapping = source.mappings.find((x) => x.mapping_id === r.mapping_id) ?? null;
        }
        return { ...r, ...extra };
      });
    return markShadowLane({
      snapshot_id: snapshotId,
      evaluated_on_snapshot_id: source_snapshot_id,
      event_ref: eventRef,
      line_ref: lineRef,
      service_date: comparison.service_date,
      category: d.category,
      current: { ...d.current, reasons: resolveRules(d.current.reasons) },
      candidate: { ...d.candidate, reasons: resolveRules(d.candidate.reasons) },
      classification_basis: resolveRules(d.rule_basis),
    });
  }

  // ---- 抽样复核 --------------------------------------------------------

  createReviewPlan(snapshotId, { seed = null, strata = DEFAULT_STRATA } = {}) {
    const snapshot = this.#requireSnapshot(snapshotId);
    // 池：沿修订链可见的全部逐行结论。
    const pool = [];
    for (const { comparison, source_snapshot_id } of this.#resolvedComparisons(snapshotId)) {
      for (const d of comparison.diffs) {
        pool.push({
          item_key: `${comparison.event_ref}|${d.line_ref}`,
          event_ref: comparison.event_ref,
          line_ref: d.line_ref,
          category: d.category,
          source_snapshot_id,
        });
      }
    }
    const planSeed = seed ?? `${snapshotId}:review:v1`;
    const plan_id = `plan_${hashJson([snapshotId, planSeed, strata]).slice(0, 12)}`;
    if (this.state.reviewPlans.has(plan_id)) {
      return markShadowLane({ plan: this.state.reviewPlans.get(plan_id), duplicate: true });
    }

    const items = [];
    for (const category of Object.values(DIFF_CATEGORIES)) {
      const cfg = strata[category] ?? { rate: 0, min: 0, max: 0 };
      const members = pool.filter((p) => p.category === category);
      // 确定性洗牌：同一种子永远抽出同一样本。
      const rand = seededRand(hashJson([planSeed, category]));
      const shuffled = [...members];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const target = Math.min(
        members.length,
        Math.max(cfg.min ?? 0, Math.min(cfg.max ?? members.length, Math.ceil((cfg.rate ?? 0) * members.length))),
      );
      shuffled.slice(0, target).forEach((m, i) => {
        items.push({
          item_id: `item_${hashJson([plan_id, m.item_key]).slice(0, 12)}`,
          event_ref: m.event_ref,
          line_ref: m.line_ref,
          category,
          source_snapshot_id: m.source_snapshot_id,
          stratum_index: i,
          status: "PENDING",
          review_id: null,
          verdict: null,
        });
      });
    }

    const plan = {
      plan_id,
      snapshot_id: snapshotId,
      region: snapshot.region,
      seed: planSeed,
      strata,
      created_at: this.#nowIso(),
      items,
    };
    this.#commit("REVIEW_PLANNED", SYSTEM_SUBJECT, { plan }, `evt_rp_${plan_id}`);
    return markShadowLane({ plan, duplicate: false });
  }

  recordReview(planId, itemId, { verdict, by = "reviewer", note = null } = {}) {
    const plan = this.state.reviewPlans.get(planId);
    if (!plan) throw new NotFoundError("抽样计划不存在", { plan_id: planId });
    const item = plan.items.find((i) => i.item_id === itemId);
    if (!item) throw new NotFoundError("样本项不存在", { item_id: itemId });
    if (item.status === "REVIEWED") throw new ConflictError("该样本已复核，结论不可改写", { review_id: item.review_id });
    if (!["AGREE", "DISAGREE"].includes(verdict)) throw new ValidationError("verdict 必须是 AGREE/DISAGREE");

    const review_id = `rev_${hashJson([planId, itemId]).slice(0, 12)}`;
    const review = {
      review_id,
      plan_id: planId,
      item_id: itemId,
      event_ref: item.event_ref,
      line_ref: item.line_ref,
      category: item.category,
      source_snapshot_id: item.source_snapshot_id,
      verdict,
      reviewer: by,
      note,
      reviewed_at: this.#nowIso(),
    };
    this.#commit("REVIEW_RECORDED", by, { review }, `evt_rr_${review_id}`);
    return markShadowLane({ review });
  }

  // 复核门槛：样本全部复核 + 分歧率不超过阈值 + 高风险层达到最小样本量。
  reviewGate(planId, { max_disagreement_rate = 0.05 } = {}) {
    const plan = this.state.reviewPlans.get(planId);
    if (!plan) throw new NotFoundError("抽样计划不存在", { plan_id: planId });
    const strata = {};
    for (const item of plan.items) {
      const s = (strata[item.category] ??= { total: 0, reviewed: 0, agree: 0, disagree: 0 });
      s.total += 1;
      if (item.status === "REVIEWED") {
        s.reviewed += 1;
        s[item.verdict === "AGREE" ? "agree" : "disagree"] += 1;
      }
    }
    const total = plan.items.length;
    const reviewed = plan.items.filter((i) => i.status === "REVIEWED").length;
    const disagreements = plan.items.filter((i) => i.verdict === "DISAGREE").length;
    const rate = reviewed ? round4(disagreements / reviewed) : null;
    const missingMin = [];
    for (const [category, cfg] of Object.entries(plan.strata)) {
      const poolCount = this.#countPool(plan.snapshot_id, category);
      const sampled = strata[category]?.total ?? 0;
      // 期望样本量与建计划时一致；池为空时期望为 0，不阻塞。
      const expected = Math.min(
        poolCount,
        Math.max(cfg.min ?? 0, Math.min(cfg.max ?? poolCount, Math.ceil((cfg.rate ?? 0) * poolCount))),
      );
      if (sampled < expected) missingMin.push(category);
      strata[category] = { ...(strata[category] ?? { total: 0, reviewed: 0, agree: 0, disagree: 0 }), pool: poolCount, expected };
    }
    const complete = total > 0 && reviewed === total;
    const meets =
      complete && rate !== null && rate <= max_disagreement_rate && missingMin.length === 0;
    return markShadowLane({
      plan_id: planId,
      complete,
      items_total: total,
      reviewed,
      disagreements,
      disagreement_rate: rate,
      max_disagreement_rate,
      missing_minimum_strata: [...new Set(missingMin)],
      strata,
      meets,
    });
  }

  #countPool(snapshotId, category) {
    let n = 0;
    for (const { comparison } of this.#resolvedComparisons(snapshotId)) {
      for (const d of comparison.diffs) if (d.category === category) n += 1;
    }
    return n;
  }

  // ---- 地区签署与发布资格 ----------------------------------------------

  signRegion({ region, snapshot_id, signer }) {
    const snapshot = this.#requireSnapshot(snapshot_id);
    if (snapshot.region !== region) {
      throw new ValidationError("签署地区与快照地区不一致", { region, snapshot_region: snapshot.region });
    }
    const sigKey = `${region}|${snapshot_id}`;
    if (this.state.signatures.has(sigKey)) {
      return markShadowLane({ signature: this.state.signatures.get(sigKey), duplicate: true });
    }
    // 签署前必须通过复核门槛（取该快照最新的抽样计划）。
    const plans = [...this.state.reviewPlans.values()].filter((p) => p.snapshot_id === snapshot_id);
    if (!plans.length) throw new GateError("该快照尚无抽样复核计划，不具备签署条件");
    const gates = plans.map((p) => this.reviewGate(p.plan_id));
    if (!gates.some((g) => g.meets)) {
      throw new GateError("抽样复核门槛未通过，地区不能签署", gates.map((g) => ({
        plan_id: g.plan_id,
        complete: g.complete,
        disagreement_rate: g.disagreement_rate,
        missing: g.missing_minimum_strata,
      })));
    }
    const eventId = `evt_rs_${region}_${snapshot.content_hash.slice(0, 12)}`;
    const { duplicate } = this.#commitIdempotent(
      "REGION_SIGNED",
      signer,
      { region, snapshot_id, content_hash: snapshot.content_hash, signer },
      eventId,
    );
    return markShadowLane({ signature: this.state.signatures.get(sigKey), duplicate });
  }

  createReleaseCampaign({ name, members } = {}) {
    if (!Array.isArray(members) || members.length === 0) throw new ValidationError("members 不能为空");
    const seenRegions = new Set();
    let nationalVersion = null;
    const normalized = [];
    for (const m of members) {
      const snap = this.#requireSnapshot(m.snapshot_id);
      if (seenRegions.has(snap.region)) throw new ConflictError("同一地区在活动中出现多次", { region: snap.region });
      seenRegions.add(snap.region);
      nationalVersion = nationalVersion ?? snap.national.version;
      if (snap.national.version !== nationalVersion) {
        throw new ConflictError("活动成员的国家目录版本不一致", {
          expected: nationalVersion,
          got: snap.national.version,
        });
      }
      normalized.push({ region: snap.region, snapshot_id: snap.snapshot_id, content_hash: snap.content_hash });
    }
    const campaign_id = `camp_${hashJson(["campaign", name ?? "", normalized]).slice(0, 12)}`;
    return markShadowLane({
      campaign: {
        campaign_id,
        name: name ?? null,
        national_version: nationalVersion,
        members: normalized,
        created_at: this.#nowIso(),
      },
    });
  }

  // 发布资格：每个成员地区都已对【同一内容哈希】签署，且复核门槛仍然满足。
  // 颁发的只是获准环境内的资格证书；系统没有、也不会有任何向真实结算下发的出口。
  issueRelease(campaign) {
    if (!campaign || !campaign.members) throw new ValidationError("非法发布活动");
    const evidence = [];
    const blockers = [];
    for (const m of campaign.members) {
      const sig = this.state.signatures.get(`${m.region}|${m.snapshot_id}`);
      if (!sig || sig.content_hash !== m.content_hash) {
        blockers.push({ region: m.region, reason: "MISSING_OR_STALE_SIGNATURE" });
        continue;
      }
      const plans = [...this.state.reviewPlans.values()].filter((p) => p.snapshot_id === m.snapshot_id);
      const gate = plans.map((p) => this.reviewGate(p.plan_id)).find((g) => g.meets);
      if (!gate) blockers.push({ region: m.region, reason: "REVIEW_GATE_NOT_MET" });
      evidence.push({
        region: m.region,
        snapshot_id: m.snapshot_id,
        content_hash: m.content_hash,
        signer: sig.signer,
        signed_at: sig.signed_at,
      });
    }
    if (blockers.length) {
      throw new GateError("发布门槛未全部满足", { campaign_id: campaign.campaign_id, blockers });
    }
    const release_id = `rel_${hashJson(["release", campaign.campaign_id, evidence]).slice(0, 12)}`;
    if (this.state.releases.has(release_id)) {
      return markShadowLane({ certificate: this.state.releases.get(release_id), duplicate: true });
    }
    const certificate = {
      release_id,
      campaign_id: campaign.campaign_id,
      national_version: campaign.national_version,
      issued_at: this.#nowIso(),
      scope: "SHADOW_RELEASE_ELIGIBILITY_ONLY",
      evidence,
    };
    this.#commit("RELEASE_SIGNED", SYSTEM_SUBJECT, { certificate }, `evt_rel_${release_id}`);
    return markShadowLane({ certificate, duplicate: false });
  }

  releaseEligibility(campaign) {
    const result = { campaign_id: campaign.campaign_id, eligible: false, blockers: [], evidence: [] };
    for (const m of campaign.members) {
      const sig = this.state.signatures.get(`${m.region}|${m.snapshot_id}`);
      if (!sig || sig.content_hash !== m.content_hash) {
        result.blockers.push({ region: m.region, reason: "MISSING_OR_STALE_SIGNATURE" });
        continue;
      }
      const plans = [...this.state.reviewPlans.values()].filter((p) => p.snapshot_id === m.snapshot_id);
      const gate = plans.map((p) => this.reviewGate(p.plan_id)).find((g) => g.meets);
      if (!gate) {
        result.blockers.push({ region: m.region, reason: "REVIEW_GATE_NOT_MET" });
      } else {
        result.evidence.push({ region: m.region, signed: true, disagreement_rate: gate.disagreement_rate });
      }
    }
    result.eligible = result.blockers.length === 0;
    return markShadowLane(result);
  }
}

function seededRand(seedHex) {
  // 与 domain/hash.seededSequence 相同的确定性发生器，字符串种子直接哈希。
  let state = BigInt("0x" + sha256Hex(seedHex).slice(0, 16));
  return () => {
    let x = state;
    x ^= x >> 12n;
    x ^= x << 25n;
    x ^= x >> 27n;
    state = BigInt.asUintN(64, x);
    const mixed = BigInt.asUintN(64, x * 2685821657736338717n);
    return Number(mixed) / Number(1n << 64n);
  };
}
