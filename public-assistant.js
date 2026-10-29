"use strict";

/* Floating robot assistant for anonymous homepage visitors. Behaviour is owner-managed on the server. */
(function () {
    const WELCOME = "Hi! I'm the R.M. Digital Centre assistant. Ask me about our services or how to apply for a Retailer or Distributor ID.";
    const CHIPS = ["Our services", "Apply for Retailer ID", "Apply for Distributor ID", "Documents needed"];
    const ROBOT_SVG = '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">' +
        '<line class="rm-bot-antenna" x1="32" y1="7" x2="32" y2="14"/><circle class="rm-bot-bulb" cx="32" cy="5" r="3"/>' +
        '<rect class="rm-bot-head" x="10" y="14" width="44" height="34" rx="12"/>' +
        '<rect class="rm-bot-ear" x="5" y="26" width="5" height="10" rx="2"/><rect class="rm-bot-ear" x="54" y="26" width="5" height="10" rx="2"/>' +
        '<rect class="rm-bot-face" x="16" y="21" width="32" height="20" rx="8"/>' +
        '<ellipse class="rm-bot-eye" cx="25" cy="31" rx="3.5" ry="4.5"/><ellipse class="rm-bot-eye" cx="39" cy="31" rx="3.5" ry="4.5"/>' +
        '<path class="rm-bot-mouth" d="M27 37 Q32 41 37 37"/>' +
        '<rect class="rm-bot-body" x="20" y="50" width="24" height="10" rx="5"/></svg>';

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text) { node.textContent = text; }
        return node;
    }

    async function loadSettings() {
        try {
            const response = await fetch("/api/public/assistant/config", { credentials: "same-origin" });
            return response.ok ? await response.json() : null;
        } catch (error) {
            return null;
        }
    }

    async function ask(message) {
        const response = await fetch("/api/public/assistant/chat", {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: message }),
        });
        const data = await response.json().catch(function () { return {}; });
        return typeof data.reply === "string" ? data.reply : "Sorry, I could not respond right now.";
    }

    async function init() {
        const settings = await loadSettings();
        if (!settings || !settings.enabled) { return; }

        const root = el("div", "rm-bot");
        const bubble = el("div", "rm-bot-bubble", settings.greeting || "Hi!");
        bubble.setAttribute("role", "status");
        const fab = el("button", "rm-bot-fab");
        fab.type = "button";
        fab.setAttribute("aria-label", "Chat with the R.M. Digital Centre assistant");
        fab.setAttribute("aria-expanded", "false");
        fab.innerHTML = ROBOT_SVG;
        root.append(bubble, fab);

        const panel = el("div", "rm-chat-panel");
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "R.M. Digital Centre assistant");
        const head = el("div", "rm-chat-head");
        const title = el("div");
        title.append(el("strong", "", "R.M. Digital Centre"), el("small", "", "Visitor assistant"));
        const close = el("button", "rm-chat-close", "\u00D7");
        close.type = "button";
        close.setAttribute("aria-label", "Close assistant");
        head.append(title, close);
        const log = el("div", "rm-chat-log");
        log.setAttribute("aria-live", "polite");
        const chips = el("div", "rm-chat-chips");
        const form = el("form", "rm-chat-form");
        const input = el("input");
        input.type = "text";
        input.maxLength = 500;
        input.placeholder = "Ask about our services...";
        input.autocomplete = "off";
        input.setAttribute("aria-label", "Your message");
        const send = el("button", "", "Send");
        send.type = "submit";
        form.append(input, send);
        panel.append(head, log, chips, form);
        document.body.append(root, panel);

        function addMessage(text, who) {
            log.append(el("div", "rm-chat-msg " + who, text));
            log.scrollTop = log.scrollHeight;
        }

        async function submit(text) {
            addMessage(text, "user");
            send.disabled = true;
            try {
                addMessage(await ask(text), "bot");
            } catch (error) {
                addMessage("The assistant is unavailable right now. Please try again shortly.", "bot");
            } finally {
                send.disabled = false;
                input.focus();
            }
        }

        function setOpen(open) {
            panel.hidden = !open;
            bubble.hidden = true;
            fab.setAttribute("aria-expanded", String(open));
            if (open) { input.focus(); } else { fab.focus(); }
        }

        addMessage(WELCOME, "bot");
        CHIPS.forEach(function (label) {
            const chip = el("button", "", label);
            chip.type = "button";
            chip.addEventListener("click", function () { submit(label); });
            chips.append(chip);
        });
        fab.addEventListener("click", function () { setOpen(panel.hidden); });
        close.addEventListener("click", function () { setOpen(false); });
        panel.addEventListener("keydown", function (event) { if (event.key === "Escape") { setOpen(false); } });
        form.addEventListener("submit", function (event) {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) { return; }
            input.value = "";
            submit(text);
        });
        window.setTimeout(function () { bubble.hidden = true; }, 8000);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
