const fs = require('node:fs');
const path = require('node:path');
const {spawn, spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '../../..');
const mobile = path.resolve(root, '../sysu-go');
const sdk = path.join(process.env.LOCALAPPDATA, 'Android/Sdk');
const adb = path.join(sdk, 'platform-tools/adb.exe');
const node = process.execPath;
const work = path.join(root,'.tools/e2e-work');
fs.mkdirSync(work,{recursive:true});
const instrumentationPath = path.join(root,'.tools/native-instrumentation.log');
if (process.env.SYSU_NATIVE_BRIDGE !== '1') fs.writeFileSync(instrumentationPath,'');
const serial = process.env.SYSU_NATIVE_SERIAL || 'emulator-5554';
if (!/^emulator-\d+$/.test(serial)) throw Error('Native automation requires a dedicated emulator');
const fixture = spawn(node, [path.join(root, 'frontend/tests/e2e/nativeFixture.cjs')], {env: process.env, stdio: ['ignore','pipe','pipe']});
const mobileLog = fs.openSync(path.join(root, '.tools/native-mobile-server.log'), 'w');
const mobileServer = spawn(node, ['--require',path.join(__dirname,'nativeHttpTrace.cjs'),path.join(mobile, 'backend/server.js')], {
  cwd: work,
  env: {PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,
    SYSU_ENV:'emulator',NODE_ENV:'development',PORT:'3000',FIREBASE_PROJECT_ID:'demo-sysu-security',
    FIRESTORE_EMULATOR_HOST:'127.0.0.1:8085',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',ALLOWED_ORIGINS:'http://127.0.0.1:5173'},
  stdio: ['ignore', mobileLog, mobileLog],
});
function android(args, allowFailure = false) {
  const result = spawnSync(adb, ['-s',serial,...args], {encoding:'utf8',timeout:120000});
  if (!allowFailure && result.status !== 0) throw Error('ADB step failed: ' + args.slice(0,3).join(' '));
  return result.stdout + result.stderr;
}
async function ready(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {if ((await fetch(url)).ok) return;} catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('Isolated readiness timeout');
}
(async () => {
  if (android(['shell','getprop','ro.kernel.qemu']).trim() !== '1') throw Error('Physical devices are outside this automation batch');
  const bootDeadline = Date.now()+120000;
  while (android(['shell','getprop','sys.boot_completed']).trim() !== '1') {
    if (Date.now() >= bootDeadline) throw Error('Dedicated emulator boot readiness timeout');
    await new Promise(resolve => setTimeout(resolve,1000));
  }
  const pageSize = android(['shell','getconf','PAGE_SIZE']).trim();
  const sdkVersion = Number(android(['shell','getprop','ro.build.version.sdk']).trim());
  if (!Number.isInteger(sdkVersion) || sdkVersion < 24) throw Error('Invalid emulator Android version');
  if (process.env.SYSU_NATIVE_PAGE_SIZE === '16384') {
    if (pageSize !== '16384') throw Error('Strict 16 KB run requires a 16 KB kernel');
    // Android 15 has native 16 KB support; compatibility fallback was introduced in Android 16.
    if (sdkVersion >= 36) {
      const linkerMode = sdkVersion >= 37 ? 'fatal' : 'false';
      android(['shell','setprop','bionic.linker.16kb.app_compat.enabled',linkerMode]);
      android(['shell','setprop','pm.16kb.app_compat.disabled','true']);
      if (android(['shell','getprop','bionic.linker.16kb.app_compat.enabled']).trim() !== linkerMode
          || android(['shell','getprop','pm.16kb.app_compat.disabled']).trim() !== 'true') {
        throw Error('Strict 16 KB compatibility settings were not applied');
      }
    }
  }
  console.log(JSON.stringify({pageSize,sdkVersion,strict16k:process.env.SYSU_NATIVE_PAGE_SIZE==='16384',
    compatibilityFallback:process.env.SYSU_NATIVE_PAGE_SIZE!=='16384'?'not-requested':
      sdkVersion<36?'unavailable-before-API-36':'disabled-and-verified'}));
  await ready('http://127.0.0.1:18082/state');
  await ready('http://127.0.0.1:3000/api/health');
  for (const setting of ['window_animation_scale','transition_animation_scale','animator_duration_scale']) {
    android(['shell','settings','put','global',setting,'0']);
  }
  android(['install','-r',path.join(mobile,'app/build/outputs/apk/emulator/app-emulator.apk')]);
  android(['install','-r',path.join(mobile,'app/build/outputs/apk/androidTest/emulator/app-emulator-androidTest.apk')]);
  for (const permission of ['ACCESS_COARSE_LOCATION','ACCESS_FINE_LOCATION','ACCESS_BACKGROUND_LOCATION','CAMERA','POST_NOTIFICATIONS']) {
    android(['shell','pm','grant','com.sysu.go.debug','android.permission.'+permission]);
  }
  android(['shell','dumpsys','deviceidle','whitelist','+com.sysu.go.debug']);
  android(['shell','appops','set','com.sysu.go.debug','android:mock_location','allow']);
  android(['shell','settings','put','global','stay_on_while_plugged_in','3']);
  android(['shell','input','keyevent','KEYCODE_WAKEUP']);
  android(['shell','wm','dismiss-keyguard']);
  if (process.env.SYSU_NATIVE_BRIDGE === '1') {
    const result = spawnSync(node,[path.join(root,'frontend/node_modules/@playwright/test/cli.js'),
      'test','nativeBridge.e2e.js','--reporter=list,json'],{cwd:path.join(root,'frontend'),env:process.env,stdio:'inherit'});
    process.exitCode = result.status ?? 1;
    return;
  }
  android(['shell','am','force-stop','com.sysu.go.debug']);
  const logPath = instrumentationPath;
  fs.writeFileSync(logPath,'');
  const result = await new Promise((resolve,reject) => {
    const child = spawn(adb,['-s',serial,'shell','am','instrument','-w','-r','-e','class',
    process.env.SYSU_NATIVE_CLASS || 'com.sysu.go.NativeWorkflowTest',
    'com.sysu.go.debug.test/androidx.test.runner.AndroidJUnitRunner']);
    let output = '';
    for (const stream of [child.stdout,child.stderr]) stream.on('data',chunk => {
      output += chunk.toString();
      fs.appendFileSync(logPath,chunk);
    });
    const timer = setTimeout(() => child.kill(),900000);
    child.on('error',error => {clearTimeout(timer);reject(error);});
    child.on('close',status => {clearTimeout(timer);resolve({status,output});});
  });
  const output = result.output;
  const passed = /OK \((\d+) tests?\)/.exec(output);
  const failure = /Tests run: (\d+),\s+Failures: (\d+)/.exec(output);
  console.log(JSON.stringify({suite:process.env.SYSU_NATIVE_CLASS || 'com.sysu.go.NativeWorkflowTest',passed:passed?Number(passed[1]):null,
    run:failure?Number(failure[1]):null,failed:failure?Number(failure[2]):null,
    exit:result.status,log:'.tools/native-instrumentation.log'}));
  process.exitCode = result.status===0 && passed && !/FAILURES!!!|INSTRUMENTATION_FAILED/.test(output) ? 0 : 1;
})().catch(error => { console.error(error.message); process.exitCode=1; })
  .finally(() => {fixture.kill();mobileServer.kill();fs.closeSync(mobileLog);});
