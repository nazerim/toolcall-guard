import assert from "node:assert/strict"
import { after, test } from "node:test"
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Disposable fixtures only: every path lives under a fresh mkdtemp root
// (realpath'd, because macOS /var is itself a symlink). Spill files are
// sparse, so "1.1 GB" costs no disk.
const root = realpathSync(mkdtempSync(join(tmpdir(), "guard-janitor-")))
after(() => rmSync(root, { recursive: true, force: true }))
const env = process.env
const saved = Object.fromEntries(["TOOLCALL_GUARD", "TOOLCALL_GUARD_JANITOR", "XDG_DATA_HOME"].map((k) => [k, env[k]]))
after(() => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete env[k] : (env[k] = v) })

const BIG = 1_100_000_000
const DAY = 86400e3
let n = 0
const fresh = () => import(`../plugin-v2/janitor.js?case=${n++}`) // new in-process dedup map = new "process"

// Same encoding as OpenCode's Identifier.create(false, ts).
let seq = 0
function id(ts) {
  const v = (BigInt(ts) * 0x1000n + BigInt(++seq % 4096)) & 0xffffffffffffn
  return "tool_" + v.toString(16).padStart(12, "0") + String(seq).padStart(14, "x")
}
function spill(dir, { ageMs = 2 * DAY, size = BIG, name, idOffsetMs = 0 } = {}) {
  const mtime = Date.now() - ageMs
  const file = join(dir, name ?? id(mtime - 1000 + idOffsetMs))
  writeFileSync(file, "")
  truncateSync(file, size)
  utimesSync(file, mtime / 1000, mtime / 1000)
  return file
}
function fixture() {
  const base = mkdtempSync(join(root, "case-"))
  const data = join(base, "xdg")
  const spills = join(data, "opencode", "tool-output")
  const logs = join(base, "guard")
  mkdirSync(spills, { recursive: true })
  mkdirSync(logs)
  env.XDG_DATA_HOME = data
  const logFile = join(logs, "toolcall-guard.janitor")
  return { base, data, spills, logs, helpers: { DATA_DIR: () => logs },
    records: () => existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [],
    rawLog: () => existsSync(logFile) ? readFileSync(logFile, "utf8") : "" }
}
async function run(f, flag, master) {
  if (flag === undefined) delete env.TOOLCALL_GUARD_JANITOR
  else env.TOOLCALL_GUARD_JANITOR = flag
  if (master === undefined) delete env.TOOLCALL_GUARD
  else env.TOOLCALL_GUARD = master
  const { setupJanitor } = await fresh()
  const dispose = await setupJanitor({}, f.helpers)
  await dispose?.done
  return dispose
}

test("off unless TOOLCALL_GUARD_JANITOR is exactly 1/dry; master off dominates", async () => {
  const f = fixture()
  const file = spill(f.spills)
  for (const [flag, master] of [[undefined], ["0"], ["off"], ["yes"], ["true"], ["1", "off"], ["dry", "OFF"]])
    assert.equal(await run(f, flag, master), undefined, `${flag}/${master}`)
  assert.ok(existsSync(file))
  assert.deepEqual(f.records(), [])
})

test("deletes only huge, old, provenance-matched closed spills; logs metadata only", async () => {
  const f = fixture()
  const yes = [spill(f.spills), spill(f.spills, { name: id(Date.now() - 3 * DAY - 2000) + ".bin", ageMs: 3 * DAY })]
  const exact = spill(f.spills, { size: 1e9 })
  const keep = [
    spill(f.spills, { size: 4096 }), // small
    exact, // not strictly larger
    spill(f.spills, { ageMs: 23 * 3600e3 }), // recent / possibly active
    spill(f.spills, { idOffsetMs: -2 * DAY }), // id minted long before mtime: touched/foreign
    spill(f.spills, { idOffsetMs: 60e3 }), // id minted after the file was written
    spill(f.spills, { name: "tool_notanidentifier1234567" }),
    spill(f.spills, { name: "model.gguf" }),
    spill(f.spills, { name: id(Date.now() - 2 * DAY) + ".partial.tmp" }),
  ]
  // Hard-linked: deleting would not free space and may be someone else's name.
  const linked = spill(f.spills)
  linkSync(linked, join(f.base, "elsewhere"))
  // Symlink with an eligible name pointing at an eligible-looking target.
  const target = spill(f.base, { name: "target" })
  const link = join(f.spills, id(Date.now() - 2 * DAY))
  symlinkSync(target, link)
  // Directory with an eligible name.
  const subdir = join(f.spills, id(Date.now() - 5 * DAY))
  mkdirSync(subdir)
  // Shell captures are never in scope, even when old and huge.
  const shell = join(f.data, "opencode", "shell", "proj")
  mkdirSync(shell, { recursive: true })
  const sh = spill(shell, { name: "sh_0123456789abXYZ.out" })
  const shTool = spill(shell)

  await run(f, "1")
  for (const p of yes) assert.ok(!existsSync(p), "eligible spill deleted")
  for (const p of [...keep, linked, target, sh, shTool, subdir]) assert.ok(existsSync(p), p)
  assert.ok(existsSync(link))
  const [rec, ...rest] = f.records()
  assert.equal(rest.length, 0)
  assert.equal(rec.mode, "delete")
  assert.equal(rec.deleted, 2)
  assert.equal(rec.bytes, 2 * BIG)
  assert.deepEqual(rec.skipped, { small: 2, recent: 1, provenance: 2, hardlinked: 1, symlink: 1, "not-file": 1 })
  assert.ok(!/tool_|sh_|\//.test(f.rawLog()), "no names or paths logged")
})

test("dry run counts but never deletes or claims", async () => {
  const f = fixture()
  const file = spill(f.spills)
  await run(f, "dry")
  assert.ok(existsSync(file))
  const [rec] = f.records()
  assert.equal(rec.mode, "dry")
  assert.equal(rec.deleted, 0)
  assert.equal(rec.wouldDelete, 1)
  assert.ok(!existsSync(join(f.logs, "toolcall-guard.janitor.claim")))
})

test("refuses symlinked spill dir, symlinked ancestor and shared-writable dir", async () => {
  const f = fixture()
  const real = join(f.base, "real-tool-output")
  mkdirSync(real)
  const file = spill(real)
  rmSync(f.spills, { recursive: true })
  symlinkSync(real, f.spills)
  await run(f, "1")
  assert.ok(existsSync(file))
  assert.equal(f.records()[0].refused, "symlinked-path")

  const g = fixture()
  const gfile = spill(g.spills)
  const alias = join(g.base, "alias-xdg")
  symlinkSync(g.data, alias)
  env.XDG_DATA_HOME = alias
  const { setupJanitor } = await fresh()
  await (await setupJanitor({}, g.helpers)).done
  assert.ok(existsSync(gfile))
  assert.equal(g.records()[0].refused, "symlinked-path")

  const h = fixture()
  const hfile = spill(h.spills)
  chmodSync(h.spills, 0o777)
  await run(h, "1")
  assert.ok(existsSync(hfile))
  chmodSync(h.spills, 0o700)
  assert.equal(h.records()[0].refused, "shared-writable")
})

test("dedups across locations in one process and throttles across processes", async () => {
  const f = fixture()
  spill(f.spills)
  env.TOOLCALL_GUARD_JANITOR = "1"
  delete env.TOOLCALL_GUARD
  const { setupJanitor } = await fresh()
  const ds = await Promise.all([1, 2, 3].map(() => setupJanitor({}, f.helpers)))
  await Promise.all(ds.map((d) => d.done))
  assert.equal(f.records().length, 1)

  const later = spill(f.spills)
  await run(f, "1") // separate "process": claim is fresh, sweep skipped
  assert.ok(existsSync(later))
  assert.equal(f.records().length, 1)

  const claim = join(f.logs, "toolcall-guard.janitor.claim")
  const old = (Date.now() - 7 * 3600e3) / 1000
  utimesSync(claim, old, old)
  await run(f, "1")
  assert.ok(!existsSync(later))
  assert.equal(f.records().length, 2)
})

test("dispose before the sweep runs prevents deletion; missing dir is quiet", async () => {
  const f = fixture()
  const file = spill(f.spills)
  env.TOOLCALL_GUARD_JANITOR = "1"
  delete env.TOOLCALL_GUARD
  const { setupJanitor } = await fresh()
  const dispose = await setupJanitor({}, f.helpers)
  dispose()
  await dispose.done
  assert.ok(existsSync(file))
  assert.equal(f.records()[0].aborted, true)

  const g = fixture()
  rmSync(g.spills, { recursive: true })
  await run(g, "1")
  assert.equal(g.records()[0].refused, "absent")
})

test("id provenance survives the 48-bit wrap", async () => {
  const { idMatchesTime } = await fresh()
  const wrap = 2 ** 36
  const ts = 7 * wrap - 1000 // id minted just before the wrap, written after it
  assert.ok(idMatchesTime(id(ts), ts + 2000))
  assert.ok(idMatchesTime(id(ts), ts - 1000)) // small clock skew
  assert.ok(!idMatchesTime(id(ts), ts + 3600e3))
  assert.ok(!idMatchesTime("tool_zz", ts))
})
