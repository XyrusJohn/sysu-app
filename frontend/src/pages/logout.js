import {signOut} from 'firebase/auth';
import {auth} from '../api/firebase.js';

try {
    await signOut(auth);
    sessionStorage.clear();
    localStorage.removeItem('userData');
    window.location.replace('./index.html');
} catch {
    document.getElementById('logout-status').textContent = 'Sign out failed. Please check your connection and retry.';
}
