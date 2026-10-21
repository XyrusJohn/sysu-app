import "./style/main.css";

try {
    if (localStorage.getItem("sysu-theme") === "light") {
        document.documentElement.setAttribute("data-theme", "light");
    } else {
        document.documentElement.removeAttribute("data-theme");
    }
} catch {
    // The app keeps its dark default when browser storage is unavailable.
}

// ── DevTools deterrent banner ───────────────────────────────────────
console.log(
    "%c⚠ SECURE SYSTEM",
    "color:#f85149;font-size:28px;font-weight:bold;font-family:monospace;"
);
console.log(
    "This is a browser feature intended for developers."
);
console.log(
    "If someone told you to copy-paste something here to enable a feature"
);
console.log(
    "or 'hack' this system, it is a scam and will give them access to your account."
);
console.log(
    "%cUnauthorized access or reverse-engineering of this system is prohibited",
    "color:#f85149;font-size:11px;font-family:monospace;"
);
console.log(
    "%cand may result in civil and\\/or criminal penalties.",
    "color:#f85149;font-size:11px;font-family:monospace;"
);
