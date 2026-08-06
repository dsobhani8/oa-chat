import { ORG_API_BASE } from '../../config.js';

const LOOPBACK_HOSTNAMES = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '::1'
]);

// Deployment-only billing demo exception. The production source revision keeps
// verifier enforcement; this exact-host exception exists only in the generated
// Vercel production artifact while collaborator-owned verifier setup is unavailable.
const BILLING_DEMO_HOSTNAME = 'oa-billing-demo.vercel.app';

function normalizeHostname(value) {
    return String(value || '').trim().toLowerCase();
}

export function isExplicitLoopbackHostname(hostname) {
    return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

export function isLocalVerifierBypassAllowed(options = {}) {
    const locationLike = options.locationLike ??
        (typeof window !== 'undefined' ? window.location : null);
    const orgApiBase = options.orgApiBase ?? ORG_API_BASE;

    try {
        const orgUrl = new URL(orgApiBase);
        const locationHostname = normalizeHostname(locationLike?.hostname);
        const locationProtocol = String(locationLike?.protocol || '');
        const loopback = ['http:', 'https:'].includes(locationProtocol) &&
            ['http:', 'https:'].includes(orgUrl.protocol) &&
            isExplicitLoopbackHostname(locationHostname) &&
            isExplicitLoopbackHostname(orgUrl.hostname);
        const billingDemo = locationProtocol === 'https:' &&
            orgUrl.protocol === 'https:' &&
            locationHostname === BILLING_DEMO_HOSTNAME &&
            normalizeHostname(orgUrl.hostname) === BILLING_DEMO_HOSTNAME;
        return loopback || billingDemo;
    } catch {
        return false;
    }
}
