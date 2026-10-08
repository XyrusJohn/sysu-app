const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const helperPath=path.resolve(__dirname,'../../src/migrations/releaseMigration.js');
async function run(kind,env={},items=[]) {
  let writes=0, initialized=0, persisted;
  const docs=items.map((data,index)=>({id:`synthetic-${index}`,data:()=>data,ref:{id:`synthetic-${index}`,path:`sap_assignments/synthetic-${index}`,updateTime:'version'}}));
  const snapshot={docs,size:docs.length,empty:!docs.length};
  const query={get:async()=>snapshot,orderBy(){return this;},limit(){return this;},startAfter(){return this;}};
  const db={collection:()=>query,batch:()=>({update(_ref,patch){writes++;persisted=patch;},commit:async()=>{}})};
  if (fs.existsSync(helperPath)) {
    const result=await require(helperPath).runMigration({kind,env,db,initialize:()=>{initialized++;},
      applyDocument:async (_doc,patch)=>{writes++;persisted=patch;}});
    return {writes,initialized,persisted,result};
  }
  const filename=kind==='line-items'?'migrate-obd-lineitems.js':'migrate-sap-assignments-driver-uid.js';
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../../scripts',filename),'utf8'),{
    require:()=>({credential:{cert:()=>({}),applicationDefault:()=>({})},initializeApp(){initialized++;},firestore:()=>db}),
    process:{env,exit(){}},console:{log(){},error(){}},module:{exports:{}}});
  for(let n=0;n<30;n++) await Promise.resolve();
  return {writes,initialized,persisted};
}
const target={FIREBASE_PROJECT_ID:'demo-sysu-security',MIGRATION_PROJECT_ID:'demo-sysu-security'};
for(const kind of ['line-items','driver-uid']) {
  test(`R29 ${kind}: missing explicit target fails before Firebase initialization`,async()=>{
    await assert.rejects(run(kind),/project|target/i);
  });
  test(`R29 ${kind}: mismatched target assertion fails`,async()=>{
    await assert.rejects(run(kind,{...target,MIGRATION_PROJECT_ID:'other-project'}),/project|target/i);
  });
}
test('R29 line-items defaults to dry-run with no write',async()=>{
  const result=await run('line-items',target,[{lineItems:[{obdNumber:'000001',quantity:'10.5',customerName:'Synthetic',amount:10}]}]);
  assert.equal(result.writes,0);
});
test('R29 apply requires an exact project confirmation and run identifier',async()=>{
  await assert.rejects(run('line-items',{...target,MIGRATION_MODE:'apply'}),/confirm|run/i);
});
const apply={...target,MIGRATION_MODE:'apply',MIGRATION_CONFIRM_PROJECT:'demo-sysu-security',MIGRATION_RUN_ID:'synthetic-run'};
test('R30 mixed migrated and legacy items all transform with leading zero IDs preserved',async()=>{
  const result=await run('line-items',apply,[{lineItems:[{obdNumber:'000001',quantity:2,customerName:'Synthetic'},
    {obdNumber:'000002',quantity:'10.5',customerName:'Synthetic',amount:9}]}]);
  assert.equal(result.writes,1);
  assert.equal(result.persisted.lineItems[1].quantity,10.5);
  assert.equal(result.persisted.lineItems[1].obdNumber,'000002');
  assert.equal('amount' in result.persisted.lineItems[1],false);
});
test('R30 missing customer is unresolved instead of guessed from truckCompany',async()=>{
  const result=await run('line-items',apply,[{lineItems:[{obdNumber:'000001',quantity:2,truckCompany:'NOT A CUSTOMER',amount:9}]}]);
  assert.equal(result.writes,0);
});
test('R30 invalid quantities do not silently become zero or parse partial strings',async()=>{
  for(const quantity of ['bad','12junk',0,-1,Infinity,null]) {
    const result=await run('line-items',apply,[{lineItems:[{obdNumber:'000001',quantity,customerName:'Synthetic',amount:9}]}]);
    assert.equal(result.writes,0,String(quantity));
  }
});
