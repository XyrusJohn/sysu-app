const admin = require("firebase-admin");
const dotenv = require("dotenv");

dotenv.config();

const initializeFirebase = () => {
    if (admin.apps.length > 0) return admin.app();

    try {
        let credential;

        if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
            console.log("🛡️ Firebase: Loading credentials from ENV JSON");

            // SYSU ULTIMATE FIX: Auto-clean mangled JSON from .env
            let jsonStr = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();

            // 1. Repair escaped quotes from copy-paste
            jsonStr = jsonStr.replace(/\\"/g, '"');

            // 2. Repair potential merged strings from .env parsing
            if (jsonStr.includes('}PORT=')) jsonStr = jsonStr.split('PORT=')[0];

            // 3. Remove leading/trailing quotes if they exist
            if (jsonStr.startsWith('"') || jsonStr.startsWith("'")) jsonStr = jsonStr.substring(1);
            if (jsonStr.endsWith('"') || jsonStr.endsWith("'")) jsonStr = jsonStr.substring(0, jsonStr.length - 1);

            try {
                const serviceAccount = JSON.parse(jsonStr);
                credential = admin.credential.cert(serviceAccount);
                console.log("🛡️ Firebase: SYSU Credentials Repaired & Loaded");
            } catch (e) {
                console.error("JSON Error details:", jsonStr.substring(0, 50) + "...");
                throw new Error("Mangled JSON in .env. Please check the format.");
            }
        } else {
            console.log("🌐 Firebase: Using Default Credentials");
            credential = admin.credential.applicationDefault();
        }

        admin.initializeApp({
            credential: credential,
            projectId: process.env.FIREBASE_PROJECT_ID || "sysu-web-5a25d",
        });

        console.log("🔥 Firebase Admin Initialized Successfully");
        return admin.app();
    } catch (error) {
        console.error("❌ Firebase Admin Init Error:", error.message);
    }
};

module.exports = {initializeFirebase, admin};
