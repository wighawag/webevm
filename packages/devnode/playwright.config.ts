import {defineConfig, devices} from '@playwright/test';

// The same setup as packages/webevm: playwright-browser-harness brings up its
// OWN server per test (no `webServer` entry), and the suite runs on Chromium and
// WebKit, since the package ships to browsers like the node it decorates.
export default defineConfig({
	testDir: './test',
	fullyParallel: false,
	workers: 1,
	reporter: [['list']],
	timeout: 120_000,
	projects: [
		{name: 'chromium', use: {...devices['Desktop Chrome']}},
		{name: 'webkit', use: {...devices['Desktop Safari']}},
	],
});
