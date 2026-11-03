// External driver loader.
//
// Built-in drivers are compiled into cloud/devices/ and registered statically
// in cloud/ha_bridge.ts, so adding support for a model meant rebuilding the
// whole server. This loader reads additional drivers from a folder named by
// the `drivers_dir` config option, so a driver can be dropped in (and
// removed) without touching the server build.
//
// A driver file is a compiled ESM .js module with this shape:
//
//   export const models: string[] = ['MODEL_ID', ...]  // modelIds it handles
//   export const platform = 'thinq2'                   // or 'thinq1'; default 'thinq2'
//   export default class extends HADevice { ... }      // 'rethink/cloud/devices/base'
//
// Server modules are imported through `rethink/...` specifiers, which the
// hook in util/rethink-alias-hook.ts maps onto the running server's tree;
// registerDriverImportHook() below installs it before the first import.
//
// Safety rules (a bad file must never take the server down):
// - every file is imported inside its own try/catch; failures are logged
//   with the file name and reason, and loading continues with the rest.
// - the default export is checked structurally (the HADevice method shape),
//   not with instanceof: an external file may legitimately have loaded its
//   own copy of the base module, so identity checks would misfire.
// - a model claimed by two external files keeps the first registration.
// - external drivers take precedence over built-in ones for the same model;
//   the shadowing is logged at load time.

import { existsSync, readdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { register } from 'node:module'
import log from '../util/logging'
import type HADevice from './devices/base'
import type { Connection } from './homeassistant'
import type { Metadata } from './thinq'

export type DriverFactory = new (HA: Connection, thinq: any, metadata: Metadata) => HADevice

export interface LoadedDrivers {
    thinq1: Map<string, DriverFactory>
    thinq2: Map<string, DriverFactory>
    // modelId -> file that provided it, so the hot-reload watcher can tell a
    // file that failed to load apart from a driver that was edited or removed.
    sources: Map<string, string>
}

export function emptyDrivers(): LoadedDrivers {
    return { thinq1: new Map(), thinq2: new Map(), sources: new Map() }
}

let hookRegistered = false

// Installs the `rethink/...` specifier hook once. Picks the compiled hook
// under dist/ when running built code, the .ts source under tsx.
export function registerDriverImportHook() {
    if (hookRegistered) return
    hookRegistered = true
    const built = new URL('../util/rethink-alias-hook.js', import.meta.url)
    const source = new URL('../util/rethink-alias-hook.ts', import.meta.url)
    register(existsSync(fileURLToPath(built)) ? built : source, import.meta.url)
}

// The HADevice surface a driver class must show. Checked on the prototype so
// inherited methods count; see the header for why this is not instanceof.
const REQUIRED_METHODS = ['setConfig', 'publishConfig', 'start', 'drop', 'setProperty']

function looksLikeDriverClass(cls: unknown): cls is DriverFactory {
    if (typeof cls !== 'function') return false
    const proto = (cls as { prototype?: object }).prototype
    if (!proto) return false
    return REQUIRED_METHODS.every((m) => typeof (proto as Record<string, unknown>)[m] === 'function')
}

export async function loadExternalDrivers(
    dir: string | undefined,
    builtin: { thinq1: string[]; thinq2: string[] },
): Promise<LoadedDrivers> {
    const loaded = emptyDrivers()
    if (!dir) return loaded
    if (!existsSync(dir)) {
        log('status', `drivers_dir ${dir} does not exist - no external drivers loaded`)
        return loaded
    }

    registerDriverImportHook()

    const files = readdirSync(dir)
        .filter((f) => f.endsWith('.js'))
        .sort()
    let failures = 0

    for (const file of files) {
        const path = join(dir, file)
        const hash = createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 8)
        try {
            // The hash in the query keeps repeated loads in one process honest.
            const mod = (await import(pathToFileURL(path).href + '?v=' + hash)) as {
                default?: unknown
                models?: unknown
                platform?: unknown
            }
            if (!looksLikeDriverClass(mod.default))
                throw new Error(
                    'default export is not an HADevice-shaped class (prototype needs ' +
                        REQUIRED_METHODS.join('/') +
                        ')',
                )
            if (
                !Array.isArray(mod.models) ||
                mod.models.length === 0 ||
                mod.models.some((m) => typeof m !== 'string' || m.length === 0)
            )
                throw new Error('module must export `models`: a non-empty array of modelId strings')
            const platform = mod.platform ?? 'thinq2'
            if (platform !== 'thinq1' && platform !== 'thinq2')
                throw new Error(`platform export must be 'thinq1' or 'thinq2', got ${JSON.stringify(mod.platform)}`)

            const registry = platform === 'thinq1' ? loaded.thinq1 : loaded.thinq2
            const builtinModels = platform === 'thinq1' ? builtin.thinq1 : builtin.thinq2
            for (const model of mod.models as string[]) {
                if (registry.has(model)) {
                    log(
                        'status',
                        `external driver ${file} (${hash}): model ${model} already has an external driver, keeping the first`,
                    )
                    continue
                }
                registry.set(model, mod.default)
                loaded.sources.set(model, file)
                if (builtinModels.includes(model))
                    log('status', `external driver ${file} (${hash}) shadows the built-in driver for ${model}`)
            }
            log(
                'status',
                `external driver ${file} (${hash}): ${platform} driver for ${(mod.models as string[]).join(', ')}`,
            )
        } catch (err) {
            failures++
            log(
                'status',
                `external driver ${file} (${hash}) failed to load: ${err instanceof Error ? err.message : String(err)}`,
            )
        }
    }

    log(
        'status',
        `external drivers: ${files.length} file(s) in ${dir}, ` +
            `${loaded.thinq1.size + loaded.thinq2.size} model(s) registered, ${failures} failure(s)`,
    )
    return loaded
}

// Hot reload: watch the drivers folder and hand each fresh registry to
// `onReload`. Only .js changes trigger - the folder also holds driver data
// files (energy counters and the like) that change all the time. Reloads are
// debounced and serialized. Because the loader re-imports a changed file
// under a new class identity while an unchanged file keeps its identity, the
// bridge can swap exactly the drivers that changed and leave the rest - and
// every appliance connection - alone. A file that now fails to load keeps
// its previous driver (seeded from `initial`); a file that was deleted or
// edited to drop a model unregisters that model as usual. Returns undefined
// when there is nothing to watch.
export function watchExternalDrivers(
    dir: string | undefined,
    builtin: { thinq1: string[]; thinq2: string[] },
    initial: LoadedDrivers,
    onReload: (loaded: LoadedDrivers) => void,
): FSWatcher | undefined {
    if (!dir) return undefined
    if (!existsSync(dir)) {
        log('status', `drivers_dir ${dir} does not exist - hot reload not started`)
        return undefined
    }

    let previous = initial
    let timer: ReturnType<typeof setTimeout> | undefined
    let running = false
    let pending = false
    const reload = async () => {
        if (running) {
            pending = true
            return
        }
        running = true
        try {
            const loaded = await loadExternalDrivers(dir, builtin)
            // Carry over the previous driver for any model whose file is
            // still there but produced nothing this time: it failed to load.
            const loadedFiles = new Set(loaded.sources.values())
            for (const [model, file] of previous.sources) {
                if (loaded.thinq1.has(model) || loaded.thinq2.has(model)) continue
                if (loadedFiles.has(file) || !existsSync(join(dir, file))) continue
                const factory = previous.thinq1.get(model) ?? previous.thinq2.get(model)
                if (!factory) continue
                ;(previous.thinq1.has(model) ? loaded.thinq1 : loaded.thinq2).set(model, factory)
                loaded.sources.set(model, file)
                log('status', `hot reload: keeping the previous driver for ${model} (${file} failed to load)`)
            }
            previous = loaded
            onReload(loaded)
        } catch (err) {
            log(
                'status',
                `external driver reload failed: ${err instanceof Error ? err.message : String(err)}`,
            )
        }
        running = false
        if (pending) {
            pending = false
            void reload()
        }
    }

    const watcher = watch(dir, { persistent: false }, (_event, filename) => {
        if (filename && !filename.endsWith('.js')) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
            timer = undefined
            void reload()
        }, 1000)
        timer.unref()
    })
    watcher.on('error', (err) => {
        log('status', `external driver watch error: ${err.message}`)
    })
    log('status', `external driver hot reload: watching ${dir}`)
    return watcher
}
