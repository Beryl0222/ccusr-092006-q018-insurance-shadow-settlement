// 影子结算编排服务：冻结登记、事件接入、映射修订、分片重放（暂停/恢复/幂等）。
//
// 重放作业语义：
//   - 分片计划按 claim_id 内容哈希确定性分配，重复规划结果一致；
//   - 游标记录每个分片已处理条数，恢复后跳过已处理部分；
//   - 每处理一条事件：若现行有效比较的幂等键相同则跳过（不产生新事件），
//     否则追加 COMPARISON_PRODUCED，并以 supersedes_event_id 取代旧比较；
//   - 暂停请求通过事件生效，处理循环每条之间检查，绝不丢弃已完成的比较。

import { createHash } from "node:crypto";
import { hashContent } from "./freeze.js";
import { replayClaim, comparisonIdempotencyKey } from "./evaluate.js";
import { validateDesensitizedClaim } from "./insurance_shadow_settlement.js";

export const claimHash = (claim) => hashContent(claim);

// 确定性分片：claim_id 散列取模，保证同一集合的分片计划可复现。
function shardOf(claimId, shardCount) {
  const h = createHash("sha256").update(claimId).digest();
  return h.readUInt32BE(0) % shardCount;
}

export class ShadowSettlementService {
  constructor(store, registry, clock = () => new Date().toISOString()) {
    this.store = store;
    this.registry = registry;
    this.clock = clock;
  }

  // ---- 冻结 ----------------------------------------------------------------

  async freeze(input, { eventId } = {}) {
    const artifact = this.registry.put(input);
    await this.store.append(
      "CATALOG_FROZEN",
      `catalog:${artifact.side}:${artifact.artifact_type}`,
      {
        artifact_type: artifact.artifact_type,
        side: artifact.side,
        region: artifact.region,
        version: artifact.version,
        content_hash: artifact.content_hash,
        frozen_at: artifact.frozen_at,
        effective_from: artifact.effective_from,
        effective_to: artifact.effective_to,
        content: artifact.content,
      },
      { eventId },
    );
    return artifact;
  }

  // ---- 历史事件接入（必须先脱敏） ------------------------------------------

  async ingestClaim(claim, { eventId } = {}) {
    const problems = validateDesensitizedClaim(claim);
    if (problems.length) throw new Error(`历史事件脱敏校验未通过:${problems.join(";")}`);
    const claim_hash = claimHash(claim);
    const existing = this.store.state.claims.get(claim.claim_id);
    if (existing) {
      if (existing.claim_hash !== claim_hash) {
        throw new Error(`claim_id ${claim.claim_id} 重复进入但内容哈希不同，拒绝接入`);
      }
      return { deduped: true, claim_hash }; // 重复进入、内容一致：只保留一次
    }
    await this.store.append(
      "CLAIM_INGESTED",
      claim.region,
      { claim, claim_hash },
      { eventId, occurredAt: claim.settled_at ?? undefined },
    );
    return { deduped: false, claim_hash };
  }

  // ---- 映射修订 ------------------------------------------------------------

  // 专家补充映射。changedCodes 可显式给出；缺省时对比新旧条目自动求差集。
  async reviseMapping({ region, revision, content, supersedes_revision, changedCodes }, { eventId } = {}) {
    const latest = this.store.currentMapping(region);
    const expectedBase = latest ? latest.revision : 0;
    if (supersedes_revision !== expectedBase) {
      throw new Error(`supersedes_revision 必须是当前最新修订 ${expectedBase}`);
    }
    let changed = changedCodes;
    if (!changed) {
      const oldEntries = latest ? this.registry.get(latest.content_hash).content.entries : {};
      changed = Object.keys(content.entries ?? {}).filter(
        (code) => hashContent(oldEntries[code] ?? null) !== hashContent(content.entries[code]),
      );
    }
    const snapshot = this.registry.put({
      artifact_type: "MAPPING",
      side: "CANDIDATE",
      region,
      version: String(revision),
      content,
      frozen_at: this.clock(),
      effective_from: this.clock(),
      effective_to: null,
    }, { timeline: false });

    await this.store.append(
      "MAPPING_REVISED",
      region,
      {
        region,
        revision,
        content,
        content_hash: snapshot.content_hash,
        supersedes_revision,
        changed_local_codes: [...new Set(changed)].sort(),
      },
      { eventId },
    );
    return { snapshot, affected_claim_ids: this.affectedClaims(region, changed) };
  }

  // 真正受映射修订影响的集合：该地区、费用行命中任一变动本地编码的历史事件。
  affectedClaims(region, changedLocalCodes) {
    const changed = new Set(changedLocalCodes);
    const ids = [];
    for (const [id, entry] of this.store.state.claims) {
      if (entry.claim.region !== region) continue;
      if (entry.claim.lines.some((line) => changed.has(line.local_code))) ids.push(id);
    }
    return ids.sort();
  }

  // ---- 重放作业 ------------------------------------------------------------

  // 映射修订后的便捷入口：只对真正受影响的事件集合起增量作业。
  async startIncrementalReplay({ jobId, exerciseId, refs, region }, opts = {}) {
    const mappingHash = typeof refs.candidate.mapping === "string"
      ? refs.candidate.mapping
      : refs.candidate.mapping[region];
    const snapshot = this.registry.get(mappingHash);
    if (snapshot.region !== region) throw new Error("refs.candidate.mapping 与地区不一致");
    const changedCodes = (this.store.currentMapping(region)?.changed_local_codes) ?? [];
    const claim_ids = this.affectedClaims(region, changedCodes);
    return this.startReplayJob({
      jobId, exerciseId, refs,
      shardCount: Math.max(1, Math.min(4, claim_ids.length || 1)),
      scope: { kind: "AFFECTED", claim_ids },
    }, opts);
  }

  // scope: {kind:"ALL"} 或 {kind:"AFFECTED", claim_ids:[...]}
  buildPlan({ shardCount, scope }) {
    let ids = [...this.store.state.claims.keys()];
    if (scope.kind === "AFFECTED") {
      const allow = new Set(scope.claim_ids);
      ids = ids.filter((id) => allow.has(id));
    }
    ids.sort();
    const plan = Array.from({ length: shardCount }, () => []);
    for (const id of ids) plan[shardOf(id, shardCount)].push(id);
    return plan.map((claim_ids, shard) => ({ shard, claim_ids }));
  }

  async startReplayJob({ jobId, exerciseId, refs, shardCount = 4, scope = { kind: "ALL" } }, opts = {}) {
    // refs 语义：
    //   - candidate 为"待启用冻结包"：目录/限制/费率是固定哈希，映射按地区给哈希；
    //   - incumbent 为逻辑选择器（region:"AUTO"），处理每条事件时按就医发生时点解析当时版本。
    const mappingHashes = typeof refs.candidate.mapping === "string"
      ? [refs.candidate.mapping] : Object.values(refs.candidate.mapping);
    for (const hash of [refs.candidate.catalog, refs.candidate.restriction, refs.candidate.rate, ...mappingHashes]) {
      if (!this.registry.has(hash)) throw new Error(`作业引用了未冻结的候选快照:${hash}`);
    }
    const plan = this.buildPlan({ shardCount, scope });
    await this.store.append("REPLAY_STARTED", exerciseId, {
      job_id: jobId,
      exercise_id: exerciseId,
      kind: scope.kind === "AFFECTED" ? "INCREMENTAL_REPLAY" : "FULL_REPLAY",
      shard_count: shardCount,
      plan,
      refs,
      scope,
    }, opts);
    return this.store.job(jobId);
  }

  // 把作业规格解析为一组具体冻结快照哈希：
  // 现行侧按就医发生时点选取当时有效版本；候选侧使用待启用冻结包（固定），映射按地区取。
  resolveRefsForDate(spec, claim) {
    const when = claim.service_date;
    const incumbentRegion = spec.incumbent.region === "AUTO" ? claim.region : spec.incumbent.region;
    const candidateRegion = spec.candidate.region === "AUTO" ? claim.region : spec.candidate.region;
    const pick = (type, side, region) =>
      this.registry.effectiveAt(type, side, region, when).content_hash;
    const mappingHash = typeof spec.candidate.mapping === "string"
      ? spec.candidate.mapping
      : spec.candidate.mapping[candidateRegion];
    if (!mappingHash) throw new Error(`地区 ${candidateRegion} 缺少映射引用`);
    return {
      incumbent: {
        catalog: pick("CATALOG", "INCUMBENT", incumbentRegion),
        restriction: pick("RESTRICTION", "INCUMBENT", incumbentRegion),
        rate: pick("RATE_TABLE", "INCUMBENT", incumbentRegion),
      },
      candidate: {
        catalog: spec.candidate.catalog,
        restriction: spec.candidate.restriction,
        rate: spec.candidate.rate,
      },
      mapping: mappingHash,
    };
  }

  async pause(jobId, opts = {}) {
    const job = this.store.job(jobId);
    if (!job || job.status === "COMPLETED") return;
    await this.store.append("REPLAY_PAUSED", job.exercise_id, { job_id: jobId }, opts);
  }

  async resume(jobId, opts = {}) {
    const job = this.store.job(jobId);
    if (!job) throw new Error(`作业不存在:${jobId}`);
    if (job.status !== "PAUSED") throw new Error(`作业状态为 ${job.status}，不可恢复`);
    await this.store.append("REPLAY_RESUMED", job.exercise_id, { job_id: jobId }, opts);
  }

  // 运行作业直到完成或被暂停。可在任意时刻重复调用（恢复续跑）。
  // hooks.onProcess 在每条事件处理完成后触发，可用于确定性暂停或观测进度。
  async runJob(jobId, hooks = {}) {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    while (true) {
      const job = this.store.job(jobId);
      if (!job) throw new Error(`作业不存在:${jobId}`);
      if (job.status === "COMPLETED") return job;
      if (job.status === "PAUSED") return job;

      let advanced = false;
      shardLoop:
      for (const shardPlan of job.plan) {
        const shard = String(shardPlan.shard);
        let cursor = job.cursors[shard] ?? 0;
        while (cursor < shardPlan.claim_ids.length) {
          await tick(); // 让暂停事件有机会进入日志
          const live = this.store.job(jobId);
          if (live.status === "PAUSED") return live;

          const claimId = shardPlan.claim_ids[cursor];
          await this._processOne(job, claimId);
          cursor += 1;
          advanced = true;
          await this.store.append("REPLAY_CHECKPOINT", job.exercise_id, {
            job_id: jobId,
            shard: shardPlan.shard,
            cursor,
            processed: live.processed,
            skipped: live.skipped,
          });
          if (hooks.onProcess) await hooks.onProcess(this.store.job(jobId));
          if (cursor >= shardPlan.claim_ids.length) break shardLoop;
        }
      }

      const live = this.store.job(jobId);
      const allDone = live.plan.every(
        (s) => (live.cursors[String(s.shard)] ?? 0) >= s.claim_ids.length,
      );
      if (allDone) {
        await this.store.append("REPLAY_COMPLETED", live.exercise_id, {
          job_id: jobId,
          processed: live.processed,
          skipped: live.skipped,
        });
        return this.store.job(jobId);
      }
      if (!advanced) return live; // 无进展（理论不可达），避免忙等
    }
  }

  async _processOne(job, claimId) {
    const entry = this.store.state.claims.get(claimId);
    const refs = this.resolveRefsForDate(job.refs, entry.claim);
    const result = replayClaim(entry.claim, refs, this.registry);
    const key = comparisonIdempotencyKey(entry.claim, result);
    const current = this.store.effectiveComparison(claimId);
    if (current && current.idempotency_key === key) {
      // 依赖未变：重复进入只保留原比较，记一次跳过，不写新事件。
      this.store.job(job.job_id).skipped += 1;
      return;
    }
    this.store.job(job.job_id).processed += 1;
    await this.store.append("COMPARISON_PRODUCED", entry.claim.region, {
      job_id: job.job_id,
      claim_id: claimId,
      claim_hash: entry.claim_hash,
      idempotency_key: key,
      supersedes_event_id: current?.event_id ?? null,
      incumbent: result.incumbent,
      candidate: result.candidate,
      diffs: result.diffs,
      deps: result.deps,
    });
  }
}
