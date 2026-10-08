import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/e2e',testMatch:'**/*.e2e.js',workers:1,fullyParallel:false,
  timeout:30000,retries:0,reporter:'list',outputDir:'../.tools/e2e-artifacts',
  use:{baseURL:'http://127.0.0.1:5173',trace:'retain-on-failure',screenshot:'only-on-failure'},
  webServer:{command:'node tests/e2e/localServer.cjs',url:'http://127.0.0.1:5173',reuseExistingServer:false,timeout:30000},
});
