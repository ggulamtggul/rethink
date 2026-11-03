// Example external driver - copy this file, rename it, and make it yours.
//
// Build it with `npm run build-drivers` (see docs/external-drivers.md), then
// drop the compiled example_model.js into the folder named by `drivers_dir`
// in config.jsonc and restart the server. The startup log names the file,
// its sha256 prefix and the models it registered.
//
// The three exports below the imports are the loader contract:
//   models    - every modelId this class handles (aliases go here)
//   platform  - 'thinq2' (default) or 'thinq1'
//   default   - the driver class itself
//
// Imports of server modules go through `rethink/...` specifiers. A compiled
// driver sitting in a drivers folder cannot use relative paths - it does not
// know where the server lives - so the server maps this prefix onto its own
// tree at load time.

import HADevice from 'rethink/cloud/devices/base'
import { type Connection } from 'rethink/cloud/homeassistant'
import { type Metadata } from 'rethink/cloud/thinq'
import type { Device as Thinq2Device } from 'rethink/cloud/thinq2/device'
import { allowExtendedType } from 'rethink/util/casting'
import log from 'rethink/util/logging'

export const models: string[] = ['EXAMPLE_MODEL']
export const platform = 'thinq2'

export default class ExampleModel extends HADevice {
    constructor(
        HA: Connection,
        readonly thinq: Thinq2Device,
        meta: Metadata,
    ) {
        super(HA, thinq.id)
        this.setConfig(
            allowExtendedType({
                ...HADevice.config(meta, { name: 'Example appliance' }),
                components: {
                    power: {
                        platform: 'switch',
                        unique_id: '$deviceid-power',
                        state_topic: '$this/power',
                        command_topic: '$this/power/set',
                        name: '',
                    },
                    status: {
                        platform: 'sensor',
                        unique_id: '$deviceid-status',
                        state_topic: '$this/status',
                        name: 'Status',
                    },
                },
            }),
        )

        // Appliance reports arrive here; decode them and publish the pieces
        // with this.HA.publishProperty(this.id, '<property>', value).
        thinq.on('data', (data: Buffer) => {
            log('status', `example driver: ${data.length} byte report from ${this.id}`)
        })
    }

    override setProperty(prop: string, value: string) {
        // HA wants a property changed. Translate it into appliance bytes and
        // send them with this.thinq.send_packet(buf).
        log('status', `example driver: set ${prop} = ${value} on ${this.id} (not implemented)`)
    }
}
