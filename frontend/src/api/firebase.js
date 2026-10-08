import {initializeApp} from "firebase/app";
import {getAuth, GoogleAuthProvider, connectAuthEmulator} from "firebase/auth";
import {getFirestore, connectFirestoreEmulator} from "firebase/firestore";
import {resolveReleaseConfig, resolveLocalEmulators} from './releaseConfig.js';

resolveReleaseConfig(import.meta.env);
const emulators = import.meta.env.VITE_RELEASE_TARGET === 'local' ? resolveLocalEmulators(import.meta.env) : null;

// Your web app's Firebase configuration for sysu-app
const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
if (emulators) {
    connectAuthEmulator(auth, emulators.authUrl, {disableWarnings: true});
    connectFirestoreEmulator(db, emulators.firestoreHost, emulators.firestorePort);
}
export const googleProvider = new GoogleAuthProvider();
