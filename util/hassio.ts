import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fetch from 'node-fetch'
import stripJsonComments from 'strip-json-comments'
import { Port, RawConfig } from './config'
import log from './logging'

// The Home Assistant Supervisor writes the add-on options to a JSON file in the
// container. The add-on manifest points RETHINK_HASSIO_OPTIONS at it, and that
// variable is what selects add-on mode in rethink-cloud.
//
// This is a port of the upstream loader to this fork's configuration shape:
// the fork's Port carries a numeric `advertise` only, its bridge has no DNS
// resolver setting of its own, and it has no custom root certificate option,
// so those upstream options are accepted in the options file (the add-on
// manifest declares them) but only the parts this fork can honour are used.

// Rendered on every start, as a starting point for users who want to switch to a
// hand-written configuration file via the config_file option.
export const HASSIO_EXAMPLE = 'config.jsonc.example'

// User-facing options, as defined by the schema in the add-on manifest, which lives
// in the separate rethink-ha add-on repository. Everything is optional here; the
// defaults below have to stay in step with the ones declared there.
type Options = {
    hostname?: string
    discovery_prefix?: string
    rethink_prefix?: string
    mqtt_url?: string
    mqtt_user?: string
    mqtt_pass?: string
    https_advertise?: string
    mqtts_advertise?: string
    custom_root_cert_file?: string
    config_file?: string
    bridge_dns?: string[]
    drivers_dir?: string
    advertise_requested_host?: boolean
    log?: string[]
}

type MqttService = {
    data?: { host?: string; port?: number; ssl?: boolean; username?: string; password?: string }
}

// Resolve the MQTT broker: an explicit URL wins, otherwise ask the Supervisor for the
// Home Assistant MQTT service. There is nothing sensible to fall back to - the container
// has no broker of its own - so failing here beats starting up unable to publish anything.
async function resolveMqtt(opts: Options): Promise<{ url: string; user: string; pass: string }> {
    if (opts.mqtt_url) return { url: opts.mqtt_url, user: opts.mqtt_user ?? '', pass: opts.mqtt_pass ?? '' }

    // The Supervisor only knows about brokers published by another add-on. One that
    // was configured directly in the MQTT integration is not visible here, so the
    // user has to point mqtt_url at it.
    const token = process.env.SUPERVISOR_TOKEN
    if (token) {
        try {
            const resp = await fetch('http://supervisor/services/mqtt', {
                headers: { Authorization: `Bearer ${token}` },
            })
            if (resp.ok) {
                const { data } = (await resp.json()) as MqttService
                if (data?.host && data?.port)
                    return {
                        url: `${data.ssl ? 'mqtts' : 'mqtt'}://${data.host}:${data.port}`,
                        user: data.username ?? '',
                        pass: data.password ?? '',
                    }
            }
        } catch (err) {
            log('status', 'Could not ask the Supervisor for the MQTT service:', err)
        }
    }

    throw new Error(
        'No MQTT broker available: the Supervisor did not provide one. Install an MQTT broker add-on, ' +
            'or set the mqtt_url option to point at your own broker.',
    )
}

// The container always binds the default ports and the Supervisor maps them to the
// host side, so only the advertised value is configurable here. It is needed when
// that mapping is not 1:1, or when the appliances reach rethink through a proxy.
// This fork advertises a port number only; a full URL cannot be expressed in its
// Port type, so one is ignored with a warning rather than silently mangled.
function port(bind: number, advertise: string | undefined): Port {
    if (!advertise) return { bind, advertise: bind }
    if (/^[0-9]+$/.test(advertise)) return { bind, advertise: Number(advertise) }
    log(
        'status',
        `Ignoring non-numeric advertised port ${JSON.stringify(advertise)}: this build advertises a port number only`,
    )
    return { bind, advertise: bind }
}

// The paths are written out already resolved, so that a hand-written copy of this
// file keeps using the add-on data directory for whatever the user does not override.
function writeExample(config: RawConfig, configDir: string) {
    const example: RawConfig = {
        ...config,
        ca_key_file: resolve(configDir, config.ca_key_file),
        ca_cert_file: resolve(configDir, config.ca_cert_file),
    }
    if (config.drivers_dir) example.drivers_dir = resolve(configDir, config.drivers_dir)
    if (config.bridge)
        example.bridge = { ...config.bridge, storage_path: resolve(configDir, config.bridge.storage_path) }

    const path = resolve(configDir, HASSIO_EXAMPLE)
    try {
        writeFileSync(path, JSON.stringify(example, null, 4) + '\n')
    } catch (err) {
        log('status', `Could not write ${path}:`, err)
    }
}

// Build a RawConfig from the add-on options, or read the file that config_file
// points at. Relative paths are resolved against configDir by the caller.
export async function loadHassioConfig(configDir: string, optionsPath: string): Promise<RawConfig> {
    const opts = JSON.parse(readFileSync(optionsPath).toString('utf-8')) as Options

    if (opts.config_file) {
        const path = resolve(configDir, opts.config_file)
        log('status', `Ignoring the add-on options, reading the configuration from ${path}`)
        return JSON.parse(stripJsonComments(readFileSync(path).toString('utf-8'))) as RawConfig
    }

    const mqtt = await resolveMqtt(opts)

    const config: RawConfig = {
        hostname: opts.hostname ?? 'rethink.lan',
        advertise_requested_host: opts.advertise_requested_host ?? false,
        drivers_dir: opts.drivers_dir ?? 'drivers',
        homeassistant: {
            mqtt_url: mqtt.url,
            discovery_prefix: opts.discovery_prefix ?? 'homeassistant',
            rethink_prefix: opts.rethink_prefix ?? 'rethink',
            mqtt_user: mqtt.user,
            mqtt_pass: mqtt.pass,
        },
        ca_key_file: 'ca.key',
        ca_cert_file: 'ca.cert',
        https_port: port(443, opts.https_advertise),
        mqtts_port: port(8883, opts.mqtts_advertise),
        mqtt_port: 1884,
        management_port: 44401,
        // Bridge mode stays inert until an LG account is linked in the management panel,
        // so it costs nothing to always have the storage ready.
        bridge: { storage_path: 'state' },
        log: opts.log ?? ['status', 'incoming', 'HTTPS', 'publish', 'MGMT'],
    }

    writeExample(config, configDir)
    return config
}
