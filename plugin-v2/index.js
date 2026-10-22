// V2 package entry. The shared core file default-exports the V1 FUNCTION
// (v1.19.3 only loads function entries), and v2 only loads OBJECT entries —
// so this directory adapts: build the { id, setup } object from the
// properties the core attaches to its function export.
import plugin from "../plugins/toolcall-guard.js"

export default {
  id: "toolcall-guard",
  setup: plugin.setup,
}
