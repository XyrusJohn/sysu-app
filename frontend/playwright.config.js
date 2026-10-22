import {defineConfig,devices} from '@playwright/test';
const nativeBridgeOnly=process.env.SYSU_NATIVE_BRIDGE==='1';
export default defineConfig({
  testDir:'./tests/e2e',testMatch:'**/*.e2e.js',workers:1,fullyParallel:false,
  timeout:30000,retries:0,reporter:'list',outputDir:'../.tools/e2e-artifacts',
  use:{baseURL:'http://127.0.0.1:5173',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[
    {name:'desktop',testIgnore:nativeBridgeOnly?[]:['**/nativeBridge.e2e.js'],use:{...devices['Desktop Chrome']}},
    {name:'mobile-web',testIgnore:nativeBridgeOnly?['**/socketTransport.e2e.js']:['**/socketTransport.e2e.js','**/nativeBridge.e2e.js'],use:{...devices['Pixel 7']}},
  ],
  webServer:{command:'node tests/e2e/localServer.cjs',url:'http://127.0.0.1:5173',reuseExistingServer:false,timeout:30000},
});
