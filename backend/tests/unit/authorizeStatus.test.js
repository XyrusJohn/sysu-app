const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('HTTP authorization requires an explicitly active account and allowed role', async () => {
    for (const profile of [null, {role:'driver'}, {role:'driver',status:null},
        {role:'driver',status:'pending'}, {role:'driver',status:'inactive'},
        {role:'driver',status:'disabled'}, {role:'viewer',status:'active'},
        {role:'driver',status:'active'}]) {
        const context = {module:{exports:{}}, console,
            require: () => ({admin:{firestore: () => ({collection: () => ({doc: () => ({
                get: async () => ({data: () => profile}),
            })})})}})};
        vm.runInNewContext(fs.readFileSync(require.resolve('../../src/middleware/authorize.js'),'utf8'), context);
        let status, allowed = false;
        const req = {user:{uid:'synthetic-driver'}};
        const res = {status(code){status=code;return this;},json(){return this;}};
        await context.module.exports.authorize(['driver'])(req,res,() => {allowed=true;});
        assert.equal(allowed, profile?.role === 'driver' && profile?.status === 'active');
        if (!allowed) assert.equal(status,403);
        else assert.equal(req.userData,profile);
    }
});
