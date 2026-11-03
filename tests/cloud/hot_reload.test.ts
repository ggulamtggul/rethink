import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyDrivers, loadExternalDrivers, watchExternalDrivers } from '@/cloud/driver_loader'
import Bridge, { builtinDriverModels } from '@/cloud/ha_bridge'
import { MockHAConnection } from '../helpers/mocks'

// A minimal external driver whose instances are distinguishable by version,
// and which subscribes to the thinq device the way real drivers do (an
// anonymous 'data' closure that drop() never removes).
const driverSource = (version: number, model = 'HOT_MODEL') => `
export const models = ['${model}']
export const platform = 'thinq2'
export default class {
    constructor(HA, thinq, meta) {
        this.HA = HA
        this.id = thinq.id
        this.meta = meta
        this.version = ${version}
        this.dataSeen = []
        thinq.on('data', (f) => this.dataSeen.push(f))
        this.setConfig({ components: {} })
    }
    setConfig(config) { this.config = config; this.publishConfig() }
    publishConfig() { if (this.config) this.HA.publishConfig(this.id, this.config) }
    start() { this.started = true }
    drop() { this.dropped = true }
    setProperty() {}
}
`

const EXPLODING_AFTER_SUBSCRIBE = `
export const models = ['HOT_MODEL']
export const platform = 'thinq2'
export default class {
    constructor(HA, thinq, meta) {
        thinq.on('data', () => {})
        throw new Error('constructor boom')
    }
    setConfig() {}
    publishConfig() {}
    start() {}
    drop() {}
    setProperty() {}
}
`

function stubThinq(id: string, modelId: string) {
    const dev = new EventEmitter() as EventEmitter & {
        id: string
        platform: string
        meta: { modelId: string; modelName: string }
    }
    dev.id = id
    dev.platform = 'thinq2'
    dev.meta = { modelId, modelName: modelId }
    return dev
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, timeoutMs = 10000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!cond()) {
        if (Date.now() > deadline) throw new Error('condition not met within ' + timeoutMs + 'ms')
        await sleep(100)
    }
}

describe('external driver hot reload', () => {
    let dir: string
    before(() => {
        dir = mkdtempSync(join(tmpdir(), 'hot-reload-'))
    })
    after(() => {
        rmSync(dir, { recursive: true, force: true })
    })

    test('an unchanged file keeps its class identity across loads, a changed one does not', async () => {
        writeFileSync(join(dir, 'a.js'), driverSource(1))
        writeFileSync(join(dir, 'b.js'), driverSource(1, 'OTHER_MODEL'))
        const first = await loadExternalDrivers(dir, builtinDriverModels)

        const again = await loadExternalDrivers(dir, builtinDriverModels)
        assert.equal(again.thinq2.get('HOT_MODEL'), first.thinq2.get('HOT_MODEL'))
        assert.equal(again.thinq2.get('OTHER_MODEL'), first.thinq2.get('OTHER_MODEL'))

        writeFileSync(join(dir, 'a.js'), driverSource(2))
        const changed = await loadExternalDrivers(dir, builtinDriverModels)
        assert.notEqual(changed.thinq2.get('HOT_MODEL'), first.thinq2.get('HOT_MODEL'))
        assert.equal(changed.thinq2.get('OTHER_MODEL'), first.thinq2.get('OTHER_MODEL'))
        assert.equal(changed.sources.get('HOT_MODEL'), 'a.js')
    })

    test('the bridge swaps a live driver without touching the connection', async () => {
        writeFileSync(join(dir, 'a.js'), driverSource(1))
        const v1 = await loadExternalDrivers(dir, builtinDriverModels)
        const bridge = new Bridge(new MockHAConnection() as never, v1)
        const thinq = stubThinq('dev-hot', 'HOT_MODEL')
        bridge.newDevice(thinq as never)
        const first = bridge.haDevices.get('dev-hot') as never as {
            version: number
            dropped?: boolean
            dataSeen: unknown[]
        }
        assert.equal(first.version, 1)
        assert.equal(thinq.listenerCount('data'), 1)

        writeFileSync(join(dir, 'a.js'), driverSource(2))
        bridge.setExternalDrivers(await loadExternalDrivers(dir, builtinDriverModels))

        const second = bridge.haDevices.get('dev-hot') as never as typeof first
        assert.ok(second, 'device still has a driver')
        assert.notEqual(second, first)
        assert.equal(second.version, 2)
        assert.equal(first.dropped, true)
        // The replaced instance left no subscription behind; only the new
        // instance receives the appliance's reports now.
        assert.equal(thinq.listenerCount('data'), 1)
        thinq.emit('data', Buffer.from('x'))
        assert.deepEqual(first.dataSeen, [])
        assert.equal(second.dataSeen.length, 1)

        // A reload with no changes is a no-op for live devices.
        bridge.setExternalDrivers(await loadExternalDrivers(dir, builtinDriverModels))
        assert.equal(bridge.haDevices.get('dev-hot'), second as never)
        assert.equal(second.dropped, undefined)
    })

    test('a device that connected unknown gains its driver on reload, and loses it when the driver goes away', async () => {
        const bridge = new Bridge(new MockHAConnection() as never, emptyDrivers())
        const thinq = stubThinq('dev-late', 'HOT_MODEL')
        bridge.newDevice(thinq as never)
        assert.equal(bridge.haDevices.has('dev-late'), false)

        writeFileSync(join(dir, 'a.js'), driverSource(3))
        bridge.setExternalDrivers(await loadExternalDrivers(dir, builtinDriverModels))
        const ha = bridge.haDevices.get('dev-late') as never as { version: number; dropped?: boolean }
        assert.equal(ha.version, 3)

        bridge.setExternalDrivers(emptyDrivers())
        assert.equal(bridge.haDevices.has('dev-late'), false)
        assert.equal(ha.dropped, true)
        assert.equal(thinq.listenerCount('data'), 0)
        // The appliance disconnecting afterwards must not error.
        thinq.emit('close')
    })

    test('a driver that throws during a swap leaves the device tracked and recoverable', async () => {
        writeFileSync(join(dir, 'a.js'), driverSource(1))
        const bridge = new Bridge(
            new MockHAConnection() as never,
            await loadExternalDrivers(dir, builtinDriverModels),
        )
        const thinq = stubThinq('dev-boom', 'HOT_MODEL')
        bridge.newDevice(thinq as never)
        assert.ok(bridge.haDevices.has('dev-boom'))

        writeFileSync(join(dir, 'a.js'), EXPLODING_AFTER_SUBSCRIBE)
        bridge.setExternalDrivers(await loadExternalDrivers(dir, builtinDriverModels))
        assert.equal(bridge.haDevices.has('dev-boom'), false)
        // Neither the old instance nor the half-built one left a subscription.
        assert.equal(thinq.listenerCount('data'), 0)

        writeFileSync(join(dir, 'a.js'), driverSource(4))
        bridge.setExternalDrivers(await loadExternalDrivers(dir, builtinDriverModels))
        const ha = bridge.haDevices.get('dev-boom') as never as { version: number }
        assert.equal(ha.version, 4)
        assert.equal(thinq.listenerCount('data'), 1)
    })

    test('the watcher reloads changed files, keeps the previous driver for a broken file, and unregisters a deleted one', async () => {
        writeFileSync(join(dir, 'a.js'), driverSource(1))
        const initial = await loadExternalDrivers(dir, builtinDriverModels)
        const bridge = new Bridge(new MockHAConnection() as never, initial)
        const thinq = stubThinq('dev-watch', 'HOT_MODEL')
        bridge.newDevice(thinq as never)
        const watcher = watchExternalDrivers(dir, builtinDriverModels, initial, (loaded) =>
            bridge.setExternalDrivers(loaded),
        )
        assert.ok(watcher, 'watcher started')
        try {
            writeFileSync(join(dir, 'a.js'), driverSource(2))
            await until(
                () =>
                    (bridge.haDevices.get('dev-watch') as never as { version: number })?.version === 2,
            )

            // A broken edit must not take the working driver down.
            writeFileSync(join(dir, 'a.js'), 'this is not javascript at all ;; ;')
            await sleep(3000)
            const kept = bridge.haDevices.get('dev-watch') as never as {
                version: number
                dropped?: boolean
            }
            assert.equal(kept.version, 2)
            assert.equal(kept.dropped, undefined)
            assert.equal(thinq.listenerCount('data'), 1)

            unlinkSync(join(dir, 'a.js'))
            await until(() => !bridge.haDevices.has('dev-watch'))
            assert.equal(thinq.listenerCount('data'), 0)
        } finally {
            watcher.close()
        }
    })
})
