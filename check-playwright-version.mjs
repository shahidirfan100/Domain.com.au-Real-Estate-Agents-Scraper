import playwrightPackage from 'playwright/package.json' with { type: 'json' };

import packageJson from './package.json' with { type: 'json' };

const expected = packageJson.dependencies?.playwright;
const actual = playwrightPackage.version;

if (!expected) {
    throw new Error('Missing playwright dependency in package.json');
}

if (expected !== actual) {
    throw new Error(`Playwright version mismatch. package.json=${expected}, installed=${actual}`);
}
