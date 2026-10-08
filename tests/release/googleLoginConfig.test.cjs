const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const mobile=path.resolve(root,'../sysu-go');
const variant=process.env.SYSU_LOGIN_VARIANT||'debug';
if(!['debug','liveTest','release'].includes(variant))throw Error('Only operational APK variants are accepted');
const project='sysu-web-5a25d',packageName='com.sysu.go';
const cloud=JSON.parse(fs.readFileSync(path.join(root,'.tools/google-android-config-current.json'),'utf8'));
const build=fs.readFileSync(path.join(mobile,`app/build/generated/source/buildConfig/${variant}/com/sysu/go/BuildConfig.java`),'utf8');
const configString=name=>build.match(new RegExp(`\\b${name} = "([^"]*)"`))?.[1];
const resourceString=name=>compiledResources.match(new RegExp(`string/${name}\\s+\\(\\) "([^"]*)"`))?.[1];
const sdk=path.join(process.env.LOCALAPPDATA,'Android/Sdk/build-tools/36.0.0');
const apk=path.join(mobile,`app/build/outputs/apk/${variant}/app-${variant}.apk`);
const signer=execFileSync('C:/Program Files/Android/Android Studio1/jbr/bin/java.exe',['-jar',path.join(sdk,'lib/apksigner.jar'),'verify','--print-certs',apk],{encoding:'utf8'});
const sha1=signer.match(/certificate SHA-1 digest: ([a-f0-9]+)/)?.[1];
const manifest=execFileSync(path.join(sdk,'aapt2.exe'),['dump','badging',apk],{encoding:'utf8'});
const actualPackage=manifest.match(/^package: name='([^']+)'/)?.[1];
const compiledResources=execFileSync(path.join(sdk,'aapt2.exe'),['dump','resources',apk],{encoding:'utf8',maxBuffer:16*1024*1024});

test('Android Studio operational build uses the existing production Firebase app',()=>{
  assert.equal(resourceString('project_id'),project);
  assert.equal(resourceString('google_app_id'),'1:713214426806:android:3e10b702bf9330074d7017');
});
test('operational build routes Auth and services to production regardless of DEBUG',()=>{
  assert.equal(configString('APPLICATION_ID'),packageName);
  assert.equal(configString('API_BASE_URL'),'https://sysu-go-production.up.railway.app');
  assert.equal(configString('SOCKET_URL'),'https://sysu-go-production.up.railway.app');
  assert.equal(configString('FRONTEND_URL'),'https://sysu-web-5a25d.web.app');
  assert.match(build,/USE_FIREBASE_EMULATORS = false;/);
});
test('actual signed APK package and certificate have a matching production Android OAuth client',()=>{
  assert.equal(actualPackage,packageName);
  assert.match(sha1,/^[a-f0-9]{40}$/);
  const registered=cloud.client.some(client=>client.client_info.android_client_info.package_name===actualPackage&&
    (client.oauth_client||[]).some(oauth=>oauth.client_type===1&&oauth.android_info.package_name===actualPackage&&
      oauth.android_info.certificate_hash.toLowerCase().replaceAll(':','')===sha1));
  assert.equal(registered,true,'APK signing certificate is absent from production Android OAuth clients');
});
test('the compiled Google sign-in audience is a web OAuth client in the same production app',()=>{
  assert.equal(cloud.project_info.project_id,project);
  const client=cloud.client.find(client=>client.client_info.android_client_info.package_name===packageName);
  assert.ok(client,'Expected production Android app');
  assert.ok(client.oauth_client.some(oauth=>oauth.client_type===3&&oauth.client_id===resourceString('default_web_client_id')),
    'Compiled Google sign-in web client is not registered for the production project');
});
