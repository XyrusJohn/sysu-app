import {beforeEach, expect, test, vi} from 'vitest';
const mocks=vi.hoisted(()=>({authCallback:null, profiles:[], stopAuth:vi.fn()}));
vi.mock('firebase/auth',()=>({
  onAuthStateChanged:vi.fn((_auth,callback)=>{mocks.authCallback=callback; return mocks.stopAuth;}),
  signInWithEmailAndPassword:vi.fn(),signInWithPopup:vi.fn(),signOut:vi.fn(),setPersistence:vi.fn(),browserLocalPersistence:{},
}));
vi.mock('firebase/firestore',()=>({doc:vi.fn((_db,_collection,uid)=>uid),onSnapshot:vi.fn((uid,next)=>{
  const subscription={uid,next,stop:vi.fn()}; mocks.profiles.push(subscription); return subscription.stop;
})}));
vi.mock('./firebase',()=>({auth:{},db:{},googleProvider:{}}));
import {AuthService} from './authService';
beforeEach(()=>{mocks.profiles=[]; vi.clearAllMocks();});
const snapshot=uid=>({id:uid,exists:()=>true,data:()=>({role:'driver',name:uid})});

test('R22 disabled and inactive approved profiles sign out and never publish a usable profile',async()=>{
  const {signOut}=await import('firebase/auth');
  for(const status of ['disabled','inactive']){
    const callback=vi.fn();const stop=AuthService.subscribe(callback);await mocks.authCallback({uid:'a'});
    await mocks.profiles.at(-1).next({id:'a',exists:()=>true,data:()=>({role:'admin',status})});
    expect(callback.mock.calls.at(-1)[0]).toBeNull();expect(callback.mock.calls.at(-1)[1].message).toBe('ACCOUNT_DISABLED');
    expect(AuthService.getUserProfile()).toBeNull();stop();
  }
  expect(signOut).toHaveBeenCalledTimes(2);
});
test('R22 pending inactive registration remains eligible for its waiting screen',async()=>{
  const callback=vi.fn();const stop=AuthService.subscribe(callback);await mocks.authCallback({uid:'a'});
  await mocks.profiles.at(-1).next({id:'a',exists:()=>true,data:()=>({role:'pending',status:'inactive'})});
  expect(callback.mock.calls.at(-1)[0].role).toBe('pending');stop();
});
test('R37: account switch stops old profile listener and ignores queued stale callbacks',async()=>{
  const callback=vi.fn(); const stop=AuthService.subscribe(callback);
  await mocks.authCallback({uid:'a'});
  mocks.profiles[0].next(snapshot('a'));
  await mocks.authCallback({uid:'b'});
  expect(mocks.profiles[0].stop).toHaveBeenCalledOnce();
  mocks.profiles[1].next(snapshot('b'));
  mocks.profiles[0].next(snapshot('a'));
  expect(callback.mock.calls.at(-1)[0].id).toBe('b');
  stop();
});
test('R37: returned unsubscribe cleans both auth and profile listeners',async()=>{
  const callback=vi.fn(); const stop=AuthService.subscribe(callback);
  await mocks.authCallback({uid:'a'});
  stop();
  expect(mocks.stopAuth).toHaveBeenCalledOnce();
  expect(mocks.profiles[0].stop).toHaveBeenCalledOnce();
  mocks.profiles[0].next(snapshot('a'));
  expect(callback).not.toHaveBeenCalled();
});
test('R37: signed-out state clears cached profile and stops profile listener',async()=>{
  const stop=AuthService.subscribe(vi.fn());
  await mocks.authCallback({uid:'a'}); mocks.profiles[0].next(snapshot('a'));
  await mocks.authCallback(null);
  expect(mocks.profiles[0].stop).toHaveBeenCalledOnce();
  expect(AuthService.getUserProfile()).toBeNull();
  stop();
});
