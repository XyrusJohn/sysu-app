const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../../..');
const backendPort=process.env.SYSU_E2E_BACKEND_PORT||'8080';
if(!/^\d+$/.test(backendPort)||Number(backendPort)<1024||Number(backendPort)>65535)throw new Error('Invalid isolated backend port');
if(process.env.FIRESTORE_EMULATOR_HOST!=='127.0.0.1:8085'||process.env.FIREBASE_AUTH_EMULATOR_HOST!=='127.0.0.1:9099')throw new Error('E2E requires isolated loopback emulators');
const work=path.join(root,'.tools/e2e-work');fs.mkdirSync(work,{recursive:true});
const rows=[{SAPDispatchNumber:'e2e-dispatch',OBDNumber:'000001',OBDItem:'001',Quantity:'10',ShipToPartyName:'Synthetic',ShipToParty:'1',Address:'Synthetic Address',TruckType:'4W',Driver:'',Delivery:'',PgiStatus:'X'}];
const sap=http.createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({d:{results:rows}}));}).listen(18081,'127.0.0.1');
const backend=spawn(process.execPath,[path.join(root,'backend/src/server.js')],{cwd:work,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,NODE_ENV:'development',PORT:backendPort,RELEASE_VERSION:'local-e2e',FIREBASE_PROJECT_ID:'demo-sysu-security',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8085',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',ALLOWED_ORIGINS:'http://127.0.0.1:5173',SAP_URL:'http://127.0.0.1:18081',RATE_LIMIT_MAX:'10000'},stdio:'ignore'});
const dist=path.resolve(root,process.env.SYSU_E2E_DIST||'.tools/clean-release-1/frontend/dist');
if(!dist.startsWith(root+path.sep))throw new Error('E2E artifact must be inside the workspace');
const staticServer=http.createServer((req,res)=>{
 let filename;try{filename=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);}catch{res.writeHead(400).end();return;}
 const file=path.resolve(dist,'.'+(filename==='/'?'/index.html':filename));
 if(!file.startsWith(dist+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};res.setHeader('Content-Type',types[path.extname(file)]||'application/octet-stream');fs.createReadStream(file).pipe(res);
});
(async()=>{for(let i=0;i<40;i++){if(backend.exitCode!==null)throw new Error('E2E backend startup failed');try{const response=await fetch(`http://127.0.0.1:${backendPort}/health/live`);const body=await response.json();if(body.version==='local-e2e'){staticServer.listen(5173,'127.0.0.1');return;}}catch{}await new Promise(r=>setTimeout(r,250));}throw new Error('E2E backend readiness timed out');})().catch(error=>{console.error(error.message);process.exit(1);});
const stop=()=>{backend.kill();sap.close();staticServer.close();process.exit(0);};process.once('SIGTERM',stop);process.once('SIGINT',stop);process.once('exit',()=>backend.kill());
