import PAC_910604_WW from './devices/PAC_910604_WW'
import POT_056905_WW from './devices/POT_056905_WW'
import WTDN3 from './devices/WTDN3'
import RAC_056905_WW from './devices/RAC_056905_WW'
import WIN_056905_WW from './devices/WIN_056905_WW'
import Dev_2REF11EIDA__4 from './devices/2REF11EIDA__4'
import Dev_2REF11EBIVPC4 from './devices/2REF11EBIVPC4'
import Dev_2RES1VE61NFA2 from './devices/2RES1VE61NFA2'
import Dev_2REB1GLVB1__2 from './devices/2REB1GLVB1__2'
import Dev_2RES1VE600FWC from './devices/2RES1VE600FWC'
import Dev_2REFO1DBN3__U from './devices/2REFO1DBN3__U'
import Y_V8_Y___W_B32QEUK from './devices/Y_V8_Y___W.B32QEUK'
import F_V8_Y___W_B_2QEUK from './devices/F_V8_Y___W.B_2QEUK'
import Y_V8_F___W_B_2QEUK from './devices/Y_V8_F___W.B_2QEUK'
import F_V__F___W_B_1QEUK from './devices/F_V__F___W.B_1QEUK'
import F_VB_F___W_B_2QEUK from './devices/F_VB_F___W.B_2QEUK'
import VCDWL2QEUK from './devices/VCDWL2QEUK'
import T1789EFH_F from './devices/T1789EFH_F'
import RV13U6AM8W_D_US_WIFI from './devices/RV13U6AM8W_D_US_WIFI'
import F3L2CYU__ from './devices/F3L2CYU__'
import RV13B6BSD_D_US_WIFI from './devices/RV13B6BSD_D_US_WIFI'
import FX___S from './devices/FX___S'
import DHUM_231006_WW from './devices/DHUM_231006_WW'
import { Device as T1Device } from './thinq1/device'
import { Device as T2Device } from './thinq2/device'
import { type Connection } from './homeassistant'
import HADevice from './devices/base'
import { type Metadata } from './thinq'
import { AnyDevice } from './devmgr'
import { type DriverFactory, type LoadedDrivers } from './driver_loader'
import log from '../util/logging'

type T1Factory = new (HA: Connection, thinq: T1Device, metadata: Metadata) => HADevice
type T2Factory = new (HA: Connection, thinq: T2Device, metadata: Metadata) => HADevice

const t1deviceTypes: Record<string, T1Factory> = {
    WTDN3,
}

const t2deviceTypes: Record<string, T2Factory> = {
    PAC_910604_WW, // LG stand (floor-standing) AC (deviceType 401, TLV state frames marked 0xa7)
    POT_056905_WW,
    RAC_056905_WW,
    ['RAC_0B0001_WW']: RAC_056905_WW, // a different European variant (deviceType 401, RTK_RTL8720cm), same TLV handler
    WIN_056905_WW,
    ['2REF11EIDA__4']: Dev_2REF11EIDA__4,
    ['2REF11EBIVPC4']: Dev_2REF11EBIVPC4,
    ['2RES1VE61NFA2']: Dev_2RES1VE61NFA2,
    ['2REB1GLVB1__2']: Dev_2REB1GLVB1__2,
    ['2RES1VE600FWC']: Dev_2RES1VE600FWC,
    ['2REFO1DBN3__U']: Dev_2REFO1DBN3__U, // LG T875MEE111.CKOR fridge, Korean domestic (deviceType 101, 65-byte status)
    ['Y_V8_Y___W.B32QEUK']: Y_V8_Y___W_B32QEUK,
    ['F_V7_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    ['F_V8_Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK,
    ['Y_V8_F___W.B_2QEUK']: Y_V8_F___W_B_2QEUK,
    ['F_V__Y___W.B_2QEUK']: F_V8_Y___W_B_2QEUK, // NOTE: we reuse F_V8_Y___W_B_2QEUK as the models appear to be compatible
    ['VCDWL2QEUK']: VCDWL2QEUK, // LG F4X7511TWS front-load washer (matched on modelId VCDWL2QEUK)
    ['F_V__F___W.B_1QEUK']: F_V__F___W_B_1QEUK,
    ['F_VB_F___W.B_2QEUK']: F_VB_F___W_B_2QEUK, // LG CV74J7S2QA washer/dryer combo
    ['T1789EFH_F']: T1789EFH_F, // LG WT7300CW top-loading washer
    ['RV13U6AM8W_D_US_WIFI']: RV13U6AM8W_D_US_WIFI, // LG DLE7300WE dryer
    ['F3L2CYU__']: F3L2CYU__, // LG front-load washer
    ['RV13B6BSD_D_US_WIFI']: RV13B6BSD_D_US_WIFI, // LG electric dryer
    FX___S, // LG front-load washer sold in Korea (deviceType 201, tunnelled 0xEC state frames)
    DHUM_231006_WW, // LG dehumidifier sold in Korea (deviceType 403, TLV state frames marked 0xa7)
}

// Model lists of the statically registered drivers, so the external driver
// loader can report which built-ins an external driver shadows.
export const builtinDriverModels = {
    thinq1: Object.keys(t1deviceTypes),
    thinq2: Object.keys(t2deviceTypes),
}

// A connected appliance the bridge keeps track of, so a hot-reloaded external
// driver can be swapped in without the appliance reconnecting. `factory` is
// the class the live instance was built from (undefined while the model has
// no driver); `listeners` snapshots the thinq device's event listeners from
// before that instance was constructed, so the instance's own subscriptions
// can be removed again when it is replaced - drivers subscribe with anonymous
// closures and do not unsubscribe in drop().
type TrackedDevice = {
    thinqdev: AnyDevice
    factory?: DriverFactory
    listeners?: Map<string, Set<unknown>>
}

function snapshotListeners(thinqdev: AnyDevice): Map<string, Set<unknown>> {
    const snap = new Map<string, Set<unknown>>()
    const dev = thinqdev as unknown as {
        eventNames?: () => (string | symbol)[]
        listeners?: (event: string | symbol) => unknown[]
    }
    if (typeof dev.eventNames !== 'function' || typeof dev.listeners !== 'function') return snap
    for (const event of dev.eventNames()) snap.set(String(event), new Set(dev.listeners(event)))
    return snap
}

function detachInstanceListeners(thinqdev: AnyDevice, before?: Map<string, Set<unknown>>) {
    if (!before) return
    const dev = thinqdev as unknown as {
        eventNames?: () => (string | symbol)[]
        listeners?: (event: string | symbol) => unknown[]
        removeListener?: (event: string | symbol, fn: never) => void
    }
    if (
        typeof dev.eventNames !== 'function' ||
        typeof dev.listeners !== 'function' ||
        typeof dev.removeListener !== 'function'
    )
        return
    for (const event of dev.eventNames()) {
        const keep = before.get(String(event))
        for (const fn of dev.listeners(event)) {
            if (!keep?.has(fn)) dev.removeListener(event, fn as never)
        }
    }
}

class Bridge {
    haDevices = new Map<string, HADevice>()
    private tracked = new Map<string, TrackedDevice>()
    constructor(
        readonly HA: Connection,
        private external?: LoadedDrivers,
    ) {
        HA.on('discovery', () => {
            this.haDevices.forEach((ha) => ha.publishConfig())
        })
        HA.on('setProperty', (id: string, prop: string, value: string) => {
            const ha = this.haDevices.get(id)
            if (ha) ha.setProperty(prop, value)
        })
    }

    // External drivers (drivers_dir) win over the built-in registry.
    private resolveFactory(thinqdev: AnyDevice): DriverFactory | undefined {
        const meta = thinqdev.meta
        if (thinqdev.platform === 'thinq1')
            return this.external?.thinq1.get(meta.modelId) ?? (t1deviceTypes[meta.modelId] as DriverFactory)
        if (thinqdev.platform === 'thinq2')
            return this.external?.thinq2.get(meta.modelId) ?? (t2deviceTypes[meta.modelId] as DriverFactory)
        return undefined
    }

    private attach(tracked: TrackedDevice) {
        const { thinqdev } = tracked
        const meta = thinqdev.meta
        const devclass = this.resolveFactory(thinqdev)
        if (!devclass) {
            console.warn(`${thinqdev.platform} device type ${meta.modelId} unknown`)
            return
        }

        let hadevice: HADevice
        tracked.listeners = snapshotListeners(thinqdev)
        try {
            hadevice = new devclass(this.HA, thinqdev, meta)
        } catch (err) {
            // A driver that throws while being constructed must not take the
            // device (or the server) down with it: carry on without one.
            console.error(`driver for ${meta.modelId} failed to start:`, err)
            detachInstanceListeners(thinqdev, tracked.listeners)
            tracked.listeners = undefined
            return
        }
        tracked.factory = devclass
        this.haDevices.set(thinqdev.id, hadevice)

        // hadevice.publishConfig() not needed anymore, will usually happen in the devclass constructor - or later
        try {
            hadevice.start()
        } catch (err) {
            console.error(`driver for ${meta.modelId} failed in start():`, err)
            this.dropDevice(hadevice)
        }
    }

    private removeInstance(id: string) {
        const ha = this.haDevices.get(id)
        if (!ha) return
        this.haDevices.delete(id)
        const tracked = this.tracked.get(id)
        if (tracked) {
            detachInstanceListeners(tracked.thinqdev, tracked.listeners)
            tracked.factory = undefined
            tracked.listeners = undefined
        }
        ha.drop()
    }

    newDevice(thinqdev: AnyDevice) {
        const previous = this.tracked.get(thinqdev.id)
        if (previous && previous.thinqdev !== thinqdev) {
            // Reconnect on a fresh connection object: the old instance's
            // listeners live on the dead object, only its HA side needs the drop.
            const old = this.haDevices.get(thinqdev.id)
            if (old) {
                this.haDevices.delete(thinqdev.id)
                old.drop()
            }
        } else if (previous) {
            this.removeInstance(thinqdev.id)
        }

        const tracked: TrackedDevice = { thinqdev }
        this.tracked.set(thinqdev.id, tracked)
        thinqdev.on('close', () => {
            if (this.tracked.get(thinqdev.id)?.thinqdev !== thinqdev) return
            this.tracked.delete(thinqdev.id)
            this.removeInstance(thinqdev.id)
        })
        this.attach(tracked)
    }

    // Swap in a freshly loaded external driver registry (hot reload). The
    // loader re-imports changed files under a new class identity while
    // unchanged files keep theirs, so a reference comparison per live device
    // picks out exactly the drivers that changed: those instances are rebuilt
    // on the same connection, devices that gain a driver are attached, and
    // devices whose driver vanished are detached. Nothing here touches the
    // appliance connections themselves.
    setExternalDrivers(next: LoadedDrivers) {
        this.external = next
        for (const tracked of this.tracked.values()) {
            const factory = this.resolveFactory(tracked.thinqdev)
            if (factory === tracked.factory) continue
            const had = this.haDevices.has(tracked.thinqdev.id)
            if (had) this.removeInstance(tracked.thinqdev.id)
            if (factory) {
                this.attach(tracked)
                if (this.haDevices.has(tracked.thinqdev.id))
                    log(
                        'status',
                        `hot reload: ${tracked.thinqdev.meta.modelId} (${tracked.thinqdev.id}) driver ${had ? 'swapped' : 'attached'}`,
                    )
            } else if (had) {
                log(
                    'status',
                    `hot reload: ${tracked.thinqdev.meta.modelId} (${tracked.thinqdev.id}) driver removed`,
                )
            }
        }
    }

    dropDevice(ha: HADevice) {
        if (this.haDevices.get(ha.id) === ha) this.removeInstance(ha.id)
    }
}

export default Bridge
