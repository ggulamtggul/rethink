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

import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
}

export function emptyDrivers(): LoadedDrivers {
    return { thinq1: new Map(), thinq2: new Map() }
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
