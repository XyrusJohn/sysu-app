import {
    signInWithEmailAndPassword,
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    setPersistence,
    browserLocalPersistence,
} from "firebase/auth";
import {doc, onSnapshot} from "firebase/firestore";
import {auth, db, googleProvider} from "./firebase";

let currentUserProfile = null;

export const AuthService = {
    async login(email, password) {
        await setPersistence(auth, browserLocalPersistence);
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        return userCredential.user;
    },

    async loginWithGoogle() {
        const result = await signInWithPopup(auth, googleProvider);
        return result.user;
    },

    async check() {
        return new Promise((resolve, reject) => {
            const unsubscribe = this.subscribe((user, error) => {
                unsubscribe();
                if (error) reject(error);
                else if (user) resolve({data: user});
                else reject(new Error("No user"));
            });
        });
    },

    subscribe(callback) {
        let stopProfile = null;
        let generation = 0;
        let closed = false;
        const stopAuth = onAuthStateChanged(auth, async (user) => {
            if (closed) return;
            const activeGeneration = ++generation;
            stopProfile?.();
            stopProfile = null;
            currentUserProfile = null;
            if (!user) {
                callback(null, new Error("Unauthorized"));
                return;
            }

            const userDocRef = doc(db, "users", user.uid);

            stopProfile = onSnapshot(
                userDocRef,
                async (snapshot) => {
                    if (closed || generation !== activeGeneration) return;
                    if (snapshot.exists()) {
                        const profile = {
                            id: snapshot.id,
                            ...snapshot.data(),
                            email: user.email,
                            photoURL: user.photoURL,
                        };

                        if (currentUserProfile && currentUserProfile.role !== profile.role) {
                            profile.roleChanged = true;
                        }
                        if (profile.status === 'disabled' || (profile.status === 'inactive' && profile.role !== 'pending')) {
                            currentUserProfile = null;
                            try { await signOut(auth); } catch {
                                // A persistence failure must never publish a disabled profile.
                            }
                            localStorage.removeItem('userData');
                            if (!closed && generation === activeGeneration) callback(null, new Error('ACCOUNT_DISABLED'));
                            return;
                        }
                        currentUserProfile = profile;
                        callback(profile);
                    } else {
                        // User document was deleted from Firestore (or never created)
                        if (currentUserProfile) {
                            // User was previously logged in and document was deleted in realtime!
                            console.warn("User document deleted while logged in. Logging out...");
                            currentUserProfile = null;
                            await signOut(auth);
                            localStorage.removeItem("userData");
                            sessionStorage.setItem("auth_error_message", "Your account has been deleted by an administrator.");
                            window.location.href = "index.html?reason=account_deleted";
                            return;
                        }
                        callback(null, new Error("NOT_REGISTERED"));
                    }
                },
                (err) => {
                    if (closed || generation !== activeGeneration) return;
                    console.error("Auth listener error:", err);
                    callback(null, new Error("NOT_REGISTERED"));
                },
            );
        });
        return () => {
            if (closed) return;
            closed = true;
            generation++;
            stopProfile?.();
            stopProfile = null;
            stopAuth();
        };
    },

    async logout() {
        await signOut(auth);
        localStorage.removeItem("userData");
        window.location.href = "/";
    },

    getUserProfile() {
        return currentUserProfile;
    },

    updateProfile(updates) {
        currentUserProfile = {...currentUserProfile, ...updates};
    },

    async getToken() {
        const user = auth.currentUser;
        if (!user) throw new Error("No authenticated user found");
        return await user.getIdToken();
    },
};
