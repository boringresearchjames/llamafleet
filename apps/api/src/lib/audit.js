import { state, saveState } from "./state.js";
import { now } from "./utils.js";

export function audit(action, details = {}) {
  state.audit.unshift({ at: now(), action, details });
  state.audit = state.audit.slice(0, 2000);
  saveState(state);
}
