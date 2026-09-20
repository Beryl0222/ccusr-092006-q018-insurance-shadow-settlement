// insurance_shadow_settlement 领域资料的基础结构。

export const EVENT_KINDS = Object.freeze(["CATALOG_FROZEN", "CLAIM_REPLAYED", "DIFF_CLASSIFIED", "MAPPING_REVISED", "RELEASE_SIGNED"]);
export const REQUIRED_FIELDS = Object.freeze(["event_id", "kind", "occurred_at", "subject_id", "payload"]);

export function validateEvent(record) {
  const problems = REQUIRED_FIELDS.filter((name) => !(name in record));
  if (!EVENT_KINDS.includes(record.kind)) problems.push("kind");
  return problems;
}
