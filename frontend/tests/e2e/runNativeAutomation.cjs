const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'../../..'),frontend=path.join(root,'frontend'),node=process.execPath;
const mode=process.argv[2] || 'native';
if (!['native','native16k','bridge'].includes(mode) || Number(process.versions.node.split('.')[0]) !== 24) throw Error('Use Node 24 and mode native, native16k or bridge');
const java=process.env.JAVA_HOME || path.join(root,'.tools/java21/jdk-21.0.12.1+1-jre');
const env={...process.env,PATH:path.dirname(node)+';'+path.join(java,'bin')+';'+process.env.PATH,JAVA_HOME:java,JAVA_TOOL_OPTIONS:'-Xmx384m',
 SYSU_NATIVE_BRIDGE:mode==='bridge'?'1':'0',SYSU_NATIVE_PAGE_SIZE:mode==='native16k'?'16384':'',
 SYSU_NATIVE_CLASS:process.env.SYSU_NATIVE_CLASS || 'com.sysu.go.NativeWorkflowTest,com.sysu.go.NativeCameraTest',
 PLAYWRIGHT_BROWSERS_PATH:process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(root,'.tools/playwright-browsers'),
 SYSU_E2E_DIST:'.tools/native-bridge-dist',SYSU_E2E_BACKEND_PORT:'18080',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8085',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 VITE_RELEASE_TARGET:'local',VITE_API_URL:'http://127.0.0.1:18080',VITE_SOCKET_URL:'http://127.0.0.1:18080',VITE_DRIVER_TRACKING_URL:'http://127.0.0.1:3000',
 VITE_FIREBASE_PROJECT_ID:'demo-sysu-security',VITE_FIREBASE_API_KEY:'demo-key',VITE_FIREBASE_AUTH_DOMAIN:'demo-sysu-security.firebaseapp.com',
 VITE_FIREBASE_STORAGE_BUCKET:'demo-sysu-security.appspot.com',VITE_FIREBASE_APP_ID:'1:123:web:synthetic',
 VITE_AUTH_EMULATOR_URL:'http://127.0.0.1:9099',VITE_FIRESTORE_EMULATOR_HOST:'127.0.0.1:8085',
 PLAYWRIGHT_JSON_OUTPUT_NAME:path.join(root,'.tools/native-bridge-result.json')};
delete env.FIREBASE_SERVICE_ACCOUNT_JSON;delete env.FIREBASE_SERVICE_ACCOUNT;delete env.GOOGLE_APPLICATION_CREDENTIALS;
fs.mkdirSync(path.join(root,'.tools'),{recursive:true});
if (mode==='bridge') {
 const build=spawnSync(node,['node_modules/vite/bin/vite.js','build','--outDir',path.join(root,'.tools/native-bridge-dist')],{cwd:frontend,env,encoding:'utf8'});
 fs.writeFileSync(path.join(root,'.tools/native-bridge-build.log'),build.stdout+build.stderr);
 if(build.status!==0){console.error('Isolated two-backend build failed');process.exit(1);}
}
const command='"'+node.replaceAll('\\','/')+'" "'+path.join(__dirname,'nativeServer.cjs').replaceAll('\\','/')+'"';
const run=spawnSync(node,[path.join(root,'backend/node_modules/firebase-tools/lib/bin/firebase.js'),
 'emulators:exec','--config',path.join(root,'firebase.test.json'),'--project','demo-sysu-security','--only','auth,firestore',command],
 {cwd:root,env,stdio:'inherit'});
process.exit(run.status??1);
