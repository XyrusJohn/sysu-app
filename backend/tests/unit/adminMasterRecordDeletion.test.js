const test = require('node:test');
const assert = require('node:assert/strict');

const records = new Map();
const key = (collection, id) => `${collection}/${id}`;
function document(collection, id) {
  const ref = {
    collection,
    id,
    async get() {
      const value = records.get(key(collection, id));
      return {id, exists: value !== undefined, data: () => value};
    },
    async set(value) { records.set(key(collection, id), value); },
  };
  return ref;
}
const db = {
  collection(name) {
    return {
      doc: id => document(name, id),
      async get() {
        const docs = [...records.entries()]
          .filter(([recordKey]) => recordKey.startsWith(`${name}/`))
          .map(([recordKey, value]) => ({id: recordKey.slice(name.length + 1), exists: true, data: () => value}));
        return {docs};
      },
    };
  },
  async runTransaction(callback) {
    const writes = [];
    const result = await callback({
      get: ref => ref.get(),
      set: (ref, value) => writes.push(() => records.set(key(ref.collection, ref.id), value)),
      create: (ref, value) => writes.push(() => records.set(key(ref.collection, ref.id), value)),
      delete: ref => writes.push(() => records.delete(key(ref.collection, ref.id))),
    });
    writes.forEach(write => write());
    return result;
  },
};
const configPath = require.resolve('../../src/config/firebase');
require.cache[configPath] = {id:configPath,filename:configPath,loaded:true,exports:{admin:{firestore:()=>db}}};

const guards = require('../../src/controllers/admin/guardController');
const companies = require('../../src/controllers/admin/truckCompanyController');
function invoke(handler, params = {}, body = {}) {
  return new Promise((resolve, reject) => {
    const response = {status(code) { this.statusCode = code; return this; }, json(value) { resolve({status:this.statusCode, body:value}); }};
    handler({params, body}, response, reject);
  });
}

test.beforeEach(() => records.clear());

for (const {label, collection, controller, createBody, paramName} of [
  {label:'guard', collection:'security_guard', controller:guards, createBody:{firstName:'Synthetic',lastName:'Guard'}, paramName:'id'},
  {label:'truck company', collection:'truck_company', controller:companies, createBody:{forwarderCode:'TEST-DELETE',name:'Synthetic Company'}, paramName:'code'},
]) {
  const create = label === 'guard' ? controller.createGuard : controller.createTruckCompany;
  const remove = label === 'guard' ? controller.deleteGuard : controller.deleteTruckCompany;
  test(`delete ${label} preserves sequential ID high-water mark`, async () => {
    const created = await invoke(create, {}, createBody);
    const removed = await invoke(remove, {[paramName]:created.body.id});
    assert.equal(removed.status, 200);
    assert.equal((await db.collection(collection).doc(created.body.id).get()).exists, false);

    const next = await invoke(create, {}, {...createBody, forwarderCode:'TEST-NEXT', firstName:'Next'});
    assert.notEqual(next.body.id, created.body.id);
  });

  test(`delete ${label} returns 404 for missing records`, async () => {
    const removed = await invoke(remove, {[paramName]:label === 'guard' ? 'SG-999' : '999'});
    assert.equal(removed.status, 404);
  });
}

test('delete controllers reject malformed sequential IDs', async () => {
  assert.equal((await invoke(guards.deleteGuard, {id:'bad-id'})).status, 400);
  assert.equal((await invoke(companies.deleteTruckCompany, {code:'bad-code'})).status, 400);
});
