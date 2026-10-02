// 影子结算账本事件类型与最小信封校验。
//
// 账本只追加、不可变；状态由这些事件回放得到（见 store/reducer.js）。

export const EVENT_KINDS = Object.freeze([
  // 领域资料中已有的五类事件（名称保持稳定）
  "CATALOG_FROZEN", // 冻结一个候选基线快照（国家目录/本地目录/映射/限制/样例费率）
  "CLAIM_REPLAYED", // 单条历史事件在某快照下完成一次双轨比较
  "DIFF_CLASSIFIED", // 差异被归类（比较记录内联分类，该事件用于对外通知/留痕）
  "MAPPING_REVISED", // 专家补充映射，生成子快照
  "RELEASE_SIGNED", // 候选版本通过全部门槛后签署发布资格
  // 影子后端新增的内部事件
  "HISTORY_INGESTED", // 脱敏历史结算事件进入获准环境（幂等）
  "JOB_CREATED", // 创建分片重放作业（基线全量 / 修订增量）
  "JOB_PAUSED", // 协作式暂停
  "JOB_RESUMED", // 恢复（含进程重启后续跑）
  "SHARD_LEASED", // 工作者租约某个分片
  "SHARD_CHECKPOINT", // 分片游标推进
  "SHARD_COMPLETED", // 分片完成
  "JOB_COMPLETED", // 全部分片完成
  "REVIEW_PLANNED", // 生成确定性分层抽样计划
  "REVIEW_RECORDED", // 记录一条人工抽样复核
  "REGION_SIGNED", // 地区对具体快照哈希签署
  "RELEASE_CAMPAIGN_CREATED", // 多地区联合发布活动
]);

export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = [];
  if (record === null || typeof record !== "object") return ["record"];
  for (const name of REQUIRED_FIELDS) if (!(name in record)) problems.push(name);
  if ("kind" in record && !EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}

// 系统事件使用的固定主体，绝不与患者标识混用。
export const SYSTEM_SUBJECT = "shadow-system";
