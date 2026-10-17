const admin = require('firebase-admin');
const dotenv = require('dotenv');
dotenv.config();

const initializeFirebase = () => {
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    if (!projectId || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId)) {
        throw new Error('FIREBASE_PROJECT_ID must explicitly identify the target project');
    }
    const emulator = process.env.FIRESTORE_EMULATOR_HOST;
    const authEmulator = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    if (process.env.NODE_ENV === 'production' && (emulator || authEmulator)) {
        throw new Error('Production cannot use Firebase emulators');
    }
    for (const host of [emulator, authEmulator].filter(Boolean)) {
        const match = /^(127\.0\.0\.1|localhost):([0-9]+)$/.exec(host);
        if (!projectId.startsWith('demo-') || !match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
            throw new Error('Local emulator requires a demo project and loopback TCP port');
        }
    }
    if (authEmulator && !emulator) {
        throw new Error('Local Auth emulator requires the Firestore emulator too');
    }
    if (admin.apps.length > 0) {
        const app = admin.app();
        if (app.options.projectId !== projectId) throw new Error('Firebase initialized for a different project');
        return app;
    }
    const options = {projectId};
    if (!emulator) {
        if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
            let serviceAccount;
            try {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
            } catch {
                throw new Error('Invalid Firebase credential JSON');
            }
            if (serviceAccount.project_id !== projectId) {
                throw new Error('Firebase credential project does not match FIREBASE_PROJECT_ID');
            }
            options.credential = admin.credential.cert(serviceAccount);
        } else {
            options.credential = admin.credential.applicationDefault();
        }
    }
    return admin.initializeApp(options);
};
module.exports = {initializeFirebase, admin};
