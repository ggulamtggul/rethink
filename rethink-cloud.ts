import express from 'express'
import stripJsonComments from 'strip-json-comments'
import { mkdirSync, readFileSync } from 'node:fs'
import * as https from 'node:https'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { Broker } from './cloud/mqtt-broker'
import * as tls from 'node:tls'
import * as net from 'node:net'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { routes as thinq1Routes } from './cloud/thinq1/http'
import { routes as thinq2Routes } from './cloud/thinq2/provisioning'
import { DeviceAcceptor as T1Acceptor } from './cloud/thinq1/device'
import { DeviceAcceptor as T2Acceptor } from './cloud/thinq2/device'
import { Connection as HA_connection } from './cloud/homeassistant'
import HA_bridge, { builtinDriverModels } from './cloud/ha_bridge'
import { loadExternalDrivers } from './cloud/driver_loader'
import { normalize as normalizeConfig, RawConfig, CA } from './util/config'
import { loadHassioConfig } from './util/hassio'
import { CertificateIssuer } from './util/sni'
import * as Management from './management'

import log, { setFilter as setLogFilter } from './util/logging'
import { DeviceManager } from './cloud/devmgr'
import { Bridge } from './bridge'
import { JSONStorage } from './bridge/state'

// Set by the Home Assistant add-on manifest: the Supervisor options file to configure from,
// and the directory to keep the CA and the bridge state in. Absent everywhere else.
const hassioOptions = process.env.RETHINK_HASSIO_OPTIONS

let rawConfig: RawConfig
let configDir: string
if (hassioOptions) {
    const dataDir = process.env.RETHINK_DATA_DIR
    if (!dataDir) throw new Error('RETHINK_DATA_DIR must be set together with RETHINK_HASSIO_OPTIONS')
    configDir = resolve(dataDir)
    log('status', `Home Assistant add-on mode, loading options from ${hassioOptions}`)
    rawConfig = await loadHassioConfig(configDir, hassioOptions)
} else {
    const configPath = resolve(process.argv[2] ?? './config.json')
    configDir = dirname(configPath)
    rawConfig = JSON.parse(stripJsonComments(readFileSync(configPath).toString('utf-8'))) as RawConfig
}
const config = normalizeConfig(rawConfig)

config.ca_key_file = resolve(configDir, config.ca_key_file)
config.ca_cert_file = resolve(configDir, config.ca_cert_file)
if (config.bridge) config.bridge.storage_path = resolve(configDir, config.bridge.storage_path)
if (config.drivers_dir) config.drivers_dir = resolve(configDir, config.drivers_dir)

if (!config.log) config.log = ['status', 'incoming', 'HTTPS']

const enabled = Object.fromEntries(config.log.map((key) => [key, true]))
setLogFilter((topic) => {
    return enabled[topic] || enabled['all']
})

// if you add spaces here, you will have to fix quoting in the code below
// the CA is also the server
function loadOrCreateCert(): CA {
    let keypem: string | undefined, certpem: string | undefined
    try {
        keypem = readFileSync(config.ca_key_file).toString('utf-8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    try {
        certpem = readFileSync(config.ca_cert_file).toString('utf-8')
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }

    if (keypem !== undefined && certpem !== undefined) {
        // An existing CA is used as-is, whatever name it carries: appliances provisioned
        // so far have this exact CA pinned, so silently issuing a new one because its
        // subject is not config.hostname (an upstream CA is `CN=Rethink CA`, with no SAN)
        // would cut every one of them off. The per-name leaves in util/sni.ts are what
        // appliances actually see as server certificates.
        const cert = new X509Certificate(certpem)
        if (!cert.checkPrivateKey(createPrivateKey(keypem)))
            throw new Error('the CA private key does not belong to the CA certificate')
        return { key: keypem, cert: certpem }
    }

    if (keypem !== undefined || certpem !== undefined)
        throw new Error(
            `only one of ${config.ca_key_file} and ${config.ca_cert_file} exists; refusing to replace the CA`,
        )

    log('status', 'Creating a new key/certificate for the CA')
    spawnSync('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:4096',
        '-keyout',
        config.ca_key_file,
        '-out',
        config.ca_cert_file,
        '-sha256',
        '-days',
        '3650',
        '-nodes',
        '-subj',
        '/CN=' + config.hostname,
    ])
    keypem = readFileSync(config.ca_key_file).toString('utf-8')
    certpem = readFileSync(config.ca_cert_file).toString('utf-8')

    return { key: keypem, cert: certpem }
}

const ca = loadOrCreateCert()

// Appliances that reach us by redirection rather than by setup still ask for an LG hostname, which
// varies between units of the same model. Serve each requested name its own certificate, signed by
// the CA they already trust; anything else keeps getting `ca` itself.
const issuer = new CertificateIssuer(config.ca_cert_file, config.ca_key_file, config.hostname)
const tlsOptions = { ...ca, SNICallback: issuer.SNICallback }

// Thinq1
function t1setup(manager: DeviceManager) {
    // Thinq1 HTTPS server
    const app = express()
    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        next()
    })

    app.use(thinq1Routes(config))

    // fallback
    app.use((req, res) => {
        res.json({})
    })

    https.createServer(tlsOptions, app).listen(config.thinq1_https_port.bind)
    const acceptor = new T1Acceptor()
    tls.createServer(tlsOptions, acceptor.accept.bind(acceptor)).listen(config.thinq1_port.bind)
    acceptor.on('newDevice', manager.accept.bind(manager))
}

// Thinq2
function t2setup(manager: DeviceManager) {
    // Thinq2 HTTPS server
    const app = express()
    app.use(express.json())

    app.use(function (req, res, next) {
        log('HTTPS', req.hostname, req.url)
        next()
    })

    // `ca`, not `tlsOptions`: these routes hand out the CA itself and sign appliance certificates
    // with it. An appliance pins what it gets here, so it has to be the CA, never a per-name leaf.
    app.use(thinq2Routes(config, ca))

    // fallback
    app.use((req, res) => {
        res.header('content-type', 'text/xml;charset=utf-8')
        res.end('')
    })

    https.createServer(tlsOptions, app).listen(config.https_port.bind)

    // internal MQTT broker
    const broker = new Broker()

    if (config.mqtt) {
        tls.createServer(tlsOptions, broker.accept.bind(broker)).listen(config.mqtts_port.bind)
        net.createServer({}, broker.accept.bind(broker)).listen(config.mqtt_port.bind)
    }

    const acceptor = new T2Acceptor(broker)
    acceptor.on('newDevice', manager.accept.bind(manager))
}

// HA connector
const externalDrivers = await loadExternalDrivers(config.drivers_dir, builtinDriverModels)
const ha = new HA_bridge(new HA_connection(config.homeassistant), externalDrivers)
const manager = new DeviceManager()
manager.on('newDevice', (dev) => ha.newDevice(dev))

t1setup(manager)
t2setup(manager)

let bridge: Bridge | undefined
if (config.bridge) {
    mkdirSync(config.bridge.storage_path, { recursive: true })
    const storage = new JSONStorage(config.bridge.storage_path)
    bridge = new Bridge(storage, manager)
}

if (config.management_port) Management.app(ha, manager, bridge).listen(config.management_port.bind)

console.log('Rethink cloud ready')
