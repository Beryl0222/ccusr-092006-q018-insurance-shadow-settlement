import assert from "node:assert/strict";
import test from "node:test";
import { freezeSnapshot, reviseMappings, mappingDelta } from "../src/domain/catalog.js";
import { ValidationError, ConflictError } from "../src/domain/errors.js";
import { standardSnapshotInput } from "./helpers/fixtures.js";

test("冻结：相同内容得到相同内容指纹", () => {
  const a = freezeSnapshot(standardSnapshotInput());
  const b = freezeSnapshot(standardSnapshotInput(), { frozenAt: "2026-09-10T00:00:00Z" });
  assert.equal(a.content_hash, b.content_hash);
  assert.equal(a.snapshot_id, b.snapshot_id);
  assert.equal(a.revision, 0);
  assert.equal(a.parent_snapshot_id, null);
});

test("冻结：任一组成部分变化都会改变指纹", () => {
  const base = freezeSnapshot(standardSnapshotInput());
  const changed = freezeSnapshot(standardSnapshotInput({
    sample_rates: [
      ...standardSnapshotInput().sample_rates,
      { id: "rate-n02", track: "candidate", code: "N02", facility_level: "t3", rate: 70 },
    ],
  }));
  assert.notEqual(base.content_hash, changed.content_hash);
});

test("冻结：映射引用目录外编码被拒", () => {
  assert.throws(
    () => freezeSnapshot(standardSnapshotInput({
      mappings: [...standardSnapshotInput().mappings, { local_code: "L01", national_code: "NOPE" }],
    })),
    ValidationError,
  );
});

test("冻结：费率/范围生效区间重叠被拒（保证按就医时点唯一定位）", () => {
  const input = standardSnapshotInput();
  assert.throws(() => freezeSnapshot(standardSnapshotInput({
    sample_rates: [
      ...input.sample_rates,
      { id: "dup", track: "candidate", code: "N01", facility_level: "t3", rate: 99, valid_from: "2026-01-01", valid_to: "2026-12-31" },
    ],
  })), ConflictError);
});

test("冻结：不同费率版本可以在不同就医时点各自生效（半开区间不重叠）", () => {
  const snap = freezeSnapshot(standardSnapshotInput({
    sample_rates: [
      { id: "old", track: "candidate", code: "N01", facility_level: "t3", rate: 10, valid_from: "2025-01-01", valid_to: "2026-06-30" },
      { id: "new", track: "candidate", code: "N01", facility_level: "t3", rate: 20, valid_from: "2026-07-01" },
    ],
  }));
  const n01rates = snap.rates.filter((r) => r.code === "N01");
  assert.equal(n01rates.length, 2);
});

test("修订：专家补充映射派生内容寻址子快照", () => {
  const parent = freezeSnapshot(standardSnapshotInput());
  const child = reviseMappings(parent, 1, {
    add: [{ local_code: "L05", national_code: "N01", basis: "专家补充 L05→N01", expert: true }],
  });
  assert.equal(child.parent_snapshot_id, parent.snapshot_id);
  assert.equal(child.revision, 1);
  assert.notEqual(child.content_hash, parent.content_hash);
  assert.equal(child.mappings.length, parent.mappings.length + 1);
  // 目录/限制/费率原样继承
  assert.equal(child.national.version, parent.national.version);
  assert.deepEqual(child.restrictions, parent.restrictions);
});

test("修订：变化集合精确到受影响的本地编码", () => {
  const parent = freezeSnapshot(standardSnapshotInput());
  const child = reviseMappings(parent, 1, { add: [{ local_code: "L05", national_code: "N02" }] });
  const delta = mappingDelta(parent, child);
  assert.deepEqual([...delta], ["L05"]);
  // 无实质变化的再修订 -> 空 delta
  const sameAgain = reviseMappings(child, 2, { add: [{ local_code: "L05", national_code: "N02" }] });
  assert.deepEqual([...mappingDelta(child, sameAgain)], []);
});

test("冻结：不可变", () => {
  const snap = freezeSnapshot(standardSnapshotInput());
  assert.throws(() => {
    snap.region = "HACK";
  }, TypeError);
});
