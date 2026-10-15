const test=require('node:test');
const assert=require('node:assert/strict');
const {validateAssignment}=require('../../src/services/sapAssignmentPolicy');
const row={SAPDispatchNumber:'dispatch-a',TruckType:'4W',OBDNumber:'000001',Quantity:'10.500',ShipToPartyName:'Synthetic'};
const body={dispatchKey:'dispatch-a',truckType:'4w',lineItems:[{obdNumber:'000001',quantity:10.5,customerName:'Synthetic'}]};
test('SAP policy retains source ordering and customer fallback with leading-zero OBD IDs',()=>{
  const fallback={...row,ShipToPartyName:'',ShipToParty:'Synthetic'};
  assert.deepEqual(validateAssignment([fallback],body).lineItems,body.lineItems);
});
test('SAP policy rejects a client-selected type different from the dispatch group type',()=>{
  assert.equal(validateAssignment([row],{...body,truckType:'40F'}).status,409);
});
test('temporary review exception with blank SAP truck type remains non-assignable',()=>{
  assert.equal(validateAssignment([{...row,TruckType:''}],body).status,409);
});
test('SAP policy rejects malformed source customer types instead of throwing an internal error',()=>{
  assert.equal(validateAssignment([{...row,ShipToPartyName:123}],body).status,409);
});
test('SAP policy rejects incomplete, invalid and excessive source quantities without guessing',()=>{
  for(const patch of [{OBDNumber:''},{ShipToPartyName:''},{Quantity:'0'},{Quantity:'garbage'},{Quantity:'12junk'},{Quantity:'99999999999999999'}]) {
    assert.equal(validateAssignment([{...row,...patch}],body).status,409);
  }
});
test('SAP policy treats rows as a multiset rather than silently deduplicating an OBD',()=>{
  assert.equal(validateAssignment([row,row],{...body,lineItems:[body.lineItems[0],body.lineItems[0]]}).status,200);
  assert.equal(validateAssignment([row,row],body).status,409);
});
