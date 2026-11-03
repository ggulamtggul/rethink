import { X509Certificate } from 'node:crypto'
import type { TLSSocket } from 'node:tls'

/**
 * What a connecting appliance's client certificate says about how the appliance is attached.
 *
 * An appliance that was set up through this server (SoftAP adoption) holds a certificate this
 * server's CA issued, and is stranded if the server goes away. An appliance that still holds
 * its LG-issued certificate only reaches us because its traffic is redirected - and removing
 * the redirection does not free it either, because setup also pinned this CA as what the
 * appliance trusts on the server side, so it rejects LG's genuine certificates (measured
 * 2026-11-03: redirection removed, appliance stayed offline). Telling the two apart used to
 * mean reading tea leaves
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

export interface ServerCertInfo {
    /** The server name (SNI) the appliance asked for - the identity this server claims. */
    name: string
    /** Issuer of the certificate served for that name: this server's own CA. */
    issuer: string
}

/**
 * What this server presents to a connecting appliance: a certificate carrying the name the
 * appliance asked for (an LG server name), minted by this server's own CA. LG's identity by
 * name only - the issuer gives it away, which is exactly how the owner can tell it apart
 * from a genuine LG-issued certificate in the panel.
 */
export function serverCertificateInfo(socket: unknown, caCertPem: string): ServerCertInfo | undefined {
    const s = socket as TLSSocket | undefined
    if (!s) return undefined
    const name = (s as unknown as { servername?: string }).servername
    if (!name) return undefined
    try {
        return { name, issuer: new X509Certificate(caCertPem).subject }
    } catch {
        return undefined
    }
}
