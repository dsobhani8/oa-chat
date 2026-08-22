import test from 'node:test';
import assert from 'node:assert/strict';

import networkLogger from '../../chat/services/networkLogger.js';

test('redacts inference tickets even when a request may roll back', () => {
    const headers = networkLogger.sanitizeHeaders({
        Authorization: 'InferenceTicket token=still-usable-after-rollback'
    });

    assert.equal(headers.Authorization, 'InferenceTicket [REDACTED]');
});

test('redacts bearer tokens without retaining prefixes or suffixes', () => {
    const headers = networkLogger.sanitizeHeaders({
        authorization: 'Bearer child-secret-value'
    });

    assert.equal(headers.authorization, 'Bearer [REDACTED]');
});

test('log entries redact nested child keys without mutating the response', () => {
    const response = {
        key: 'child-secret-value',
        key_hash: 'safe-hash',
        nested: { api_key: 'nested-secret' }
    };

    const entry = networkLogger.logRequest({
        type: 'api-key',
        method: 'POST',
        status: 200,
        response
    });

    assert.equal(entry.response.key, '[REDACTED]');
    assert.equal(entry.response.key_hash, 'safe-hash');
    assert.equal(entry.response.nested.api_key, '[REDACTED]');
    assert.equal(response.key, 'child-secret-value');
});

test('OpenRouter 403 diagnostics hide provider workspace-management details', () => {
    const rawMessage = 'Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/default/keys/example';
    const entry = networkLogger.logRequest({
        type: 'openrouter',
        method: 'POST',
        status: 403,
        response: { error: { message: rawMessage } },
        error: rawMessage
    });

    assert.match(entry.error, /Inference access could not be refreshed/);
    assert.match(entry.response.error.message, /Inference access could not be refreshed/);
    assert.doesNotMatch(JSON.stringify(entry), /openrouter\.ai|workspaces|\/keys\/example/i);
});

test('typed non-credit OpenRouter 403 diagnostics use generic policy copy', () => {
    const entry = networkLogger.logRequest({
        type: 'openrouter',
        method: 'POST',
        status: 403,
        response: {
            error: {
                message: 'Key limit exceeded (total limit)',
                metadata: { error_type: 'permission_denied' }
            }
        }
    });

    assert.match(entry.response.error.message, /access or policy restriction/);
    assert.doesNotMatch(entry.response.error.message, /could not be refreshed/);
});
