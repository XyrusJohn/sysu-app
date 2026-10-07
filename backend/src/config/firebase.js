const admin = require('firebase-admin');
const dotenv = require('dotenv');
dotenv.config();

const initializeFirebase = () => {
    const projectId = process.env.FIREBASE_PROJECT_ID?.trim();
    if (!projectId || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId)) {
        throw new Error('FIREBASE_PROJECT_ID must explicitly identify the target project');
    }
    const emulator = process.env.FIRESTORE_EMULATOR_HOST;
    if (process.env.NODE_ENV === 'production' && emulator) {
        throw new Error('Production cannot use a Firestore emulator');
    }
    if (emulator && (!projectId.startsWith('demo-') || !/^(127\.0\.0\.1|localhost):\d+$/.test(emulator))) {
        throw new Error('Local emulator requires a demo project and loopback host');
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
