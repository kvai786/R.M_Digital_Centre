(function () {
    "use strict";
    const form = document.getElementById("track-form");
    const note = document.getElementById("track-status");
    const result = document.getElementById("track-result");
    const text = (id, value) => { document.getElementById(id).textContent = value; };

    function say(message) {
        note.textContent = message;
        note.hidden = !message;
    }

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        result.hidden = true;
        const reference = form.reference.value.trim();
        const mobile = form.mobile.value.replace(/\D/g, "");
        if (reference.length < 4 || mobile.length !== 10) {
            say("Enter the ID and a 10-digit mobile number.");
            return;
        }
        say("Checking...");
        try {
            const response = await fetch("/api/public/track", {
                method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reference, mobile }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                say(typeof data.detail === "string" ? data.detail : "Could not check the status. Please try again.");
                return;
            }
            text("track-kind", data.kind);
            text("track-stage", data.stage);
            text("track-label", `${data.reference} - ${data.label}`);
            const reply = document.getElementById("track-reply");
            reply.textContent = data.reply ? "Support reply: " + data.reply : "";
            reply.hidden = !data.reply;
            const when = data.updatedAt ? new Date(data.updatedAt) : null;
            text("track-updated", when && !isNaN(when) ? "Last updated: " + when.toLocaleString() : "");
            result.hidden = false;
            say("");
        } catch {
            say("Network error. Please try again.");
        }
    });
})();
