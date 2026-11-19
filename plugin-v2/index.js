// V2 package entry. The shared core file default-exports the V1 FUNCTION
// (v1.19.3 only loads function entries), and v2 only loads OBJECT entries —
// so this directory adapts: build the { id, setup } object from the
// properties the core attaches to its function export.
import plugin from "../plugins/toolcall-guard.js"
import { setupLanes } from "./setup-lanes.js"
import { setupPreflight } from "./preflight.js"
import { setupBinary } from "./binary.js"
import { setupSubreport } from "./subreport.js"
import { setupConfab } from "./confab.js"
import { setupAudit } from "./audit.js"
import { setupJanitor } from "./janitor.js"

export default {
  id: "toolcall-guard",
  setup: ctx => setupLanes(ctx, plugin.__test, [plugin.setup, setupPreflight, setupBinary, setupSubreport, setupConfab, setupAudit, setupJanitor]),
}
