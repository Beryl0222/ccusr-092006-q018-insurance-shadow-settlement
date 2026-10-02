// 冻结快照：国家目录版本、本地旧目录版本、地区映射、支付限制、样例费率
// 在一个不可变快照里整体冻结。快照内容完全由输入决定——相同内容必然得到
// 相同 snapshot_id（内容寻址），任何部分被替换都会改变指纹。

import { hashJson } from "./hash.js";
import { ValidationError, ConflictError, NotFoundError } from "./errors.js";

const TRACKS = new Set(["current", "candidate"]);
const RULE_TYPES = new Set(["scope", "mutually_exclusive", "max_quantity"]);

function parseDate(value, label) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ValidationError(`${label} 不是合法时间`, { value });
  return new Date(t).toISOString();
}

function windowsOverlap(a, b) {
  // 半开区间 [valid_from, valid_to)；缺省端点视为无限远。
  const aFrom = a.valid_from ? Date.parse(a.valid_from) : -Infinity;
  const aTo = a.valid_to ? Date.parse(a.valid_to) : Infinity;
  const bFrom = b.valid_from ? Date.parse(b.valid_from) : -Infinity;
  const bTo = b.valid_to ? Date.parse(b.valid_to) : Infinity;
  return aFrom < bTo && bFrom < aTo;
}

// 同一 key 下的生效区间不允许重叠——按就医发生时点重放时必须能唯一定位。
function assertNoOverlap(entries, keyOf, label) {
  const groups = new Map();
  for (const e of entries) {
    const k = keyOf(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  for (const [key, list] of groups) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (windowsOverlap(list[i], list[j])) {
          throw new ConflictError(`${label} 存在生效区间重叠，无法按就医时点唯一确定`, {
            key,
            a: list[i].id,
            b: list[j].id,
          });
        }
      }
    }
  }
}

function freezeCatalog(input, label) {
  if (!input || typeof input !== "object") throw new ValidationError(`缺少${label}`);
  const { version, effective_from } = input;
  if (!version) throw new ValidationError(`${label} 缺少版本号`);
  const items = Array.isArray(input.items) ? input.items : [];
  const seen = new Set();
  const normalized = items.map((raw) => {
    const code = String(raw.code ?? "");
    if (!/^[0-9A-Za-z][0-9A-Za-z.\-]{0,31}$/.test(code)) {
      throw new ValidationError(`${label} 项目编码不合法`, { code });
    }
    if (seen.has(code)) throw new ConflictError(`${label} 项目编码重复`, { code });
    seen.add(code);
    return { code, name: raw.name ? String(raw.name) : code };
  });
  return {
    version: String(version),
    effective_from: parseDate(effective_from ?? "1970-01-01", `${label} 生效时间`),
    codes: normalized.map((i) => i.code),
    items: normalized,
  };
}

function freezeMappings(input, nationalCodes, localCodes) {
  if (!Array.isArray(input)) throw new ValidationError("mappings 必须是数组");
  const list = input.map((raw) => {
    const local_code = String(raw.local_code ?? "");
    const national_code = String(raw.national_code ?? "");
    if (!localCodes.has(local_code)) {
      throw new ValidationError("映射的本地编码不在本地目录中", { local_code });
    }
    if (!nationalCodes.has(national_code)) {
      throw new ValidationError("映射的国家编码不在国家目录中", { national_code });
    }
    const mapping_id = raw.mapping_id ?? `map_${hashJson([local_code, national_code]).slice(0, 10)}`;
    return {
      mapping_id: String(mapping_id),
      local_code,
      national_code,
      expert: Boolean(raw.expert),
      basis: raw.basis ? String(raw.basis) : null,
    };
  });
  // 同一本地编码可存在多条候选映射（多对多情形），由重放引擎判定为组合/映射冲突。
  const ids = new Set();
  for (const m of list) {
    if (ids.has(m.mapping_id)) throw new ConflictError("映射 ID 重复", { mapping_id: m.mapping_id });
    ids.add(m.mapping_id);
  }
  return list;
}

function freezeRestrictions(input, nationalCodes, localCodes) {
  if (!Array.isArray(input)) throw new ValidationError("restrictions 必须是数组");
  return input.map((raw, idx) => {
    const id = raw.id ? String(raw.id) : `rule_${idx + 1}`;
    const track = raw.track ?? "candidate";
    if (!TRACKS.has(track)) throw new ValidationError("支付限制 track 必须是 current/candidate", { id });
    const rule_type = raw.rule_type ?? "scope";
    if (!RULE_TYPES.has(rule_type)) throw new ValidationError("不支持的规则类型", { id, rule_type });
    const codes = (raw.codes ?? (raw.code ? [raw.code] : [])).map(String);
    const catalog = track === "current" ? localCodes : nationalCodes;
    for (const code of codes) {
      if (!catalog.has(code)) throw new ValidationError("规则引用的编码不在对应目录中", { id, code, track });
    }
    if (rule_type === "scope" && codes.length !== 1) {
      throw new ValidationError("scope 规则必须且只能引用一个编码", { id });
    }
    if (rule_type === "mutually_exclusive" && codes.length < 2) {
      throw new ValidationError("互斥规则至少需要两个编码", { id });
    }
    if (rule_type === "max_quantity" && !(Number(raw.max_quantity) > 0)) {
      throw new ValidationError("max_quantity 规则缺少正数上限", { id });
    }
    const entry = {
      id,
      track,
      rule_type,
      codes,
      scope: raw.scope === "excluded" ? "excluded" : "included",
      facility_levels: raw.facility_levels ?? ["*"],
      max_quantity: rule_type === "max_quantity" ? Number(raw.max_quantity) : null,
      valid_from: raw.valid_from ? parseDate(raw.valid_from, `规则 ${id} valid_from`) : null,
      valid_to: raw.valid_to ? parseDate(raw.valid_to, `规则 ${id} valid_to`) : null,
      basis: raw.basis ? String(raw.basis) : `规则 ${id}`,
    };
    if (entry.valid_from && entry.valid_to && Date.parse(entry.valid_from) >= Date.parse(entry.valid_to)) {
      throw new ValidationError("规则生效区间不合法（起点须早于终点）", { id });
    }
    return entry;
  });
}

function freezeRates(input, nationalCodes, localCodes) {
  if (!Array.isArray(input)) throw new ValidationError("sample_rates 必须是数组");
  const list = input.map((raw, idx) => {
    const id = raw.id ? String(raw.id) : `rate_${idx + 1}`;
    const track = raw.track ?? "candidate";
    if (!TRACKS.has(track)) throw new ValidationError("费率 track 必须是 current/candidate", { id });
    const code = String(raw.code ?? "");
    const catalog = track === "current" ? localCodes : nationalCodes;
    if (!catalog.has(code)) throw new ValidationError("样例费率引用的编码不在对应目录中", { id, code });
    const rate = Number(raw.rate);
    if (!(rate >= 0)) throw new ValidationError("样例费率必须是非负数", { id });
    const entry = {
      id,
      track,
      code,
      facility_level: raw.facility_level ?? "*",
      rate: Math.round(rate * 100) / 100,
      valid_from: raw.valid_from ? parseDate(raw.valid_from, `费率 ${id} valid_from`) : null,
      valid_to: raw.valid_to ? parseDate(raw.valid_to, `费率 ${id} valid_to`) : null,
      basis: raw.basis ? String(raw.basis) : `样例费率 ${id}`,
    };
    if (entry.valid_from && entry.valid_to && Date.parse(entry.valid_from) >= Date.parse(entry.valid_to)) {
      throw new ValidationError("费率生效区间不合法", { id });
    }
    return entry;
  });
  assertNoOverlap(list, (r) => `${r.track}|${r.code}|${r.facility_level}`, "样例费率");
  return list;
}

// 冻结一个候选基线快照。
export function freezeSnapshot(input, { frozenAt = new Date().toISOString(), createdBy = "shadow-system" } = {}) {
  if (!input || typeof input !== "object") throw new ValidationError("冻结输入必须是对象");
  const region = String(input.region ?? "");
  if (!/^[0-9A-Za-z][0-9A-Za-z\-_]{0,15}$/.test(region)) {
    throw new ValidationError("地区代码不合法", { region });
  }
  const national = freezeCatalog(input.national_catalog, "国家目录");
  const local = freezeCatalog(input.local_catalog, "本地目录");
  const nationalCodes = new Set(national.codes);
  const localCodes = new Set(local.codes);
  const mappings = freezeMappings(input.mappings ?? [], nationalCodes, localCodes);
  const restrictions = freezeRestrictions(input.restrictions ?? [], nationalCodes, localCodes);
  assertNoOverlap(
    restrictions.filter((r) => r.rule_type === "scope"),
    (r) => `${r.track}|${r.codes[0]}|${r.facility_levels.join(",")}`,
    "支付范围规则",
  );
  const rates = freezeRates(input.sample_rates ?? [], nationalCodes, localCodes);

  const body = {
    region,
    national,
    local,
    mappings,
    restrictions,
    rates,
  };
  const content_hash = hashJson(body);
  return Object.freeze({
    snapshot_id: `snap_${content_hash.slice(0, 12)}`,
    parent_snapshot_id: null,
    revision: 0,
    region,
    frozen_at: parseDate(frozenAt, "frozenAt"),
    created_by: createdBy,
    ...body,
    content_hash,
  });
}

// 专家补充映射：从父快照派生子快照，除映射外全部继承，指纹随之改变。
export function reviseMappings(parent, revision, { add = [], retire = [], note = null, by = "expert", frozenAt = new Date().toISOString() } = {}) {
  if (!parent) throw new NotFoundError("父快照不存在");
  const nationalCodes = new Set(parent.national.codes);
  const localCodes = new Set(parent.local.codes);

  const retireIds = new Set(retire.map(String));
  const surviving = parent.mappings.filter((m) => !retireIds.has(m.mapping_id));
  const additions = freezeMappings(add, nationalCodes, localCodes).map((m) => ({ ...m, expert: true }));

  // 与现存映射完全等价的补充是无害的幂等操作，但同一专家重复提交不应膨胀快照。
  const existingKeys = new Set(surviving.map((m) => `${m.local_code}->${m.national_code}`));
  const merged = [...surviving];
  for (const m of additions) {
    const key = `${m.local_code}->${m.national_code}`;
    if (!existingKeys.has(key)) {
      merged.push(m);
      existingKeys.add(key);
    }
  }

  const body = {
    region: parent.region,
    national: parent.national,
    local: parent.local,
    mappings: merged,
    restrictions: parent.restrictions,
    rates: parent.rates,
  };
  const content_hash = hashJson(body);
  return Object.freeze({
    snapshot_id: `snap_${content_hash.slice(0, 12)}`,
    parent_snapshot_id: parent.snapshot_id,
    revision: parent.revision + 1,
    region: parent.region,
    frozen_at: parseDate(frozenAt, "frozenAt"),
    created_by: by,
    revision_note: note,
    ...body,
    content_hash,
  });
}

// 计算一条映射修订相对父快照真正变化的 (local_code -> 目标集合)，
// 供增量重算圈定受影响事件。
export function mappingDelta(parent, child) {
  const index = (snap) => {
    const map = new Map();
    for (const m of snap.mappings) {
      if (!map.has(m.local_code)) map.set(m.local_code, new Set());
      map.get(m.local_code).add(m.national_code);
    }
    return map;
  };
  const before = index(parent);
  const after = index(child);
  const changedLocalCodes = new Set();
  for (const [code, set] of after) {
    const old = before.get(code);
    if (!old || old.size !== set.size || [...set].some((c) => !old.has(c))) changedLocalCodes.add(code);
  }
  for (const code of before.keys()) if (!after.has(code)) changedLocalCodes.add(code);
  return changedLocalCodes;
}
