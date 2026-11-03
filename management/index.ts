import { WebSocketExpress, ExtendedWebSocket } from 'websocket-express'

import path from 'path'
import { fileURLToPath } from 'url'
import log from '@/util/logging'

import HA_bridge from '@/cloud/ha_bridge'
import { AnyDevice, DeviceManager } from '@/cloud/devmgr'
import { Bridge } from '@/bridge'
import { Request, Response } from 'express'
import { Device as T1Device } from '@/cloud/thinq1/device'
import { Device as T2Device } from '@/cloud/thinq2/device'

export function app(ha: HA_bridge, manager: DeviceManager, bridge: Bridge | undefined) {
    const app = new WebSocketExpress()
    let subscribers: ExtendedWebSocket[] = []

    // device management
    function broadcast(message: object) {
        const str = JSON.stringify(message)
        subscribers.forEach((sub) => {
            sub.send(str)
        })
    }

    function statusReport(message: string) {
        broadcast({ status: message })
    }

    app.use(function (req, res, next) {
        log('MGMT', req.hostname, req.url)
        next()
    })
    app.use(WebSocketExpress.json())

    // Device names live in the ThinQ account, not on the appliances. Refresh them when someone is
    // actually looking at the panel, at most once a minute, and keep them fresh while it stays open.
    let lastNamesRefresh = 0
    let refreshNamesTimer: ReturnType<typeof setInterval> | undefined

    function maybeRefreshNames() {
        if (!bridge) return
        const now = Date.now()
        if (now - lastNamesRefresh < 60_000) return
        lastNamesRefresh = now
        void bridge.refreshNames()
    }

    const currentDir = path.dirname(fileURLToPath(import.meta.url))
    app.ws('/ws', (req, res, next) => {
        res.accept().then((ws) => {
            subscribers.push(ws)
            maybeRefreshNames()
            if (!refreshNamesTimer) refreshNamesTimer = setInterval(maybeRefreshNames, 15 * 60_000)

            ws.send(
                JSON.stringify({
                    ha: ha.HA.isConnected,
                    bridge: bridgeStatus(),
                    devices: enumDevices(),
                }),
            )

            ws.on('message', (msg) => {})

            ws.on('close', () => {
                subscribers = subscribers.filter((el) => el !== ws)
                if (subscribers.length === 0 && refreshNamesTimer) {
                    clearInterval(refreshNamesTimer)
                    refreshNamesTimer = undefined
                }
            })
        }, next)
    })

    ha.HA.on('statusChanged', (ha) => {
        broadcast({ ha })
    })

    function enumDevices() {
        const allDevices: Record<string, any> = {}
        for (const id in manager.allDevices) {
            const dev = manager.allDevices[id]
            const meta = dev.meta
            allDevices[id] = {
                // What the owner calls it, when the bridge has been able to ask the account
                name: bridge ? bridge.name(id) : undefined,
                model: meta.modelId,
                deviceType: meta.deviceType,
                platform: dev.platform,
                // Who issued the certificate the device presented on this connection:
                // ours = adopted by this server, otherwise LG-issued (redirected here).
                // Absent when no certificate was presented or the platform has none.
                peerCert: 'peerCert' in dev ? dev.peerCert : undefined,
                // The certificate this server presents to the device: an LG server name,
                // minted by this server's own CA. Absent when not captured.
                serverCert: 'serverCert' in dev ? dev.serverCert : undefined,
                mapped: ha.haDevices.has(id),
                bridged: bridge ? bridge.status(id) : false,
            }
        }
        return allDevices
    }

    function refreshDevices() {
        broadcast({ devices: enumDevices() })
    }

    function onNewDevice(dev: AnyDevice) {
        refreshDevices()
    }

    manager.on('newDevice', onNewDevice)
    manager.on('dropDevice', refreshDevices)

    if (bridge) {
        app.get(
            '/thinq_login',
            asyncHandler(async (req, res) => {
                res.redirect((await bridge.beginLogin({ countryCode: req.query.countryCode as string })).toString())
            }),
        )

        app.post(
            '/thinq_login_accept',
            asyncHandler(async (req, res) => {
                const url = `${req.body.url}`
                const countryCode = `${req.body.countryCode}`
                if (await bridge.completeLogin({ countryCode }, new URL(url))) {
                    res.statusCode = 200
                    res.end()
                } else {
                    res.statusCode = 400
                    res.end()
                }
            }),
        )

        app.post(
            '/thinq_logout',
            asyncHandler(async (req, res) => {
                await bridge.logout()
                res.end()
            }),
        )

        app.get(
            '/bridge/:deviceId/modeljson',
            asyncHandler(async (req, res) => {
                try {
                    const { modelName, modelJson } = await bridge.getModelJson(req.params.deviceId)
                    // the model name comes from the device, don't let it break out of the header
                    const fileName = modelName.replace(/[^A-Za-z0-9._-]/g, '_') || 'model'
                    res.setHeader('Content-Type', 'application/json')
                    res.setHeader('Content-Disposition', `attachment; filename="${fileName}.json"`)
                    res.end(modelJson)
                } catch (err) {
                    res.status(500).end(`${err}`)
                }
            }),
        )

        app.post(
            '/bridge/:deviceId/enable',
            asyncHandler(async (req, res) => {
                const deviceType = typeof req.body.deviceType === 'string' ? (req.body.deviceType as string) : undefined
                try {
                    if (await bridge.enable(req.params.deviceId, deviceType, statusReport)) res.status(204).end()
                    else res.status(400).end()
                } catch (err) {
                    res.status(500).end(`${err}`)
                }
            }),
        )

        app.post(
            '/bridge/:deviceId/disable',
            asyncHandler(async (req, res) => {
                await bridge.disable(req.params.deviceId)
                res.status(204).end()
            }),
        )

        function refreshBridgeStatus() {
            broadcast({ bridge: bridgeStatus() })
        }

        bridge.on('loggedIn', refreshBridgeStatus)
        bridge.on('loggedOut', refreshBridgeStatus)
        bridge.on('started', refreshDevices)
        bridge.on('stopped', refreshDevices)
        bridge.on('namesChanged', refreshDevices)
    }

    function bridgeStatus() {
        if (bridge) return { loggedIn: bridge.isLoggedIn() }
    }

    // device monitoring
    app.ws('/device', (req, res, next) => {
        const id = req.query?.id
        if (typeof id !== 'string') {
            res.status(400).end()
            return
        }

        res.accept().then((ws) => {
            let injectFlag = false
            let device: AnyDevice | undefined
            const onDeviceRx = (arg: Buffer) => {
                ws.send(JSON.stringify({ rx: arg.toString('hex'), injected: injectFlag }))
            }

            const onDeviceTx = (arg: Buffer | object) => {
                if (Buffer.isBuffer(arg)) ws.send(JSON.stringify({ tx: arg.toString('hex'), injected: injectFlag }))
                else ws.send(JSON.stringify({ tx: JSON.stringify(arg), injected: injectFlag }))
            }

            const checkDevicePresence = () => {
                const dev = manager.allDevices[id]

                if (dev !== device) {
                    device?.removeListener('data', onDeviceRx)
                    device?.removeListener('sendData', onDeviceTx)

                    device = dev
                    if (device) {
                        ws.send(JSON.stringify({ status: 'online', meta: device.meta }))
                        device.on('data', onDeviceRx)
                        device.on('sendData', onDeviceTx)
                    } else {
                        ws.send(JSON.stringify({ status: 'offline' }))
                    }
                }
            }

            manager.on('newDevice', checkDevicePresence)
            manager.on('dropDevice', checkDevicePresence)

            checkDevicePresence()

            ws.on('message', (msg) => {
                if (!Buffer.isBuffer(msg)) return

                let json: any
                try {
                    json = JSON.parse(msg.toString('utf-8'))
                } catch {
                    return
                }
                const dev = manager.allDevices[id]

                try {
                    if (typeof json.sendToDevice === 'object' && dev && dev instanceof T1Device) {
                        try {
                            injectFlag = true
                            dev.send(json.sendToDevice)
                        } finally {
                            injectFlag = false
                        }
                    }

                    if (typeof json.sendToDevice === 'string' && dev && dev instanceof T2Device) {
                        try {
                            injectFlag = true
                            dev.send_packet(Buffer.from(json.sendToDevice, 'hex'))
                        } finally {
                            injectFlag = false
                        }
                    }

                    if (json.sendFromDevice && dev) {
                        try {
                            injectFlag = true
                            dev.emit('data', Buffer.from(json.sendFromDevice, 'hex'))
                        } finally {
                            injectFlag = false
                        }
                    }
                } catch (err) {
                    log('MGMT', id, `inject error: ${err}`)
                }
            })

            ws.on('close', () => {
                manager.removeListener('newDevice', checkDevicePresence)
                manager.removeListener('dropDevice', checkDevicePresence)
            })
        }, next)
    })

    // static pages. The panel is three small files that change with every server update, and a
    // browser left holding the previous panel.js renders new data with old code (device names
    // silently missing, for one real example) - so never let them be cached.
    app.use((req, res, next) => {
        if (/\.(html|js)$/.test(req.path)) res.setHeader('Cache-Control', 'no-cache')
        next()
    })
    app.use(WebSocketExpress.static(currentDir + '/../html', { extensions: ['html'] }))
    return app.createServer()
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<any>) {
    return (req: Request, res: Response, next: (err: any) => void) => {
        handler(req, res).catch(next)
    }
}
