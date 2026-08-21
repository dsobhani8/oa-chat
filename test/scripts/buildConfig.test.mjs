import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizePublicOrigin,
    resolveBuildOrgOrigin
} from '../../scripts/buildConfig.mjs';

test('normalizes a configured HTTPS org origin', () => {
    assert.equal(
        resolveBuildOrgOrigin({ OA_ORG_ORIGIN: ' https://org-staging.openanonymity.ai/ ' }),
        'https://org-staging.openanonymity.ai'
    );
    assert.equal(resolveBuildOrgOrigin({}), null);
});

test('allows HTTP only for explicit loopback development origins', () => {
    assert.equal(
        normalizePublicOrigin('http://localhost:8005'),
        'http://localhost:8005'
    );
    assert.throws(
        () => normalizePublicOrigin('http://org-staging.openanonymity.ai'),
        /must use HTTPS/
    );
});

test('rejects configured values that are not bare public origins', () => {
    for (const value of [
        'not-a-url',
        'https://user:password@org-staging.openanonymity.ai',
        'https://org-staging.openanonymity.ai/api',
        'https://org-staging.openanonymity.ai?environment=staging',
        'https://org-staging.openanonymity.ai#staging'
    ]) {
        assert.throws(() => normalizePublicOrigin(value));
    }
});
