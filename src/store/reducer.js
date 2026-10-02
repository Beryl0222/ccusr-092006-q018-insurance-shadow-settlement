// 账本事件 -> 内存状态的纯回放器。
// 进程启动时把 events.jsonl 从头喂给 reduce()，即可恢复：
// 历史事件、快照、比较、作业分片、复核计划、地区签署、发布资格。

export function createInitialState() {
  return {
    history: new Map(), // event_ref -> 脱敏事件
    historyByRefHash: new Map(), // event_ref -> 内容哈希，防同号异内容
    snapshots: new Map(), // snapshot_id -> 快照
    snapshotChildren: new Map(), // parent_id -> [child_id]
    regionChains: new Map(), // region -> [snapshot_id]（冻结顺序）
    comparisons: new Map(), // `${snapshot_id}|${event_ref}` -> 比较记录
    jobs: new Map(), // job_id -> 作业（含分片运行态）
    reviewPlans: new Map(), // plan_id -> 计划
    reviews: new Map(), // review_id -> 复核记录
    signatures: new Map(), // `${region}|${snapshot_id}` -> 签署
    releases: new Map(), // release_id -> 发布资格证书
  };
}

function cmpKey(snapshotId, eventRef) {
  return `${snapshotId}|${eventRef}`;
}

export function reduce(state, event) {
  const p = event.payload ?? {};
  switch (event.kind) {
    case "HISTORY_INGESTED": {
      state.history.set(p.event.event_ref, p.event);
      state.historyByRefHash.set(p.event.event_ref, p.content_hash);
      break;
    }
    case "CATALOG_FROZEN": {
      const s = p.snapshot;
      state.snapshots.set(s.snapshot_id, s);
      if (!state.regionChains.has(s.region)) state.regionChains.set(s.region, []);
      state.regionChains.get(s.region).push(s.snapshot_id);
      break;
    }
    case "MAPPING_REVISED": {
      const s = p.snapshot;
      state.snapshots.set(s.snapshot_id, s);
      if (!state.snapshotChildren.has(p.parent_snapshot_id)) {
        state.snapshotChildren.set(p.parent_snapshot_id, []);
      }
      state.snapshotChildren.get(p.parent_snapshot_id).push(s.snapshot_id);
      break;
    }
    case "CLAIM_REPLAYED": {
      const c = p.comparison;
      state.comparisons.set(cmpKey(c.snapshot_id, c.event_ref), c);
      break;
    }
    case "JOB_CREATED": {
      state.jobs.set(p.job.job_id, structuredClone(p.job));
      break;
    }
    case "JOB_PAUSED": {
      const job = state.jobs.get(p.job_id);
      job.status = "PAUSED";
      job.paused_at = event.occurred_at;
      break;
    }
    case "JOB_RESUMED": {
      const job = state.jobs.get(p.job_id);
      job.status = "RUNNING";
      delete job.paused_at;
      job.resumed_at = event.occurred_at;
      break;
    }
    case "SHARD_LEASED": {
      const job = state.jobs.get(p.job_id);
      const shard = job.shards[p.shard];
      shard.status = "LEASED";
      shard.lease_epoch = p.epoch;
      shard.lease_owner = p.owner;
      shard.lease_until = p.lease_until;
      break;
    }
    case "SHARD_CHECKPOINT": {
      const job = state.jobs.get(p.job_id);
      const shard = job.shards[p.shard];
      shard.cursor = p.cursor;
      shard.lease_until = p.lease_until ?? shard.lease_until;
      break;
    }
    case "SHARD_COMPLETED": {
      const job = state.jobs.get(p.job_id);
      const shard = job.shards[p.shard];
      shard.status = "DONE";
      shard.cursor = p.processed;
      shard.completed_at = event.occurred_at;
      delete shard.lease_owner;
      delete shard.lease_until;
      break;
    }
    case "JOB_COMPLETED": {
      const job = state.jobs.get(p.job_id);
      job.status = "COMPLETED";
      job.completed_at = event.occurred_at;
      job.counts = p.counts;
      break;
    }
    case "DIFF_CLASSIFIED": {
      // 分类结论已内联在比较记录里；该事件仅留痕，汇总在读取时即时计算。
      break;
    }
    case "REVIEW_PLANNED": {
      state.reviewPlans.set(p.plan.plan_id, structuredClone(p.plan));
      break;
    }
    case "REVIEW_RECORDED": {
      state.reviews.set(p.review.review_id, p.review);
      const plan = state.reviewPlans.get(p.review.plan_id);
      const item = plan.items.find((i) => i.item_id === p.review.item_id);
      item.status = "REVIEWED";
      item.review_id = p.review.review_id;
      item.verdict = p.review.verdict;
      break;
    }
    case "REGION_SIGNED": {
      state.signatures.set(`${p.region}|${p.snapshot_id}`, {
        region: p.region,
        snapshot_id: p.snapshot_id,
        content_hash: p.content_hash,
        signer: p.signer,
        signed_at: event.occurred_at,
      });
      break;
    }
    case "RELEASE_SIGNED": {
      state.releases.set(p.certificate.release_id, p.certificate);
      break;
    }
    default: {
      // 未知事件不允许悄悄忽略——账本只接受白名单事件，reducer 也一样。
      throw new Error(`reducer 未实现事件类型: ${event.kind}`);
    }
  }
  return state;
}

export function replayAll(records) {
  const state = createInitialState();
  for (const rec of records) reduce(state, rec);
  return state;
}

export { cmpKey };
