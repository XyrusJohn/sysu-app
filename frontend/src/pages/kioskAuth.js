import {onAuthStateChanged} from 'firebase/auth';
import {auth} from '../api/firebase.js';

onAuthStateChanged(auth, user => {
    window.kioskQueueUser = user;
    window.dispatchEvent(new Event('kiosk-auth-changed'));
});
