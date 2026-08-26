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
        try {
            await setPersistence(auth, browserLocalPersistence);
            const userCredential = await signInWithEmailAndPassword(auth, email, password);
            return userCredential.user;
        } catch (error) {
            throw error;
        }
    },

    async loginWithGoogle() {
        try {
            const result = await signInWithPopup(auth, googleProvider);
            return result.user;
        } catch (error) {
            throw error;
        }
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
        return onAuthStateChanged(auth, async (user) => {
            if (!user) {
                callback(null, new Error("Unauthorized"));
                return;
            }

            const userDocRef = doc(db, "users", user.uid);

            onSnapshot(
                userDocRef,
                async (snapshot) => {
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
                    console.error("Auth listener error:", err);
                    callback(null, new Error("NOT_REGISTERED"));
                },
            );
        });
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
