// 规范化哈希：所有内容哈希、快照指纹、幂等键、确定性抽样都走这里，
// 保证不同进程/不同时间对同一内容得到完全一致的结果。

import { createHash } from "node:crypto";

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function canonicalJson(value) {
  return stableStringify(value);
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function hashJson(value) {
  return sha256Hex(stableStringify(value));
}

// 短内容指纹，用于快照 ID、比较 ID 等。
export function fingerprint(value, prefix, length = 12) {
  return `${prefix}_${hashJson(value).slice(0, length)}`;
}

// 确定性伪随机：给定种子返回 [0,1) 序列，抽样可重放。
export function seededSequence(seed) {
  let state = BigInt("0x" + sha256Hex(seed).slice(0, 16));
  return () => {
    // xorshift64*
    let x = state;
    x ^= x >> 12n;
    x ^= x << 25n;
    x ^= x >> 27n;
    state = BigInt.asUintN(64, x);
    const mixed = BigInt.asUintN(64, x * 2685821657736338717n);
    return Number(mixed) / Number(1n << 64n);
  };
}
