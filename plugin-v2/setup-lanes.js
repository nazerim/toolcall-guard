import { appendFileSync } from "node:fs"
import { join } from "node:path"

// Compose core + optional V2 setup functions. Each lane owns its flag checks
// and may return a disposer. A lane is either a function (legacy: the FIRST
// function is core — its failure fails the plugin and unwinds everything,
// later failures are logged and skipped) or a { setup, fatal } descriptor.
// If ANY lane declares fatal explicitly, the positional rule is disabled:
// only declared-fatal lanes fail the plugin; every other lane's failure is
// logged (metadata only) and skipped, with its partial registrations released.
// Registration ORDER stays as given — an observer lane that must see the
// untouched response can be optional and still run first.
const bind = (target, key) => {
  const value = target[key]
  return typeof value === "function" ? value.bind(target) : value
}

// Per-lane ctx view: tracks hook registrations and aborts event
// subscriptions so a lane that throws midway leaves nothing behind.
function trackLane(ctx) {
  const registrations = []
  const controller = new AbortController()
  // One wrapper per wrapped object, so ctx.session === ctx.session.
  const wrappers = new WeakMap()
  // Dummy proxy targets: shaped like the source only so Array.isArray holds.
  // Descriptors are reported configurable unless the dummy already has the key
  // non-configurable (array length), so the invariants hold on a frozen host.
  const mirror = (source, read) => new Proxy(Array.isArray(source) ? [] : {}, {
    get: (_, key) => read(source, key),
    has: (_, key) => key in source,
    ownKeys: () => Reflect.ownKeys(source),
    getOwnPropertyDescriptor(dummy, key) {
      const desc = Reflect.getOwnPropertyDescriptor(source, key)
      if (!desc) return undefined
      const own = Reflect.getOwnPropertyDescriptor(dummy, key)
      if (own && !own.configurable) return { ...own, value: own.writable ? read(source, key) : own.value }
      return "value" in desc ? { ...desc, value: read(source, key), configurable: true } : { ...desc, configurable: true }
    },
  })
  const wrapHook = (target) => {
    let wrapper = wrappers.get(target)
    if (wrapper) return wrapper
    wrapper = mirror(target, (obj, key) => {
      if (key === "hook" && typeof obj.hook === "function") {
        return async (...args) => {
          const registration = await obj.hook(...args)
          if (typeof registration?.dispose === "function") registrations.push(registration)
          return registration
        }
      }
      if (key === "subscribe" && typeof obj.subscribe === "function") {
        return (options, ...rest) => {
          const opts = options && typeof options === "object" ? options : {}
          const signal = opts.signal ? AbortSignal.any([opts.signal, controller.signal]) : controller.signal
          return obj.subscribe({ ...opts, signal }, ...rest)
        }
      }
      return bind(obj, key)
    })
    wrappers.set(target, wrapper)
    return wrapper
  }
  const source = ctx ?? {}
  const view = mirror(source, (target, key) => {
    const value = target[key]
    return value && typeof value === "object" ? wrapHook(value) : bind(target, key)
  })
  const release = async () => {
    controller.abort()
    const failures = []
    while (registrations.length) {
      try {
        await registrations.pop().dispose()
      } catch (err) {
        failures.push(err)
      }
    }
    return failures
  }
  return { view, release }
}

function logLaneFailure(helpers, index, setup, err) {
  try {
    const code = typeof err?.code === "string" ? err.code
      : typeof err?.name === "string" ? err.name : "unknown"
    appendFileSync(join(helpers.DATA_DIR(), "toolcall-guard.errors"),
      JSON.stringify({ at: new Date().toISOString(), lane: "v2-setup", index,
        name: String(setup?.name || "anonymous").slice(0, 64), code: code.slice(0, 64) }) + "\n",
      { mode: 0o600 })
  } catch { /* Logging must never turn an optional failure fatal. */ }
}

export async function setupLanes(ctx, helpers, lanes) {
  const specs = lanes.map((lane) => (typeof lane === "function" ? { setup: lane } : lane))
  const explicitFatal = specs.some((s) => s.fatal === true)
  const disposers = []
  const dispose = async () => {
    const failures = []
    while (disposers.length) {
      try {
        await disposers.pop()()
      } catch (err) {
        failures.push(err)
      }
    }
    if (failures.length) throw new AggregateError(failures, "guard teardown failed")
  }
  for (const [index, spec] of specs.entries()) {
    const setup = spec.setup
    const fatal = spec.fatal === true || (!explicitFatal && index === 0)
    const lane = trackLane(ctx)
    try {
      const cleanup = await setup(lane.view, helpers)
      if (typeof cleanup === "function") disposers.push(cleanup)
    } catch (err) {
      const failures = await lane.release()
      if (!fatal) {
        logLaneFailure(helpers, index, setup, err)
        continue
      }
      try {
        await dispose()
      } catch (cleanupError) {
        failures.push(cleanupError)
      }
      if (failures.length) throw new AggregateError([err, ...failures], "guard setup and teardown failed")
      throw err
    }
  }
  return dispose
}
