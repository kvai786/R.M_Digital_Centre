"use strict";

/* Signed-in assistant widget. It appears only for a verified session; answers depend on the user's role. */
(function () {
    const ROLE_LABELS = {
        retailer: "Retailer", distributor: "Distributor", subadmin: "Sub-Admin",
        masteradmin: "Master Admin", master: "Supreme Owner",
    };

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text) { node.textContent = text; }
        return node;
    }

    function csrfToken() {
        const cookie = document.cookie.split("; ").find(function (item) { return item.startsWith("rm_csrf="); });
        return cookie ? decodeURIComponent(cookie.slice("rm_csrf=".length)) : "";
    }

    async function currentUser() {
        try {
            const response = await fetch("/api/auth/me", { credentials: "same-origin" });
            return response.ok ? (await response.json()).user : null;
        } catch (error) {
            return null;
        }
    }

    async function ask(message) {
        const response = await fetch("/assistant/chat", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
            body: JSON.stringify({ message: message }),
        });
        if (response.status === 401) {
            window.location.assign("/login.html");
            return "";
        }
        const data = await response.json().catch(function () { return {}; });
        return typeof data.reply === "string" ? data.reply : "Sorry, I could not respond right now.";
    }

    async function init() {
        const user = await currentUser();
        if (!user) { return; }

        const fab = el("button", "rm-bot rm-portal-fab", "\uD83D\uDCAC");
        fab.type = "button";
        fab.setAttribute("aria-label", "Open assistant");
        fab.setAttribute("aria-expanded", "false");
        const panel = el("div", "rm-chat-panel");
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "R.M Digital Centre assistant");
        const head = el("div", "rm-chat-head");
        const title = el("div");
        title.append(el("strong", "", "R.M Assistant"), el("small", "", ROLE_LABELS[user.role] || "Signed-in user"));
        const close = el("button", "rm-chat-close", "\u00D7");
        close.type = "button";
        close.setAttribute("aria-label", "Close assistant");
        head.append(title, close);
        const log = el("div", "rm-chat-log");
        log.setAttribute("aria-live", "polite");
        const form = el("form", "rm-chat-form");
        const input = el("input");
        input.type = "text";
        input.maxLength = 500;
        input.placeholder = "Ask about your workspace...";
        input.autocomplete = "off";
        input.setAttribute("aria-label", "Your message");
        const send = el("button", "", "Send");
        send.type = "submit";
        form.append(input, send);
        panel.append(head, log, form);
        document.body.append(fab, panel);

        function addMessage(text, who) {
            const message = el("div", "rm-chat-msg " + who);
            message.append(el("span", "", text));
            if (who === "bot" && window.RMVoice && window.RMVoice.supported()) {
                message.append(window.RMVoice.createButton(function () { return text; }));
            }
            log.append(message);
            log.scrollTop = log.scrollHeight;
        }

        addMessage("Namaste! How can I help you today?", "bot");
        fab.addEventListener("click", function () { setOpen(panel.hidden); });
        close.addEventListener("click", function () { setOpen(false); });
        panel.addEventListener("keydown", function (event) { if (event.key === "Escape") { setOpen(false); } });
        form.addEventListener("submit", async function (event) {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) { return; }
            if (window.RMVoice) { window.RMVoice.noteUserQuery(text); }
            addMessage(text, "user");
            input.value = "";
            send.disabled = true;
            try {
                const reply = await ask(text);
                if (reply) { addMessage(reply, "bot"); }
            } catch (error) {
                addMessage("The assistant is unavailable. Please try again.", "bot");
            } finally {
                send.disabled = false;
                input.focus();
            }
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
