import {AuthService} from "../api/authService.js";
import {auth, db} from "../api/firebase.js";
import {doc, setDoc, serverTimestamp} from "firebase/firestore";

// Logout signal from QR page — must be handled BEFORE AuthService.subscribe
// registers onAuthStateChanged, otherwise the listener fires first and
// redirects back to QR before signOut clears the session.
if (new URLSearchParams(window.location.search).get("logout") === "1") {
    auth.signOut().then(() => {
        localStorage.removeItem("userData");
        // Strip the ?logout=1 param so the clean URL is bookmarked
        window.location.replace(window.location.pathname);
    });
    // Stop the rest of the page from loading until signOut completes
    throw new Error("LOGOUT_REDIRECT");
}

document.addEventListener("DOMContentLoaded", () => {
    // ── Elements ───────────────────────────────────────────────────────────
    const emailInput = document.getElementById("email");
    const passwordInput = document.getElementById("password");
    const loginBtn = document.getElementById("loginBtn");
    const loginBtnText = document.getElementById("loginBtnText");
    const googleBtn = document.getElementById("googleBtn");
    const googleBtnText = document.getElementById("googleBtnText");
    const alertMsg = document.getElementById("alertMsg");
    const eyeBtn = document.getElementById("eyeBtn");
    const rememberMe = document.getElementById("rememberMe");

    // ── Real-time Role & Status Monitor ───────────────────────────────
    AuthService.subscribe(async (user, error) => {
        if (error) {
            if (error.message === 'NOT_REGISTERED') {
                document.getElementById('regOverlay')?.classList.add('show');
            }
            return;
        }

        if (user) {
            // If role not yet loaded from Firestore, wait a moment for data
            if (!user.role || user.role === 'pending') {
                await new Promise(r => setTimeout(r, 1500));
            }

            // IMPORTANT: Do not redirect if the user is on the QR generator page
            if (window.location.pathname.includes('qr-generator')) {
                return;
            }

            if (user.role && user.role !== 'pending') {
                window.location.href = "dashboard.html";
            } else {
                // Still pending
                const pendingOverlay = document.getElementById('pendingOverlay');
                if (pendingOverlay) {
                    const pendingName = document.getElementById('pendingName');
                    if (pendingName) pendingName.textContent = user.name || 'User';
                    pendingOverlay.classList.add('show');
                }
            }
        }
    });

    // ── Slide System ──────────────────────────────────────────────────
    let curSlide = 0;
    const TOTAL_SLIDES = 3;
    let slideTimer = setInterval(() => nextSlide(), 4500);

    function goSlide(n) {
        clearInterval(slideTimer);
        const prevSlideEl = document.getElementById("slide" + curSlide);
        const prevDot = document.getElementById("sdot" + curSlide);
        if (prevSlideEl) prevSlideEl.classList.remove("active");
        if (prevDot) prevDot.classList.remove("on");

        curSlide = n;

        const nextSlideEl = document.getElementById("slide" + curSlide);
        const nextDot = document.getElementById("sdot" + curSlide);
        if (nextSlideEl) nextSlideEl.classList.add("active");
        if (nextDot) nextDot.classList.add("on");

        slideTimer = setInterval(() => nextSlide(), 4500);
    }

    function nextSlide() {
        goSlide((curSlide + 1) % TOTAL_SLIDES);
    }

    function prevSlide() {
        goSlide((curSlide + TOTAL_SLIDES - 1) % TOTAL_SLIDES);
    }

    document.getElementById("prevSlideBtn")?.addEventListener("click", prevSlide);
    document.getElementById("nextSlideBtn")?.addEventListener("click", nextSlide);

    for (let i = 0; i < TOTAL_SLIDES; i++) {
        document
            .getElementById("sdot" + i)
            ?.addEventListener("click", () => goSlide(i));
    }

    // ── Animated Stats Counters ───────────────────────────────────────
    function animateCount(el, target, suffix, duration) {
        if (!el) return;
        let start = 0;
        const step = target / (duration / 16);
        const timer = setInterval(() => {
            start = Math.min(start + step, target);
            el.innerHTML = Math.round(start) + (suffix || "");
            if (start >= target) clearInterval(timer);
        }, 16);
    }

    setTimeout(() => {
        animateCount(document.getElementById("statTrucks"), 47, "", 1200);
        animateCount(document.getElementById("statDeliveries"), 138, "", 1600);
        animateCount(
            document.getElementById("statUptime"),
            99,
            '<span class="accent">%</span>',
            800,
        );
    }, 600);

    // ── Toggle Password ───────────────────────────────────────────────
    if (eyeBtn) {
        eyeBtn.addEventListener("click", () => {
            const isPass = passwordInput.type === "password";
            passwordInput.type = isPass ? "text" : "password";
            document.getElementById("eyeOpen").style.display = isPass ? "none" : "";
            document.getElementById("eyeClosed").style.display = isPass ? "" : "none";
        });
    }

    // ── Alert Helpers ─────────────────────────────────────────────────
    function showAlert(msg, type = "error") {
        alertMsg.textContent = msg;
        alertMsg.className = "alert-msg show " + type;
        if (type !== "success") {
            emailInput.classList.remove("error-field");
            passwordInput.classList.remove("error-field");
        }
    }

    function showFieldError(fieldEl, msg) {
        showAlert(msg, "error");
        fieldEl.classList.add("error-field");
        fieldEl.focus();
    }

    function clearAlert() {
        alertMsg.classList.remove("show");
        emailInput.classList.remove("error-field");
        passwordInput.classList.remove("error-field");
    }

    [emailInput, passwordInput].forEach((el) => {
        if (el) el.addEventListener("input", clearAlert);
    });

    // ── Auth Handling ─────────────────────────────────────────────────
    if (loginBtn) {
        loginBtn.addEventListener("click", async () => {
            clearAlert();
            const email = emailInput.value.trim();
            const pass = passwordInput.value;

            if (!email) {
                showFieldError(emailInput, "Please enter your email address.");
                return;
            }
            // Email validation
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
if (!EMAIL_RE.test(email)) {
    showFieldError(emailInput, "Please enter a valid email address.");
    return;
}
if (pass.length < 8 || pass.length > 128) {
    showFieldError(
        passwordInput,
        "Password must be at least 8 and no more than 128 characters.",
    );
    return;
}

            // Loading state
            loginBtn.disabled = true;
            loginBtnText.innerHTML =
                '<span class="spinner"></span><span style="margin-left:6px;">Signing in...</span>';

            try {
                await AuthService.login(email, pass);
                const result = await AuthService.check();

                if (result.data) {
                    if (result.data.role === 'pending' || result.data.status === 'inactive') {
                        const pendingName = document.getElementById('pendingName');
                        if (pendingName) pendingName.textContent = result.data.name || result.data.email;
                        document.getElementById('pendingOverlay').classList.add('show');
                        return;
                    }

                    localStorage.setItem("userData", JSON.stringify(result.data));

                    // Show success overlay briefly (redirect is immediate so user barely sees it)
                    const overlay = document.getElementById("successOverlay");
                    const nameEl = document.getElementById("successName");
                    const name = result.data.displayName || result.data.name || result.data.email || "Admin";
                    if (nameEl) nameEl.textContent = "Welcome, " + name + "!";

                    // Immediate redirect based on role — no setTimeout race condition
                    window.location.href = "dashboard.html";
                }
            } catch (error) {
                let msg = error.message || "Login failed. Please try again.";
                if (error.code === "auth/user-not-found")
                    msg = "No account found with this email.";
                if (error.code === "auth/wrong-password")
                    msg = "Incorrect password. Please try again.";
                if (error.code === "auth/too-many-requests")
                    msg = "Too many attempts. Please try again later.";
                if (error.code === "auth/invalid-credential")
                    msg = "Invalid email or password.";

                showAlert(msg, "error");

                // Reset button
                loginBtn.disabled = false;
                loginBtnText.textContent = "Sign In";
            }
        });
    }

    // Handle Enter Key
    if (passwordInput) {
        passwordInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") loginBtn.click();
        });
    }
    if (emailInput) {
        emailInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") passwordInput.focus();
        });
    }

    // Google Login
    if (googleBtn) {
        googleBtn.addEventListener("click", async () => {
            clearAlert();
            googleBtn.disabled = true;
            googleBtnText.textContent = "Connecting...";

            try {
                await AuthService.loginWithGoogle();
                const result = await AuthService.check();

                if (result.data) {
                    if (result.data.role === 'pending' || result.data.status === 'inactive') {
                        const pendingName = document.getElementById('pendingName');
                        if (pendingName) pendingName.textContent = result.data.name || result.data.email;
                        document.getElementById('pendingOverlay').classList.add('show');
                        return;
                    }

                    localStorage.setItem("userData", JSON.stringify(result.data));

                    const overlay = document.getElementById("successOverlay");
                    const nameEl = document.getElementById("successName");
                    const name = result.data.displayName || result.data.name || result.data.email || "Admin";
                    if (nameEl) nameEl.textContent = "Welcome, " + name + "!";

                    // Immediate redirect based on role — no setTimeout race condition
                    window.location.href = "dashboard.html";
                }
            } catch (error) {
                googleBtn.disabled = false;
                googleBtnText.textContent = "Sign in with Google";

                if (error.message === "NOT_REGISTERED") {
                    document.getElementById('regOverlay').classList.add('show');
                    return;
                }

                if (error.code === "auth/account-exists-with-different-credential") {
                    showAlert(
                        "This email is already registered using a different method.",
                        "error",
                    );
                } else if (
                    error.code !== "auth/popup-closed-by-user" &&
                    error.code !== "auth/cancelled-popup-request"
                ) {
                    showAlert(
                        "Google sign-in failed: " + (error.message || "Please try again."),
                        "error",
                    );
                }
            }
        });
    }

    // Forgot password & Contact Admin
    document.getElementById("contactAdminBtn")?.addEventListener("click", (e) => {
        e.preventDefault();
        showAlert(
            "Please contact your SYSU IT Administrator to create an account.",
            "success",
        );
    });

    document.getElementById("forgotBtn")?.addEventListener("click", (e) => {
        e.preventDefault();
        const email = emailInput.value.trim();
        if (!email || !email.includes("@")) {
            showFieldError(
                emailInput,
                "Enter your email above first, then click Forgot password.",
            );
        } else {
            showAlert(
                "Forgot password functionality requires Firebase configuration update for password reset.",
                "error",
            );
        }
    });

    // ── Registration Modal Handling ─────────────────────────────────────
    const regOverlay = document.getElementById("regOverlay");
    const pendingOverlay = document.getElementById("pendingOverlay");
    const cancelRegBtn = document.getElementById("cancelRegBtn");
    const submitRegBtn = document.getElementById("submitRegBtn");
    const pendingBackBtn = document.getElementById("pendingBackBtn");

    if (cancelRegBtn) {
        cancelRegBtn.addEventListener("click", async () => {
            regOverlay.classList.remove("show");
            // Need to sign out since they cancelled registration
            try {
                await auth.signOut();
            } catch (e) {
            }
        });
    }

    if (submitRegBtn) {
        submitRegBtn.addEventListener("click", async () => {
            const HTML_SANITIZE = (s) => (s || "").replace(/[<>]/g, "").trim();
            const name = HTML_SANITIZE(document.getElementById('regName').value);
            const phone = HTML_SANITIZE(document.getElementById('regPhone').value);
            const pos = HTML_SANITIZE(document.getElementById('regPosition').value);

            if (!name || !phone || !pos) {
                alert('Please fill in all fields.');
                return;
            }

            submitRegBtn.disabled = true;
            submitRegBtn.innerHTML = "Submitting...";

            try {
                const user = auth.currentUser;
                if (!user) throw new Error("No authenticated user found.");

                await setDoc(doc(db, 'users', user.uid), {
                    uid: user.uid,
                    name: name,
                    email: user.email,
                    phone: phone,
                    position: pos,
                    role: 'pending',
                    status: 'inactive',
                    createdAt: serverTimestamp()
                });

                regOverlay.classList.remove("show");
                const pendingName = document.getElementById('pendingName');
                if (pendingName) pendingName.textContent = name;
                pendingOverlay.classList.add("show");
            } catch (err) {
                console.error("Registration error:", err);
                alert("Failed to submit registration. Please try again.");
            } finally {
                submitRegBtn.disabled = false;
                submitRegBtn.innerHTML = "Submit Request";
            }
        });
    }

    if (pendingBackBtn) {
        pendingBackBtn.addEventListener("click", async () => {
            pendingOverlay.classList.remove("show");
            try {
                await auth.signOut();
            } catch (e) {
            }
        });
    }

});
