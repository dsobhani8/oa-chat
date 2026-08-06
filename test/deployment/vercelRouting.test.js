import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const config = JSON.parse(
    await readFile(path.resolve(process.cwd(), 'vercel.json'), 'utf8')
);

test('Vercel serves dist and proxies only approved org path prefixes before the SPA fallback', () => {
    assert.equal(config.outputDirectory, 'dist');
    assert.deepEqual(config.rewrites, [
        {
            source: '/auth/:path*',
            destination: 'https://labour-divine-sides-parts.trycloudflare.com/auth/:path*'
        },
        {
            source: '/api/:path*',
            destination: 'https://labour-divine-sides-parts.trycloudflare.com/api/:path*'
        },
        {
            source: '/chat/:path*',
            destination: 'https://labour-divine-sides-parts.trycloudflare.com/chat/:path*'
        },
        {
            source: '/:path*',
            destination: '/index.html'
        }
    ]);
});

test('Vercel routing never forwards privileged org or station prefixes', () => {
    const externalDestinations = config.rewrites
        .map(rule => rule.destination)
        .filter(destination => destination.startsWith('https://'));
    for (const forbidden of ['station', 'admin', 'verifier', 'dashboard', 'health', 'diagnostic']) {
        assert.equal(externalDestinations.some(destination => destination.includes(`/${forbidden}`)), false);
    }
});
