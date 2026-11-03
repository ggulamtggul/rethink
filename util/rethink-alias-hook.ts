// Node module customization hook that lets external driver files import the
// server's own modules through `rethink/...` specifiers:
//
//   import HADevice from 'rethink/cloud/devices/base'
//   import AABBDevice from 'rethink/cloud/devices/aabb_device'
//   import log from 'rethink/util/logging'
//
// A driver compiled into some drivers_dir cannot know where the server lives,
// so relative imports from the driver file are useless to it. This hook maps
// the `rethink/` prefix onto the server tree next to this file (the source
// tree under tsx, dist/ in a built install), trying the extensions each
// layout uses. Registered by cloud/driver_loader.ts before any external
// driver is imported; everything that is not a `rethink/` specifier is
// passed through untouched.

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const EXTENSIONS = ['.js', '.ts', '/index.js', '/index.ts']

export async function resolve(
    specifier: string,
    context: object,
    nextResolve: (specifier: string, context: object) => Promise<{ url: string }>,
): Promise<{ url: string; shortCircuit?: boolean }> {
    if (specifier.startsWith('rethink/')) {
        const rel = specifier.slice('rethink/'.length)
        // This file lives in <root>/util/, so the server tree is one level up.
        const root = new URL('../', import.meta.url)
        for (const ext of EXTENSIONS) {
            const candidate = new URL(rel + ext, root)
            if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true }
        }
    }
    return nextResolve(specifier, context)
}
