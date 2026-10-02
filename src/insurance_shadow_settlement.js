// 保险影子结算领域资料入口（向后兼容）。
// 完整事件类型与校验已迁入 domain/events.js，此处保持原有导出名稳定。
export { EVENT_KINDS, REQUIRED_FIELDS, validateEvent, SYSTEM_SUBJECT } from "./domain/events.js";
