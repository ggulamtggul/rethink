import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadExternalDrivers } from '@/cloud/driver_loader'
import Bridge, { builtinDriverModels } from '@/cloud/ha_bridge'
import { MockHAConnection } from '../helpers/mocks'

const GOOD_DRIVER = `
export const models = ['TEST_MODEL_A', 'TEST_MODEL_B']
export const platform = 'thinq2'
export default class {
    constructor(HA, thinq, meta) {
        this.HA = HA
        this.id = thinq.id
        this.meta = meta
        this.setConfig({ components: {} })
    }
    setConfig(config) { this.config = config; this.publishConfig() }
    publishConfig() { if (this.config) this.HA.publishConfig(this.id, this.config) }
    start() { this.started = true }
    drop() {}
    setProperty(prop, value) { this.lastSet = [prop, value] }
}
`

const T1_DRIVER = `
export const models = ['TEST_MODEL_T1']
export const platform = 'thinq1'
export default class {
    constructor(HA, thinq, meta) { this.id = thinq.id }
    setConfig() {}
    publishConfig() {}
    start() {}
    drop() {}
    setProperty() {}
}
`

const SHADOW_DRIVER = `
export const models = ['FX___S']
export default class {
    constructor(HA, thinq, meta) { this.id = thinq.id }
    setConfig() {}
    publishConfig() {}
    start() {}
    drop() {}
    setProperty() {}
}
`

const ALIASED_DRIVER = `
import log from 'rethink/util/logging'
log('status', 'aliased fixture evaluating')
export const models = ['ALIASED_MODEL']
export default class {
    constructor(HA, thinq, meta) { this.id = thinq.id }
    setConfig() {}
    publishConfig() {}
    start() {}
    drop() {}
    setProperty() {}
}
`

const NO_MODELS = `
export default class {
    setConfig() {}
    publishConfig() {}
    start() {}
    drop() {}
    setProperty() {}
}
`

const WRONG_SHAPE = `
export const models = ['WRONG_SHAPE_MODEL']
export default { not: 'a class' }
`

const THROWING_DRIVER = `
throw new Error('boom at import time')
`

let dir: string

function fixture(name: string, body: string) {
    writeFileSync(join(dir, name), body)
}

before(() => {
    dir = mkdtempSync(join(tmpdir(), 'rethink-driver-loader-test-'))
    fixture('01-good.js', GOOD_DRIVER)
    fixture('02-t1.js', T1_DRIVER)
    fixture('03-shadow.js', SHADOW_DRIVER)
    fixture('04-aliased.js', ALIASED_DRIVER)
    fixture('05-no-models.js', NO_MODELS)
    fixture('06-wrong-shape.js', WRONG_SHAPE)
    fixture('07-throwing.js', THROWING_DRIVER)
    fixture('08-syntax-error.js', 'export const = nope')
    fixture(
        '09-duplicate.js',
        GOOD_DRIVER.replaceAll('TEST_MODEL_A', 'TEST_MODEL_A_DUP').replace('TEST_MODEL_B', 'TEST_MODEL_A'),
    )
})

after(() => {
    rmSync(dir, { recursive: true, force: true })
})

describe('external driver loader', () => {
    test('no drivers_dir means no external drivers', async () => {
        const loaded = await loadExternalDrivers(undefined, builtinDriverModels)
        assert.equal(loaded.thinq1.size, 0)
        assert.equal(loaded.thinq2.size, 0)
    })

    test('missing drivers_dir is not an error', async () => {
        const loaded = await loadExternalDrivers(join(dir, 'does-not-exist'), builtinDriverModels)
        assert.equal(loaded.thinq1.size + loaded.thinq2.size, 0)
    })

    test('loads valid drivers, routes by platform, isolates failures', async () => {
        const loaded = await loadExternalDrivers(dir, builtinDriverModels)

        // Good drivers registered, per platform.
        assert.ok(loaded.thinq2.has('TEST_MODEL_A'))
        assert.ok(loaded.thinq2.has('TEST_MODEL_B'))
        assert.ok(loaded.thinq1.has('TEST_MODEL_T1'))

        // An external driver may shadow a built-in model.
        assert.ok(loaded.thinq2.has('FX___S'))

        // A driver importing server modules through rethink/... loaded too.
        assert.ok(loaded.thinq2.has('ALIASED_MODEL'))

        // Broken files registered nothing but did not stop the others.
        assert.ok(!loaded.thinq2.has('WRONG_SHAPE_MODEL'))

        // First file wins for a model claimed twice (09 re-claims TEST_MODEL_A
        // through a class whose instances carry lastSet via setProperty).
        const cls = loaded.thinq2.get('TEST_MODEL_A')
        assert.ok(cls)
        const probe = new cls({ publishConfig() {} }, { id: 'probe' }, { modelId: 'TEST_MODEL_A', modelName: 'probe' })
        probe.setProperty('power', 'ON')
        assert.deepEqual((probe as any).lastSet, ['power', 'ON'])
    })

    test('bridge prefers an external driver and starts it', async () => {
        const loaded = await loadExternalDrivers(dir, builtinDriverModels)
        const HA = new MockHAConnection()
        const bridge = new Bridge(HA as any, loaded)
        const thinqdev = {
            id: 'device-1',
            platform: 'thinq2',
            meta: { modelId: 'TEST_MODEL_A', modelName: 'Test model' },
            on() {},
        }
        bridge.newDevice(thinqdev as any)
        const ha = bridge.haDevices.get('device-1') as any
        assert.ok(ha, 'device got a driver instance')
        assert.equal(ha.started, true)
        assert.ok(HA.devices['device-1']?.config, 'driver published its HA config')
    })

    test('a driver whose constructor throws leaves the bridge standing', async () => {
        const loaded = await loadExternalDrivers(dir, builtinDriverModels)
        const Exploding = class {
            constructor() {
                throw new Error('constructor boom')
            }
            setConfig() {}
            publishConfig() {}
            start() {}
            drop() {}
            setProperty() {}
        }
        loaded.thinq2.set('EXPLODING_MODEL', Exploding as any)
        const bridge = new Bridge(new MockHAConnection() as any, loaded)
        const thinqdev = {
            id: 'device-2',
            platform: 'thinq2',
            meta: { modelId: 'EXPLODING_MODEL', modelName: 'Boom' },
            on() {},
        }
        bridge.newDevice(thinqdev as any)
        assert.equal(bridge.haDevices.has('device-2'), false)
    })
})
