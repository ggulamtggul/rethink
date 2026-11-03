import { X509Certificate } from 'node:crypto'
import type { TLSSocket } from 'node:tls'

/**
 * What a connecting appliance's client certificate says about how the appliance is attached.
 *
 * An appliance that was set up through this server (SoftAP adoption) holds a certificate this
 * server's CA issued, and is stranded if the server goes away. An appliance that still holds
 * its LG-issued certificate only reaches us because its traffic is redirected; remove the
 * redirection and it talks to LG again. Telling the two apart used to mean reading tea leaves
 * (state files, deploy logs) - the certificate the appliance itself presents at connect time
 * is the ground truth, so that is what the panel shows.
 */
export interface PeerCertInfo {
    /** Issuer of the presented certificate, e.g. "CN=Rethink CA". */
    issuer: string
    /** True when the certificate verifies against this server's own CA (adopted by us). */
    ours: boolean
}

/** Classify a presented certificate (DER) against our CA certificate (PEM). */
export function classifyPeerCertificate(raw: Buffer, caCertPem: string): PeerCertInfo | undefined {
    try {
        const cert = new X509Certificate(raw)
        const ca = new X509Certificate(caCertPem)
        return { issuer: cert.issuer, ours: cert.verify(ca.publicKey) }
    } catch {
        return undefined
    }
}

/**
 * The peer certificate of a TLS socket, classified. Returns undefined for plain sockets,
 * sockets whose peer presented no certificate, and certificates we cannot parse - the
 * caller shows those as "unknown" rather than guessing.
 */
export function peerCertificateInfo(socket: unknown, caCertPem: string): PeerCertInfo | undefined {
    const s = socket as TLSSocket | undefined
    if (!s || typeof s.getPeerCertificate !== 'function') return undefined
    const peer = s.getPeerCertificate()
    if (!peer || !peer.raw) return undefined
    return classifyPeerCertificate(peer.raw, caCertPem)
}
