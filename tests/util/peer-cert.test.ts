import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { X509Certificate } from 'node:crypto'
import {
    classifyPeerCertificate,
    peerCertificateInfo,
    serverCertificateInfo,
} from '@/util/peer-cert'

// Fixtures in tests/fixtures/peer-cert: a test CA, a leaf it signed (what an adopted
// appliance presents), and a self-signed certificate from another issuer (what an
// LG-issued appliance certificate looks like to us - not ours, whatever its name).
const dir = join(import.meta.dirname, '..', 'fixtures', 'peer-cert')
const caPem = readFileSync(join(dir, 'ca.pem'), 'utf-8')
const leafRaw = new X509Certificate(readFileSync(join(dir, 'leaf.pem'))).raw
const foreignRaw = new X509Certificate(readFileSync(join(dir, 'foreign.pem'))).raw

describe('classifyPeerCertificate', () => {
    test('a certificate our CA signed is ours, with the issuer named', () => {
        const info = classifyPeerCertificate(leafRaw, caPem)
        assert.equal(info?.ours, true)
        assert.match(info?.issuer ?? '', /Test Rethink CA/)
    })

    test('a certificate from another issuer is not ours', () => {
        const info = classifyPeerCertificate(foreignRaw, caPem)
        assert.equal(info?.ours, false)
        assert.match(info?.issuer ?? '', /Other Issuer CA/)
    })

    test('garbage input classifies as unknown, not as an exception', () => {
        assert.equal(classifyPeerCertificate(Buffer.from('not a certificate'), caPem), undefined)
    })
})

describe('peerCertificateInfo', () => {
    test('a plain socket has no peer certificate', () => {
        assert.equal(peerCertificateInfo({}, caPem), undefined)
        assert.equal(peerCertificateInfo(undefined, caPem), undefined)
    })

    test('a TLS peer that presented nothing is unknown', () => {
        const fakeSocket = { getPeerCertificate: () => ({}) }
        assert.equal(peerCertificateInfo(fakeSocket, caPem), undefined)
    })

    test('a TLS peer certificate is read from the socket and classified', () => {
        const fakeSocket = { getPeerCertificate: () => ({ raw: leafRaw }) }
        const info = peerCertificateInfo(fakeSocket, caPem)
        assert.equal(info?.ours, true)
    })
})

describe('serverCertificateInfo', () => {
    test('the served name comes from the socket and the issuer is our own CA', () => {
        const fakeSocket = { servername: 'common.iot.kic.lgthinq.com' }
        const info = serverCertificateInfo(fakeSocket, caPem)
        assert.equal(info?.name, 'common.iot.kic.lgthinq.com')
        assert.match(info?.issuer ?? '', /Test Rethink CA/)
    })

    test('no requested name means nothing to report', () => {
        assert.equal(serverCertificateInfo({}, caPem), undefined)
        assert.equal(serverCertificateInfo(undefined, caPem), undefined)
        assert.equal(serverCertificateInfo({ servername: '' }, caPem), undefined)
    })

    test('an unreadable CA classifies as unknown, not as an exception', () => {
        const fakeSocket = { servername: 'kic-common.lgthinq.com' }
        assert.equal(serverCertificateInfo(fakeSocket, 'not a pem'), undefined)
    })
})
