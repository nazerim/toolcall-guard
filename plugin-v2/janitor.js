import { appendFile, lstat, open, opendir, realpath, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

// Opt-in V2 spill janitor. Verified against OpenCode 2.3.2 (installed binary
// strings + source f870161, packages/core/src/tool-output.ts):
//   <XDG_DATA_HOME|~/.local/share>/opencode/tool-output/tool_<id>[.<ext>]
// written in ONE call (writeFileString / writeWithDirs) before the path is
// published, with native 7-day retention swept hourly. The id is
// Identifier.create(false): 12 hex chars = low 48 bits of ts*4096+counter,
// then 14 base62 chars. This lane only removes such files earlier when they
// are huge AND old AND their id timestamp matches their mtime (provenance).
// Shell captures (<data>/opencode/shell/<project>/sh_*.out) are streamed
// while the command runs and the plugin API exposes no liveness signal for
// them, so they are never touched; native retention covers them.
//
// TOOLCALL_GUARD_JANITOR=1 deletes, =dry only counts; anything else is off.
// TOOLCALL_GUARD=off dominates. Thresholds are fixed (legacy V1 values).
export const MIN_BYTES = 1e9 // strictly larger
export const MIN_AGE_MS = 24 * 3600e3
const NAME = /^tool_([0-9a-f]{12})[0-9A-Za-z]{14}(?:\.[A-Za-z0-9]{1,16})?$/
const ID_WRAP = 2 ** 36 // ms timestamp bits that survive the 48-bit id
const ID_LAG_MS = 15 * 60e3 // id minted before the single write completes
const ID_SKEW_MS = 5e3
const MAX_SCAN = 5000 // directory entries examined per sweep
const MAX_DELETE = 20 // deletions per sweep
const INTERVAL_MS = 6 * 3600e3 // cross-process / cross-location throttle
const CLAIM = "toolcall-guard.janitor.claim"
const sweeps = new Map() // in-process dedup across locations, keyed by real dir

export function idMatchesTime(name, timeMs) {
  const m = NAME.exec(name)
  if (!m) return false
  const idTime = Number(BigInt("0x" + m[1]) >> 12n)
  const lag = (((Math.floor(timeMs) % ID_WRAP) - idTime) % ID_WRAP + ID_WRAP) % ID_WRAP
  return lag <= ID_LAG_MS || lag >= ID_WRAP - ID_SKEW_MS
}

export const spillDir = () =>
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "tool-output")

// The directory itself and every ancestor must be real (no symlink), owned
// by us and not writable by others; otherwise the whole sweep is refused.
async function trustedDir(dir) {
  const abs = resolve(dir)
  if ((await realpath(abs)) !== abs) return "symlinked-path"
  const uid = process.getuid?.()
  for (const d of [abs, resolve(abs, "..")]) {
    const st = await lstat(d)
    if (!st.isDirectory()) return "not-directory"
    if (uid !== undefined && st.uid !== uid) return "foreign-owner"
    if (st.mode & 0o022) return "shared-writable"
  }
  return null
}

async function claim(dataDir, now) {
  const file = join(dataDir, CLAIM)
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await (await open(file, "wx", 0o600)).close()
      return true
    } catch (err) {
      if (err?.code !== "EEXIST") return false
      const st = await lstat(file).catch(() => null)
      if (!st?.isFile() || now - st.mtimeMs < INTERVAL_MS) return false
      await unlink(file).catch(() => {})
    }
  }
  return false
}

export async function sweep(dir, { dryRun = false, now = Date.now(), aborted = () => false } = {}) {
  const r = { scanned: 0, matched: 0, deleted: 0, bytes: 0, skipped: {} }
  const skip = (why) => { r.skipped[why] = (r.skipped[why] || 0) + 1 }
  let dirStat
  try {
    const refused = await trustedDir(dir)
    if (refused) return { ...r, refused }
    dirStat = await lstat(dir)
  } catch (err) {
    return { ...r, refused: err?.code === "ENOENT" ? "absent" : "unreadable" }
  }
  const uid = process.getuid?.()
  const eligible = []
  let handle
  try {
    handle = await opendir(dir)
    for await (const ent of handle) {
      if (++r.scanned > MAX_SCAN) { r.capped = true; break }
      if (!NAME.test(ent.name)) continue
      r.matched++
      const st = await lstat(join(dir, ent.name)).catch(() => null)
      if (!st) skip("vanished")
      else if (!st.isFile()) skip(st.isSymbolicLink() ? "symlink" : "not-file")
      else if (uid !== undefined && st.uid !== uid) skip("foreign-owner")
      else if (st.nlink !== 1) skip("hardlinked")
      else if (!(st.size > MIN_BYTES)) skip("small")
      else if (!(now - st.mtimeMs > MIN_AGE_MS)) skip("recent")
      else if (!idMatchesTime(ent.name, st.mtimeMs)) skip("provenance")
      else eligible.push([ent.name, st])
    }
  } catch {
    r.error = "scan"
  } finally {
    await handle?.close().catch(() => {})
  }
  for (const [name, st] of eligible) {
    if (r.deleted >= MAX_DELETE) { r.capped = true; break }
    if (aborted()) { r.aborted = true; break }
    if (dryRun) { r.deleted++; r.bytes += st.size; continue }
    const file = join(dir, name)
    try {
      // Revalidate immediately before unlink: same directory and same,
      // unchanged inode (a rewrite or swap aborts this file).
      const d = await lstat(dir)
      const now2 = await lstat(file)
      if (d.ino !== dirStat.ino || d.dev !== dirStat.dev || !now2.isFile() || now2.ino !== st.ino ||
          now2.dev !== st.dev || now2.size !== st.size || now2.mtimeMs !== st.mtimeMs || now2.nlink !== 1) {
        skip("changed")
        continue
      }
      await unlink(file)
      r.deleted++
      r.bytes += st.size
    } catch {
      skip("unlink-failed")
    }
  }
  return r
}

export async function setupJanitor(ctx, helpers) {
  const flag = process.env.TOOLCALL_GUARD_JANITOR?.toLowerCase()
  if (process.env.TOOLCALL_GUARD?.toLowerCase() === "off" || !["1", "dry"].includes(flag)) return
  const dryRun = flag === "dry"
  const dataDir = helpers.DATA_DIR()
  let stopped = false
  const log = (rec) => appendFile(join(dataDir, "toolcall-guard.janitor"),
    JSON.stringify({ at: new Date().toISOString(), mode: dryRun ? "dry" : "delete", ...rec }) + "\n",
    { mode: 0o600 }).catch(() => {})
  const run = async () => {
    const dir = spillDir()
    const key = `${dryRun}:${await realpath(dir).catch(() => resolve(dir))}`
    if (sweeps.has(key)) return sweeps.get(key)
    const job = (async () => {
      const now = Date.now()
      if (!dryRun && !(await claim(dataDir, now))) return
      const r = await sweep(dir, { dryRun, now, aborted: () => stopped })
      await log(dryRun ? { ...r, deleted: 0, wouldDelete: r.deleted } : r)
    })().catch(() => {})
    sweeps.set(key, job)
    return job
  }
  // Never delay plugin setup: the bounded sweep runs after it returns.
  const done = Promise.resolve().then(run).catch(() => {})
  const dispose = () => { stopped = true }
  dispose.done = done
  return dispose
}
