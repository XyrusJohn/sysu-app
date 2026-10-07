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
