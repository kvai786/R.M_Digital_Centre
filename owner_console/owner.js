(() => {
    "use strict";

    const GREETING = "Welcome back, Boss. R.M. Digital Centre master panel is fully operational.";
    const PENDING_WELCOME_KEY = "rm-demo-pending-welcome";
    const ROLES = [
        ["retailer", "Retailer"], ["distributor", "Distributor"], ["subadmin", "Sub-Admin"],
        ["masteradmin", "Master Admin"], ["master", "Supreme Owner"],
    ];
    const $ = (id) => document.getElementById(id);
    const state = { loaded: new Set(), logCursor: 0, ai: null };

    function csrfToken() {
        const match = document.cookie.match(/(?:^|; )rm_csrf=([^;]*)/);
        return match ? decodeURIComponent(match[1]) : "";
    }

    async function api(path, options = {}) {
        const method = options.method || "GET";
        const headers = { Accept: "application/json" };
        if (options.body !== undefined) headers["Content-Type"] = "application/json";
        if (method !== "GET") headers["X-CSRF-Token"] = csrfToken();
        const response = await fetch(path, {
            method, headers, credentials: "same-origin", cache: "no-store",
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
        if (response.status === 401) {
            window.location.assign("/login.html");
            throw new Error("Session expired.");
        }
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const detail = Array.isArray(data.detail) ? data.detail.map((d) => d.msg).join("; ") : data.detail;
            throw new Error(detail || "Request failed.");
        }
        return data;
    }

    function el(tag, props = {}, ...children) {
        const node = document.createElement(tag);
        for (const [key, value] of Object.entries(props)) {
            if (key === "class") node.className = value;
            else if (key === "text") node.textContent = value;
            else node.setAttribute(key, value);
        }
        for (const child of children) if (child) node.append(child);
        return node;
    }

    function formatDate(value) {
        if (!value) return "-";
        const text = /(Z|[+-]\d\d:?\d\d)$/.test(value) ? value : value + "Z";
        const date = new Date(text);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }

    let statusTimer = 0;
    function notify(message, isError = false) {
        const box = $("oc-status");
        box.textContent = message;
        box.className = "oc-status" + (isError ? " error" : "");
        box.hidden = false;
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => { box.hidden = true; }, 6000);
    }

    async function guarded(task) {
        try { return await task(); } catch (error) { notify(error.message, true); return null; }
    }

    function fillTable(table, rows) {
        table.replaceChildren(...rows.map(([label, value, cls]) =>
            el("tr", {}, el("th", { text: label }), el("td", { text: String(value), class: cls || "" }))));
    }

    /* Voice greeting */
    function pickVoice() {
        const voices = window.speechSynthesis.getVoices();
        return voices.find((v) => v.lang === "en-IN") || voices.find((v) => v.lang.startsWith("en")) || null;
    }

    function speakGreeting(onBlocked) {
        if (!("speechSynthesis" in window)) { onBlocked && onBlocked(); return; }
        const synth = window.speechSynthesis;
        synth.cancel();
        const utterance = new SpeechSynthesisUtterance(GREETING);
        utterance.lang = "en-IN";
        utterance.rate = 0.95;
        const voice = pickVoice();
        if (voice) utterance.voice = voice;
        let started = false;
        utterance.onstart = () => { started = true; $("oc-greeting-banner").hidden = true; };
        utterance.onerror = () => { if (!started && onBlocked) onBlocked(); };
        synth.speak(utterance);
        if (onBlocked) setTimeout(() => { if (!started) onBlocked(); }, 1500);
    }

    function greetAfterLogin(owner) {
        let pending = null;
        try { pending = JSON.parse(sessionStorage.getItem(PENDING_WELCOME_KEY) || "null"); } catch { pending = null; }
        sessionStorage.removeItem(PENDING_WELCOME_KEY);
        if (!pending || pending.role !== "master" || pending.name !== owner.name) return;
        let armed = false;
        speakGreeting(() => {
            $("oc-greeting-banner").hidden = false;
            if (armed) return;
            armed = true;
            const once = () => { speakGreeting(); };
            document.addEventListener("pointerdown", once, { once: true });
            document.addEventListener("keydown", once, { once: true });
        });
    }

    /* Tabs */
    function selectTab(name) {
        document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
        document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
        if (!state.loaded.has(name)) { state.loaded.add(name); loaders[name](); } else if (name !== "ai") loaders[name]();
    }

    function selectSubtab(name) {
        document.querySelectorAll("[data-subtab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.subtab === name)));
        document.querySelectorAll("[data-subpanel]").forEach((p) => { p.hidden = p.dataset.subpanel !== name; });
        if (name === "conversations") loadConversations();
    }

    /* Overview */
    async function loadOverview() {
        const data = await guarded(() => api("/api/supreme/overview"));
        if (!data) return;
        const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);
        const stats = [
            ["Total users", sum(data.users)],
            ["Retailers", data.users.retailer || 0],
            ["Distributors", data.users.distributor || 0],
            ["Master Admins", data.users.masteradmin || 0],
            ["Sub-Admins", data.users.subadmin || 0],
            ["Applications", sum(data.applications)],
            ["Pending applications", data.applications.pending || 0],
            ["Active sessions", data.activeSessions],
            ["Audit entries", data.auditEntries],
            ["Visitor AI", data.ai.publicEnabled ? "On" : "Off"],
            ["Portal AI", data.ai.portalEnabled ? "On" : "Off"],
            ["AI config version", data.ai.configVersion],
        ];
        const clickable = {
            "Total users": "users", "Retailers": "retailer", "Distributors": "distributor",
            "Master Admins": "masteradmin", "Sub-Admins": "subadmin",
            "Applications": "applications", "Pending applications": "pending",
        };
        $("ov-cards").replaceChildren(...stats.map(([label, value]) => {
            const category = clickable[label];
            const card = el(category ? "button" : "div", { class: "oc-stat" + (category ? " clickable" : "") },
                el("span", { text: label }), el("strong", { text: String(value) }));
            if (category) {
                card.type = "button";
                card.addEventListener("click", () => openList(category, label));
            }
            return card;
        }));
        loadAlerts();
    }

    async function loadAlerts() {
        const data = await guarded(() => api("/api/supreme/alerts"));
        if (!data) return;
        const unread = data.alerts.filter((a) => !a.read).length;
        $("alerts-count").textContent = unread ? `(${unread} new)` : "";
        const rows = data.alerts.slice(0, 20).map((a) => el("div", { class: "oc-row" },
            el("div", { class: "oc-row-head" },
                el("span", { class: "oc-badge", text: a.kind + (a.read ? "" : " | new") }),
                el("span", { class: "oc-hint", text: formatDate(a.createdAt) })),
            el("div", { class: "oc-q", text: a.message })));
        $("alerts-list").replaceChildren(...(rows.length ? rows : [el("p", { class: "oc-hint", text: "No alerts." })]));
    }

    /* Modal, list view, application detail and approval */
    function openModal(title) {
        closeModal();
        const body = el("div", { class: "oc-modal-body" });
        const closeBtn = el("button", { type: "button", class: "oc-btn small ghost", text: "Close" });
        const dialog = el("div", { class: "oc-modal", role: "dialog", "aria-modal": "true", "aria-label": title },
            el("div", { class: "oc-modal-head" }, el("h2", { text: title }), closeBtn), body);
        const overlay = el("div", { class: "oc-overlay", id: "oc-overlay" }, dialog);
        closeBtn.addEventListener("click", closeModal);
        overlay.addEventListener("click", (event) => { if (event.target === overlay) closeModal(); });
        document.body.append(overlay);
        closeBtn.focus();
        return body;
    }

    function closeModal() {
        const overlay = $("oc-overlay");
        if (overlay) overlay.remove();
    }

    document.addEventListener("keydown", (event) => { if (event.key === "Escape") closeModal(); });

    async function openList(category, title) {
        const body = openModal(title);
        body.append(el("p", { class: "oc-hint", text: "Loading..." }));
        const data = await guarded(() => api("/api/supreme/list/" + encodeURIComponent(category)));
        if (!data) { closeModal(); return; }
        if (!data.rows.length) { body.replaceChildren(el("p", { class: "oc-hint", text: "No records found." })); return; }
        const table = el("table", { class: "oc-table oc-list-table" },
            el("thead", {}, el("tr", {}, ...["Name", "Mobile", "Service", "Submitted", "Status"].map((h) => el("th", { text: h })))));
        const tbody = el("tbody");
        for (const item of data.rows) {
            const row = el("tr", item.kind === "application" ? { class: "clickable", tabindex: "0" } : {},
                el("td", { text: item.name || "-" }), el("td", { text: item.mobile }),
                el("td", { text: item.service || "-" }), el("td", { text: formatDate(item.submittedAt) }),
                el("td", { text: item.status }));
            if (item.kind === "application") {
                const open = () => openApplication(item.id, () => openList(category, title));
                row.addEventListener("click", open);
                row.addEventListener("keydown", (event) => { if (event.key === "Enter") open(); });
            }
            tbody.append(row);
        }
        table.append(tbody);
        body.replaceChildren(el("div", { class: "oc-scroll" }, table));
    }

    async function openApplication(id, back) {
        const body = openModal("Application " + id);
        const detail = await guarded(() => api("/api/supreme/applications/" + encodeURIComponent(id)));
        if (!detail) { closeModal(); return; }
        const rows = [["Status", detail.status], ["Role", detail.role], ["Mobile", detail.mobile],
            ["Submitted", formatDate(detail.submittedAt)]];
        for (const [key, value] of Object.entries(detail.fields)) {
            if (!["status", "role", "mobile"].includes(key)) rows.push([key, value]);
        }
        const info = el("table", { class: "oc-table" });
        fillTable(info, rows);
        const docs = el("div", { class: "oc-row-actions" });
        if (!detail.documents.length) docs.append(el("span", { class: "oc-hint", text: "No uploaded documents on file." }));
        for (const doc of detail.documents) {
            if (doc.purgedAt) {
                docs.append(el("span", { class: "oc-chip", text: doc.label + " (deleted)" }));
                continue;
            }
            docs.append(el("a", {
                class: "oc-btn small ghost", href: doc.previewUrl, target: "_blank",
                rel: "noopener noreferrer", text: "Preview " + doc.label,
            }));
        }
        const actions = el("div", { class: "oc-row-actions" });
        const backBtn = el("button", { type: "button", class: "oc-btn small ghost", text: "Back to list" });
        backBtn.addEventListener("click", back);
        actions.append(backBtn);
        if (detail.status === "pending") {
            const approve = el("button", { type: "button", class: "oc-btn small", text: "Approve" });
            const reject = el("button", { type: "button", class: "oc-btn small danger", text: "Reject" });
            approve.addEventListener("click", () => showApproveForm(detail, back, body));
            reject.addEventListener("click", () => rejectApplication(detail, back));
            actions.append(approve, reject);
        }
        body.append(info, el("h2", { text: "KYC documents (secure inline preview)" }), docs, el("div", { class: "oc-form-slot", id: "oc-form-slot" }), actions);
    }

    function showApproveForm(detail, back) {
        const idInput = el("input", { name: "officialPortalId", maxlength: "80", autocomplete: "off", required: "" });
        const credInput = el("input", { name: "officialCredentials", maxlength: "200", autocomplete: "off" });
        const form = el("form", { class: "oc-card oc-grid" },
            el("label", { text: "Official Portal ID" }, idInput),
            el("label", { text: "Credentials / password (shown to the partner)" }, credInput),
            el("button", { class: "oc-btn", type: "submit", text: "Confirm approval" }));
        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const done = await guarded(() => api("/api/admin/partners/" + encodeURIComponent(detail.id) + "/action", {
                method: "POST",
                body: { action: "approve", officialPortalId: idInput.value.trim(), officialCredentials: credInput.value.trim() },
            }));
            if (done) { notify("Application approved and Official ID saved."); loadOverview(); back(); }
        });
        $("oc-form-slot").replaceChildren(form);
        idInput.focus();
    }

    async function rejectApplication(detail, back) {
        const reason = window.prompt("Reason for rejection:");
        if (!reason || !reason.trim()) return;
        const done = await guarded(() => api("/api/admin/partners/" + encodeURIComponent(detail.id) + "/action", {
            method: "POST", body: { action: "reject", reason: reason.trim() },
        }));
        if (done) { notify("Application rejected."); loadOverview(); back(); }
    }

    /* Staff */
    const STAFF_ACTIONS = {
        pending_owner_final_approval: ["approve", "reject"],
        ready_for_2fa: ["revoke"],
        whitelisted_pending_setup: ["revoke"],
        revoked: ["reset"],
    };

    async function staffAction(item, action) {
        if (!window.confirm(`${action} ${item.name}?`)) return;
        const done = await guarded(() => api(`/api/owner/staff/${item.id}/action`, { method: "POST", body: { action } }));
        if (done) { notify(`Staff ${action} complete.`); loadStaff(); }
    }

    async function loadStaff() {
        const items = await guarded(() => api("/api/owner/staff"));
        if (!items) return;
        const rows = items.map((item) => {
            const actions = el("div", { class: "oc-row-actions" });
            for (const action of STAFF_ACTIONS[item.status] || []) {
                const button = el("button", { type: "button", class: "oc-btn small " + (action === "approve" ? "" : "ghost"), text: action });
                button.addEventListener("click", () => staffAction(item, action));
                actions.append(button);
            }
            const signOut = el("button", { type: "button", class: "oc-btn small ghost", text: "force sign-out" });
            signOut.addEventListener("click", async () => {
                const done = await guarded(() => api(`/api/supreme/staff/${item.id}/sign-out`, { method: "POST" }));
                if (done) notify(`Sessions ended: ${done.revoked}`);
            });
            actions.append(signOut);
            return el("div", { class: "oc-row" },
                el("div", { class: "oc-row-head" },
                    el("strong", { text: `${item.name} (${item.role})` }),
                    el("span", { class: "oc-badge", text: item.status.replaceAll("_", " ") })),
                el("div", { class: "oc-hint", text: `Mobile ${item.mobile} | ${item.scope} | created ${formatDate(item.createdAt)}` }),
                actions);
        });
        $("staff-list").replaceChildren(...(rows.length ? rows : [el("p", { class: "oc-hint", text: "No staff pre-authorized yet." })]));
    }

    /* Security */
    async function loadSecurity() {
        const d = await guarded(() => api("/api/supreme/security"));
        if (!d) return;
        const yn = (v, good) => [v ? "Yes" : "No", v === good ? "oc-ok" : "oc-warn"];
        const row = (label, value, flag) => [label, ...(flag ? yn(value, true) : [value, ""])];
        const rows = [
            row("Session lifetime (hours)", d.sessionLifetimeHours),
            row("Login lockout policy", d.lockoutPolicy),
            row("CAPTCHA after failures", d.captchaAfterFailures),
            row("Secure cookies", d.secureCookies, true),
            row("Dedicated CSRF secret", d.dedicatedCsrfSecret, true),
            row("KYC retention (days)", d.kycRetentionDays),
            row("2FA required for", d.twoFactorRoles.join(", ")),
            row("Owner setup complete", d.ownerSetupComplete, true),
            ["Bootstrap token still configured", d.bootstrapTokenConfigured ? "Yes - remove it after setup" : "No",
                d.bootstrapTokenConfigured ? "oc-warn" : "oc-ok"],
            row("Active sessions", d.activeSessions),
            ["Active lockouts", d.activeLockouts, d.activeLockouts ? "oc-warn" : ""],
            ["Active lockouts", d.activeLockouts, d.activeLockouts ? "oc-warn" : ""],
            ["Permanent blocks", d.blocked.length, d.blocked.length ? "oc-warn" : "oc-ok"],
            ["Staff without 2FA enrolled", d.staffWithoutTwoFactor, d.staffWithoutTwoFactor ? "oc-warn" : "oc-ok"],
        ];
        fillTable($("sec-table"), rows);
        const list = $("sec-blocked-list");
        list.replaceChildren(...(d.blocked.length ? d.blocked.map((item) => {
            const use = el("button", { type: "button", class: "oc-btn small", text: "Use" });
            use.addEventListener("click", () => { $("unlock-ip").value = item.ip; $("unlock-identifier").focus(); });
            return el("p", { class: "oc-hint" }, document.createTextNode(`IP ${item.ip} - ID ending ${item.identifierHint} `), use);
        }) : [el("p", { class: "oc-hint", text: "No permanent blocks." })]));
    }

    /* Logs */
    async function loadLogs(append = false) {
        if (!append) state.logCursor = 0;
        const params = new URLSearchParams({ limit: "50" });
        if ($("log-action").value) params.set("action", $("log-action").value);
        if (append && state.logCursor) params.set("beforeId", String(state.logCursor));
        const data = await guarded(() => api("/api/supreme/logs?" + params));
        if (!data) return;
        const selected = $("log-action").value;
        $("log-action").replaceChildren(el("option", { value: "", text: "All actions" }),
            ...data.actions.map((a) => el("option", { value: a, text: a })));
        $("log-action").value = selected;
        const table = $("log-table");
        if (!append) {
            table.replaceChildren(el("tr", {}, ...["Time", "Action", "Actor", "Target", "Detail"].map((t) => el("th", { text: t }))));
        }
        for (const e of data.entries) {
            table.append(el("tr", {},
                el("td", { text: formatDate(e.createdAt) }), el("td", { text: e.action }),
                el("td", { text: e.actorRole || "-" }), el("td", { text: e.target || "-" }),
                el("td", { text: JSON.stringify(e.detail || {}) })));
        }
        state.logCursor = data.nextBeforeId;
        $("log-more").hidden = !data.nextBeforeId;
    }

    /* Database */
    async function loadDatabase() {
        const d = await guarded(() => api("/api/supreme/database"));
        if (!d) return;
        const info = [["Engine", d.dialect], ["Driver", d.driver], ["Healthy", d.healthy ? "Yes" : "No", d.healthy ? "oc-ok" : "oc-bad"]];
        if (d.pool) for (const [k, v] of Object.entries(d.pool)) info.push([k, v]);
        fillTable($("db-info"), info);
        fillTable($("db-tables"), Object.entries(d.tables));
        $("db-note").textContent = d.note;
    }

    /* AI control center */
    function entryEditor(entry, withRoles) {
        const wrap = el("div", { class: "oc-entry" });
        const title = el("input", { "data-f": "title", maxlength: "80", value: entry.title || "" });
        const remove = el("button", { type: "button", class: "oc-btn small danger", text: "Remove" });
        remove.addEventListener("click", () => wrap.remove());
        wrap.append(el("div", { class: "oc-entry-head" }, el("label", {}, "Title", title), remove));
        const keywords = el("input", { "data-f": "keywords", value: (entry.keywords || []).join(", ") });
        wrap.append(el("label", {}, "Keywords (comma separated, up to 12)", keywords));
        const answer = el("textarea", { "data-f": "answer", rows: "3", maxlength: "600" });
        answer.value = entry.answer || "";
        wrap.append(el("label", {}, "Answer", answer));
        if (withRoles) {
            const roles = el("div", { class: "oc-roles" });
            for (const [value, label] of ROLES) {
                const box = el("input", { type: "checkbox", "data-role": value });
                box.checked = (entry.roles || []).includes(value);
                roles.append(el("label", { class: "oc-check" }, box, label));
            }
            wrap.append(roles);
        }
        return wrap;
    }

    function renderEntries(container, entries, withRoles) {
        container.replaceChildren(...entries.map((entry) => entryEditor(entry, withRoles)));
    }

    function readEntries(container, withRoles) {
        return [...container.children].map((wrap) => {
            const entry = {
                title: wrap.querySelector('[data-f="title"]').value.trim(),
                keywords: wrap.querySelector('[data-f="keywords"]').value.split(",").map((k) => k.trim()).filter(Boolean),
                answer: wrap.querySelector('[data-f="answer"]').value.trim(),
            };
            if (withRoles) {
                entry.roles = [...wrap.querySelectorAll("[data-role]")].filter((b) => b.checked).map((b) => b.dataset.role);
            }
            return entry;
        });
    }

    function renderConfig(payload) {
        const c = payload.config;
        state.ai = payload;
        $("ai-log").checked = c.logConversations;
        $("ai-identity").value = c.identityReply;
        $("pub-enabled").checked = c.public.enabled;
        $("pub-greeting").value = c.public.greeting;
        $("pub-prompt").value = c.public.systemPrompt;
        $("pub-refusal").value = c.public.refusalMessage;
        renderEntries($("pub-knowledge"), c.public.knowledge, false);
        $("por-enabled").checked = c.portal.enabled;
        $("por-prompt").value = c.portal.systemPrompt;
        $("por-fallback").value = c.portal.fallbackReply;
        renderEntries($("por-knowledge"), c.portal.knowledge, true);
        const m = payload.meta || {};
        $("ai-meta").textContent = `Version ${m.version || 0}` + (m.updatedAt ? ` | ${formatDate(m.updatedAt)} by ${m.updatedBy}` : " | defaults");
    }

    function collectConfig() {
        return {
            logConversations: $("ai-log").checked,
            identityReply: $("ai-identity").value.trim(),
            public: {
                enabled: $("pub-enabled").checked, greeting: $("pub-greeting").value.trim(),
                systemPrompt: $("pub-prompt").value.trim(), refusalMessage: $("pub-refusal").value.trim(),
                knowledge: readEntries($("pub-knowledge"), false),
            },
            portal: {
                enabled: $("por-enabled").checked, systemPrompt: $("por-prompt").value.trim(),
                fallbackReply: $("por-fallback").value.trim(),
                knowledge: readEntries($("por-knowledge"), true),
            },
        };
    }

    async function loadAi() {
        const data = await guarded(() => api("/api/supreme/ai/config"));
        if (data) renderConfig(data);
    }

    async function saveAi() {
        const data = await guarded(() => api("/api/supreme/ai/config", { method: "PUT", body: { config: collectConfig() } }));
        if (data) { renderConfig(data); notify("AI configuration published."); }
    }

    async function resetAi() {
        if (!window.confirm("Reset all AI settings to the built-in defaults?")) return;
        const data = await guarded(() => api("/api/supreme/ai/config/reset", { method: "POST" }));
        if (data) { renderConfig(data); notify("AI configuration reset to defaults."); }
    }

    async function loadConversations() {
        const channel = $("conv-channel").value;
        const items = await guarded(() => api("/api/supreme/ai/conversations?limit=50" + (channel ? "&channel=" + channel : "")));
        if (!items) return;
        const rows = items.map((i) => el("div", { class: "oc-row" },
            el("div", { class: "oc-row-head" },
                el("span", { class: "oc-badge", text: `${i.channel} | ${i.role || "visitor"} | ${i.outcome}` }),
                el("span", { class: "oc-hint", text: formatDate(i.createdAt) })),
            el("div", { class: "oc-q", text: "Q: " + i.question }),
            el("div", { class: "oc-a", text: "A: " + i.reply })));
        $("conv-list").replaceChildren(...(rows.length ? rows : [el("p", { class: "oc-hint", text: "No conversations recorded." })]));
    }

    async function runTest() {
        const message = $("test-message").value.trim();
        if (!message) return;
        const data = await guarded(() => api("/api/supreme/ai/test", {
            method: "POST",
            body: { channel: $("test-channel").value, role: $("test-role").value, message, config: collectConfig() },
        }));
        if (!data) return;
        const box = $("test-result");
        box.textContent = `${data.reply}\n\n[outcome: ${data.outcome}]`;
        box.hidden = false;
    }

    function ticketCard(t) {
        const reply = el("textarea", { rows: "2", maxlength: "1000", placeholder: "Reply to the partner" });
        reply.value = t.reply || "";
        const status = el("select", {},
            ...[["open", "Open"], ["in_progress", "In progress"], ["closed", "Closed"]]
                .map(([value, label]) => el("option", { value, text: label })));
        status.value = t.status;
        const save = el("button", { class: "oc-btn", type: "button", text: "Save" });
        save.addEventListener("click", async () => {
            const done = await guarded(() => api(`/api/supreme/tickets/${encodeURIComponent(t.id)}/update`, {
                method: "POST", body: { status: status.value, reply: reply.value.trim() },
            }));
            if (done) { notify("Ticket updated."); loadTickets(); }
        });
        return el("div", { class: "oc-row" },
            el("div", { class: "oc-row-head" },
                el("span", { class: "oc-badge", text: `${t.id} | ${t.category} | ${t.status}` }),
                el("span", { class: "oc-hint", text: formatDate(t.createdAt) })),
            el("div", { class: "oc-q", text: `${t.name} (${t.mobile}, ${t.role}): ${t.subject}` }),
            el("div", { class: "oc-a", text: t.message + (t.reference ? `\nRef: ${t.reference}` : "") }),
            reply, status, save);
    }

    async function loadTickets() {
        const filter = $("ticket-filter").value;
        const data = await guarded(() => api("/api/supreme/tickets" + (filter ? "?status=" + filter : "")));
        if (!data) return;
        const cards = data.tickets.map(ticketCard);
        $("ticket-list").replaceChildren(...(cards.length ? cards : [el("p", { class: "oc-hint", text: "No tickets." })]));
    }

    const loaders = {
        overview: loadOverview, staff: loadStaff, security: loadSecurity, tickets: loadTickets,
        logs: () => loadLogs(false), database: loadDatabase, ai: loadAi,
    };

    async function init() {
        let me;
        try { me = await api("/api/auth/me"); } catch { return; }
        if (!me.user || me.user.role !== "master") { window.location.assign("/login.html"); return; }
        $("oc-owner-name").textContent = me.user.name;

        document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
        document.querySelectorAll("[data-subtab]").forEach((b) => b.addEventListener("click", () => selectSubtab(b.dataset.subtab)));

        $("oc-signout").addEventListener("click", async () => {
            try { await api("/api/auth/logout", { method: "POST" }); } catch { /* redirect anyway */ }
            window.location.assign("/login.html");
        });
        $("oc-replay-greeting").addEventListener("click", () => speakGreeting());
        $("oc-play-greeting").addEventListener("click", () => speakGreeting());

        $("staff-form").addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const body = Object.fromEntries(new FormData(form).entries());
            const done = await guarded(() => api("/api/owner/staff", { method: "POST", body }));
            if (done) { form.reset(); notify("Staff pre-authorized."); loadStaff(); }
        });

        $("code-form").addEventListener("submit", async (event) => {
            event.preventDefault();
            const id = $("code-app-id").value.trim();
            const done = await guarded(() => api(`/api/owner/partners/${encodeURIComponent(id)}/setup-code`, { method: "POST" }));
            if (!done) return;
            const box = $("code-result");
            box.textContent = `${done.identifier} (${done.mobile})\nOne-time setup code: ${done.code}`;
            box.hidden = false;
            $("code-app-id").value = "";
        });

        $("sec-clear-lockouts").addEventListener("click", async () => {
            const done = await guarded(() => api("/api/supreme/security/clear-lockouts", { method: "POST" }));
            if (done) { notify(`Lockouts cleared: ${done.cleared}`); loadSecurity(); }
        });
        $("sec-unlock-form").addEventListener("submit", async (event) => {
            event.preventDefault();
            const done = await guarded(() => api("/api/supreme/security/unlock", {
                method: "POST", body: { identifier: $("unlock-identifier").value.trim(), ip: $("unlock-ip").value.trim() },
            }));
            if (done) { notify("Sign-in unblocked."); $("unlock-identifier").value = ""; $("unlock-ip").value = ""; loadSecurity(); }
        });
        $("sec-revoke-form").addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!window.confirm("Sign out every other session?")) return;
            const done = await guarded(() => api("/api/supreme/security/revoke-sessions", { method: "POST", body: { password: $("sec-password").value } }));
            $("sec-password").value = "";
            if (done) { notify(`Sessions revoked: ${done.revoked}`); loadSecurity(); }
        });

        $("alerts-read").addEventListener("click", async () => {
            const done = await guarded(() => api("/api/supreme/alerts/read", { method: "POST" }));
            if (done) loadAlerts();
        });
        $("ticket-refresh").addEventListener("click", loadTickets);
        $("ticket-filter").addEventListener("change", loadTickets);
        $("log-refresh").addEventListener("click", () => loadLogs(false));
        $("log-action").addEventListener("change", () => loadLogs(false));
        $("log-more").addEventListener("click", () => loadLogs(true));

        $("ai-save").addEventListener("click", saveAi);
        $("ai-reload").addEventListener("click", loadAi);
        $("ai-reset").addEventListener("click", resetAi);
        $("pub-add").addEventListener("click", () => $("pub-knowledge").append(entryEditor({}, false)));
        $("por-add").addEventListener("click", () => $("por-knowledge").append(entryEditor({}, true)));
        $("conv-refresh").addEventListener("click", loadConversations);
        $("conv-channel").addEventListener("change", loadConversations);
        $("test-run").addEventListener("click", runTest);
        $("test-message").addEventListener("keydown", (e) => { if (e.key === "Enter") runTest(); });

        state.loaded.add("overview");
        loadOverview();
        greetAfterLogin(me.user);
    }

    init();
})();
