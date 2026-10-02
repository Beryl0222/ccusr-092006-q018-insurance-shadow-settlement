// 冻结层：目录版本、地区映射、支付限制与样例费率一律不可变，
// 以内容哈希作为身份；重放只按引用读取冻结快照，演练过程中任何修改都产生新版本。

import { createHash } from "node:crypto";
import { ARTIFACT_TYPES, SIDES } from "./insurance_shadow_settlement.js";

export function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]),
    );
  }
  return value;
}

export function hashContent(content) {
  return "sha256:" + createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export class FrozenArtifact {
  constructor({ artifact_type, side, region, version, content, frozen_at, effective_from, effective_to, note }) {
    if (!ARTIFACT_TYPES.includes(artifact_type)) throw new Error(`未知冻结对象类型:${artifact_type}`);
    if (!SIDES.includes(side)) throw new Error(`未知侧别:${side}`);
    if (!version) throw new Error("version 缺失");
    this.artifact_type = artifact_type;
    this.side = side;
    this.region = region;            // "NATIONAL" 或地区码
    this.version = version;          // 业务版本号（候选目录递增）
    this.content = content;
    this.frozen_at = frozen_at;
    this.effective_from = effective_from; // 生效起点（ISO 字符串）
    this.effective_to = effective_to ?? null; // 生效终点（闭区间，null 表示仍有效）
    this.note = note ?? "";
    // 哈希只覆盖业务内容与身份，生效区间是时间线元数据：同一内容挂到不同区间仍是同一份快照。
    this.content_hash = hashContent({ artifact_type, side, region, version, content });
    Object.freeze(this);
    Object.freeze(content);
  }
}

// 冻结注册表：只追加、按 (类型, 侧别, 地区) 维护版本时间线。
export class FreezeRegistry {
  constructor() {
    this._artifacts = new Map(); // content_hash -> FrozenArtifact
    this._timelines = new Map(); // key -> FrozenArtifact[]（按 effective_from 排序）
  }

  static _key(type, side, region) {
    return `${type}|${side}|${region}`;
  }

  put(input, { timeline: useTimeline = true } = {}) {
    const artifact = input instanceof FrozenArtifact ? input : new FrozenArtifact(input);
    if (this._artifacts.has(artifact.content_hash)) return artifact; // 同内容幂等
    this._artifacts.set(artifact.content_hash, artifact);
    if (!useTimeline) return artifact; // 仅按哈希引用的快照（如映射修订），不参与生效时间线
    const key = FreezeRegistry._key(artifact.artifact_type, artifact.side, artifact.region);
    const timeline = this._timelines.get(key) ?? [];
    const overlap = timeline.find(
      (a) => a.effective_from <= (artifact.effective_to ?? "9999") &&
             (a.effective_to ?? "9999") >= artifact.effective_from,
    );
    if (overlap) {
      throw new Error(
        `冻结区间与既有版本 ${overlap.version}(${overlap.effective_from}~${overlap.effective_to ?? "∞"})冲突`,
      );
    }
    timeline.push(artifact);
    timeline.sort((a, b) => (a.effective_from < b.effective_from ? -1 : 1));
    this._timelines.set(key, timeline);
    this._artifacts.set(artifact.content_hash, artifact);
    return artifact;
  }

  get(contentHash) {
    const artifact = this._artifacts.get(contentHash);
    if (!artifact) throw new Error(`冻结对象不存在:${contentHash}`);
    return artifact;
  }

  has(contentHash) {
    return this._artifacts.has(contentHash);
  }

  // 按就医发生时点选择当时有效的版本；时点落空窗时抛错（不允许借用未来版本）。
  effectiveAt(type, side, region, when) {
    const timeline = this._timelines.get(FreezeRegistry._key(type, side, region));
    const found = timeline?.find(
      (a) => a.effective_from <= when && (a.effective_to === null || a.effective_to >= when),
    );
    if (!found) throw new Error(`${when} 时 ${type}/${side}/${region} 无有效冻结版本`);
    return found;
  }

  versions(type, side, region) {
    return [...(this._timelines.get(FreezeRegistry._key(type, side, region)) ?? [])];
  }

  list() {
    return [...this._artifacts.values()];
  }
}
