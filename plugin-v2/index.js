// V2 package entry. The shared core file default-exports the V1 FUNCTION
// (v1.19.3 only loads function entries), and v2 only loads OBJECT entries —
// so this directory adapts: build the { id, setup } object from the
// properties the core attaches to its function export.
import plugin from "../plugins/toolcall-guard.js"
import { setupLanes } from "./setup-lanes.js"
import { setupStreamReport } from "./stream-report.js"
import { setupPreflight } from "./preflight.js"
import { setupBinary } from "./binary.js"
import { setupSubreport } from "./subreport.js"
import { setupConfab } from "./confab.js"
import { setupAudit } from "./audit.js"
import { setupJanitor } from "./janitor.js"

// Stream report runs FIRST: it must see the untouched response, before the
// core's http.response hook replaces the body with the guarded stream. It is
// still an ordinary (optional, TOOLCALL_GUARD=off-disableable) lane: core
// declares itself fatal explicitly, which disables the legacy positional rule.
export default {
  id: "toolcall-guard",
  setup: ctx => setupLanes(ctx, plugin.__test, [setupStreamReport, { setup: plugin.setup, fatal: true }, setupPreflight, setupBinary, setupSubreport, setupConfab, setupAudit, setupJanitor]),
}
