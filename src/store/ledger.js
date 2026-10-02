// 只追加账本：所有状态变化先以事件形式落盘（fsync），再交给 reducer 回放。
// 进程重启时从头重放即可恢复全部状态，天然支持"暂停后关机、稍后续跑"。
//
// 账本文件本身必须位于获准环境目录内（由 enclave.assertWithinEnclave 兜底），
// 不与真实结算库共享任何存储位置。

import { mkdirSync, openSync, closeSync, writeSync, fsyncSync, readFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { validateEvent } from "../domain/events.js";
import { EnclaveViolation, ConflictError } from "../domain/errors.js";
import { assertWithinEnclave } from "../domain/enclave.js";

const LEDGER_FILE = "events.jsonl";
const TMP_SUFFIX = ".tmp";

export class Ledger {
  constructor(rootDir) {
    this.rootDir = path.resolve(rootDir);
    // 根目录之外或伪装成真实/患者通道的路径一律拒绝。
    assertWithinEnclave(".", this.rootDir);
    this.dir = path.join(this.rootDir, "ledger");
    this.file = path.join(this.dir, LEDGER_FILE);
    this._seenIds = new Set();
  }

  ensure() {
    mkdirSync(this.dir, { recursive: true });
    return this;
  }

  load() {
    if (!existsSync(this.file)) return [];
    const raw = readFileSync(this.file, "utf8");
    const records = [];
    raw.split("\n").forEach((line, idx) => {
      if (!line.trim()) return;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (cause) {
        throw new Error(`账本第 ${idx + 1} 行损坏，无法安全启动: ${cause.message}`);
      }
      const problems = validateEvent(rec);
      if (problems.length) throw new Error(`账本第 ${idx + 1} 行不符合信封约定: ${problems.join(",")}`);
      if (this._seenIds.has(rec.event_id)) {
        throw new Error(`账本事件 ID 重复: ${rec.event_id}`);
      }
      this._seenIds.add(rec.event_id);
      records.push(rec);
    });
    return records;
  }

  hasEvent(eventId) {
    return this._seenIds.has(eventId);
  }

  // 同步追加 + fsync：单进程内串行，进程崩溃也只会丢未提交的最后半行——
  // 启动时遇到无换行结尾的残行会被拒绝截断（见 recoverTruncatedTail）。
  append(record) {
    const problems = validateEvent(record);
    if (problems.length) {
      throw new EnclaveViolation(`拒写账本：信封字段不合法 ${problems.join(",")}`);
    }
    if (this._seenIds.has(record.event_id)) {
      throw new ConflictError("账本事件已存在（幂等拦截）", { event_id: record.event_id });
    }
    this.ensure();
    const line = `${JSON.stringify(record)}\n`;
    const fd = openSync(this.file, "a");
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this._seenIds.add(record.event_id);
    return record;
  }

  // 仅在运维明确要求时，把最后一行未写完的残段截掉（正常关闭不会用到）。
  recoverTruncatedTail() {
    if (!existsSync(this.file)) return false;
    const raw = readFileSync(this.file, "utf8");
    if (raw.length === 0 || raw.endsWith("\n")) return false;
    const lastBreak = raw.lastIndexOf("\n");
    const good = raw.slice(0, lastBreak + 1);
    const tmp = `${this.file}${TMP_SUFFIX}`;
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, good);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    return true;
  }
}
