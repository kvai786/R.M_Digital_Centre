"use strict";

(function () {
    const PREVIEW = window.location.pathname.replace(/\/+$/, "") === "/preview-dashboard";
    const DEMO = { name: "DEMO PARTNER", id: "RMD-DEMO-101", balance: "\u20B90.00 (Preview Mode)" };
    const SLAB_NOTE = "Indicative slabs. Final rates follow your partner agreement and may change.";

    const SERVICES = {
        recharge: { name: "Mobile Recharge", icon: "\uD83D\uDCF1", desc: "Prepaid mobile recharge for all operators.", slabs: [["Prepaid (all operators)", "2.0%"]] },
        aepsw: { name: "AEPS Withdraw", icon: "\uD83C\uDFE7", desc: "Aadhaar-enabled cash withdrawal using biometric authentication.", slabs: [["\u20B9100 - \u20B9499", "\u20B91.00"], ["\u20B9500 - \u20B91,999", "\u20B95.00"], ["\u20B92,000 - \u20B910,000", "\u20B97.00"]] },
        aepsd: { name: "AEPS Deposit", icon: "\uD83D\uDCB5", desc: "Cash deposit into an Aadhaar-linked bank account.", slabs: [["\u20B9100 - \u20B91,000", "\u20B91.00"], ["\u20B91,001 - \u20B910,000", "\u20B93.00"]] },
        itr: { name: "ITR Filing", icon: "\uD83E\uDDFE", desc: "Income tax return filing assistance for customers.", slabs: [["Salaried", "\u20B9100 per filing"], ["Business / Professional", "\u20B9250 per filing"]] },
        balenq: { name: "Balance Enquiry", icon: "\uD83D\uDCB0", desc: "Check an Aadhaar-linked bank balance.", slabs: [["Per enquiry", "\u20B90.25"]] },
        cash: { name: "Cash Collection", icon: "\uD83D\uDCB3", desc: "Collect loan EMIs and dues on behalf of partner institutions.", slabs: [["Per collection", "0.30%"]] },
        insurance: { name: "Insurance", icon: "\uD83D\uDEE1\uFE0F", desc: "Life and health insurance policy assistance.", slabs: [["Health", "Up to 10% of premium"], ["Life", "Up to 15% of premium"]] },
        ministmt: { name: "AEPS Mini Statement", icon: "\uD83D\uDCC4", desc: "Last five transactions of an Aadhaar-linked account.", slabs: [["Per statement", "\u20B90.50"]] },
        cms: { name: "CMS", icon: "\uD83C\uDFE6", desc: "Cash management services for partner institutions.", slabs: [["Per transaction", "0.20%"]] },
        digikhata: { name: "Digi Khata", icon: "\uD83D\uDCD2", desc: "Digital ledger for shop credit and payments.", slabs: [["Activation", "\u20B950 per merchant"]] },
        dmt: { name: "Money Transfer", icon: "\uD83D\uDCB8", desc: "Domestic money transfer to any bank account.", slabs: [["\u20B91 - \u20B95,000", "\u20B96.00 flat"], ["\u20B95,001 - \u20B925,000", "0.40%"]] },
        movebank: { name: "Move to Bank", icon: "\uD83C\uDFE6", desc: "Move wallet balance to your bank account.", slabs: [["Per transfer", "No commission (charges apply)"]] },
        electricity: { name: "Electricity", icon: "\uD83D\uDCA1", desc: "Electricity bill payment across boards.", slabs: [["Per bill", "0.50% - 1.00%"]] },
        gas: { name: "Gas", icon: "\uD83D\uDD25", desc: "Piped gas and cylinder booking payments.", slabs: [["Per bill", "0.50%"]] },
        fastag: { name: "Fastag", icon: "\uD83D\uDE97", desc: "Fastag recharge for all issuing banks.", slabs: [["Per recharge", "0.50%"]] },
        creditcard: { name: "Credit Card Bill", icon: "\uD83D\uDCB3", desc: "Credit card bill payment.", slabs: [["Per payment", "0.30%"]] },
        loanemi: { name: "Loan EMI", icon: "\uD83D\uDCCB", desc: "Loan EMI payments to banks and NBFCs.", slabs: [["Per payment", "\u20B95.00"]] },
        broadband: { name: "Broadband", icon: "\uD83C\uDF10", desc: "Broadband and landline bill payment.", slabs: [["Per bill", "1.00%"]] },
        ott: { name: "OTT Play", icon: "\uD83D\uDCFA", desc: "OTT subscription vouchers.", slabs: [["Per voucher", "3.00% - 5.00%"]] },
        pan: { name: "PAN Card", icon: "\uD83D\uDCDD", desc: "New PAN and correction applications.", slabs: [["New PAN", "\u20B925 per application"], ["Correction", "\u20B915 per application"]] },
        reports: { name: "Business Reports", icon: "\uD83D\uDCCA", desc: "Transaction, commission and settlement reports.", slabs: [["Reports", "Free"]] },
        vehicleins: { name: "Car / Bike Insurance", icon: "\uD83D\uDE98", desc: "Motor insurance policies for cars and two-wheelers.", slabs: [["Two-wheeler", "Up to 15% of OD premium"], ["Car", "Up to 12% of OD premium"]] },
        train: { name: "Train Booking", icon: "\uD83D\uDE86", desc: "IRCTC train ticket booking.", slabs: [["Sleeper / Non-AC", "\u20B910 per ticket"], ["AC", "\u20B920 per ticket"]] },
        bus: { name: "Bus Booking", icon: "\uD83D\uDE8C", desc: "Bus ticket booking across operators.", slabs: [["Per ticket", "3.00%"]] },
        flight: { name: "Flight Booking", icon: "\u2708\uFE0F", desc: "Domestic and international flight booking.", slabs: [["Domestic", "0.50%"], ["International", "0.75%"]] },
        hotel: { name: "Hotel Booking", icon: "\uD83C\uDFE8", desc: "Hotel reservations.", slabs: [["Per booking", "Up to 5.00%"]] },
        ccapply: { name: "Credit Card", icon: "\uD83D\uDCB3", desc: "Apply for credit cards from partner banks.", slabs: [["Per approved card", "\u20B9300 - \u20B91,000"]] },
        bankopen: { name: "Bank Account Opening", icon: "\uD83C\uDFE6", desc: "Savings account opening with partner banks.", slabs: [["Per account", "\u20B950 - \u20B9150"]] },
        loans: { name: "Loans", icon: "\uD83D\uDCB9", desc: "Personal and business loan leads.", slabs: [["Per disbursed loan", "0.50% - 1.00%"]] },
        mantra: { name: "Mantra L1", icon: "\uD83D\uDC46", desc: "Mantra MFS110 L1 biometric fingerprint device.", slabs: [["Hardware", "Price on request; no commission"]] },
        microatm: { name: "Micro ATM", icon: "\uD83D\uDCDF", desc: "Micro ATM device for card-based banking.", slabs: [["Hardware", "Price on request; no commission"]] },
        printer: { name: "Thermal Printer", icon: "\uD83D\uDDA8\uFE0F", desc: "Thermal receipt printer.", slabs: [["Hardware", "Price on request; no commission"]] },
    };

    const SECTIONS = [
        { title: "Favourite Box", items: ["recharge", "aepsw", "aepsd", "itr", "balenq", "cash", "insurance"] },
        { title: "BC Banking", items: ["ministmt", "cms", "digikhata", "dmt", "movebank"] },
        { title: "Recharge & Bill Payment", items: ["electricity", "gas", "fastag", "creditcard", "loanemi", "broadband", "ott"] },
        { title: "E-Governance", items: ["pan", "itr", "reports"] },
        { title: "Insurance & Travel", items: ["vehicleins", "train", "bus", "flight", "hotel"] },
        { title: "Affiliate Links & Hardware Products", items: ["ccapply", "bankopen", "loans", "mantra", "microatm", "printer"] },
    ];

    const MENU = [
        { id: "dashboard", label: "Dashboard", icon: "\uD83C\uDFE0" },
        { id: "profile", label: "Profile", icon: "\uD83D\uDC64", href: "retailer.html" },
        { id: "commission", label: "Commission Structure", icon: "\uD83D\uDCB9" },
        { id: "pan", label: "Pan Certificates", icon: "\uD83D\uDCDD", service: "pan" },
        { id: "idcard", label: "ID Card", icon: "\uD83C\uDD94" },
        { id: "reports", label: "Reports", icon: "\uD83D\uDCCA", service: "reports" },
        { id: "password", label: "Change Password", icon: "\uD83D\uDD11" },
        { id: "logout", label: "Logout", icon: "\uD83D\uDEAA" },
    ];

    let currentUser = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined) { node.textContent = text; }
        return node;
    }

    function csrfToken() {
        const item = document.cookie.split("; ").find(function (c) { return c.startsWith("rm_csrf="); });
        return item ? decodeURIComponent(item.slice("rm_csrf=".length)) : "";
    }

    async function postJson(path, body) {
        const response = await fetch(path, {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken() },
            body: JSON.stringify(body || {}),
        });
        const result = await response.json().catch(function () { return {}; });
        return { ok: response.ok, status: response.status, data: result };
    }

    /* ---------- modal ---------- */
    const modal = document.getElementById("modal");
    const modalBody = document.getElementById("modal-body");
    let lastFocus = null;

    function openModal(nodes) {
        lastFocus = document.activeElement;
        modalBody.replaceChildren.apply(modalBody, nodes);
        modal.hidden = false;
        document.getElementById("modal-close").focus();
    }

    function closeModal() {
        modal.hidden = true;
        if (lastFocus && lastFocus.focus) { lastFocus.focus(); }
    }

    function slabTable(slabs) {
        const table = el("table", "slab-table");
        const head = el("tr");
        head.append(el("th", "", "Slab / Type"), el("th", "", "Commission"));
        table.append(head);
        slabs.forEach(function (row) {
            const tr = el("tr");
            tr.append(el("td", "", row[0]), el("td", "", row[1]));
            table.append(tr);
        });
        return table;
    }

    function serviceModal(key) {
        const service = SERVICES[key];
        const title = el("h3", "", service.name);
        title.id = "modal-title";
        const nodes = [el("div", "modal-icon", service.icon), title, el("p", "", service.desc),
            slabTable(service.slabs), el("p", "modal-note", SLAB_NOTE)];
        if (PREVIEW) {
            const button = el("button", "modal-action", "Transactions disabled in Preview");
            button.disabled = true;
            nodes.push(button);
        } else {
            const link = el("a", "modal-action", "Request this service");
            link.href = "retailer.html";
            nodes.push(link);
        }
        openModal(nodes);
    }

    function commissionModal() {
        const title = el("h3", "", "Commission Structure");
        title.id = "modal-title";
        const nodes = [title];
        SECTIONS.forEach(function (section) {
            nodes.push(el("p", "", section.title));
            const slabs = [];
            section.items.forEach(function (key) {
                SERVICES[key].slabs.forEach(function (slab) {
                    slabs.push([SERVICES[key].name + " - " + slab[0], slab[1]]);
                });
            });
            nodes.push(slabTable(slabs));
        });
        nodes.push(el("p", "modal-note", SLAB_NOTE));
        openModal(nodes);
    }

    function infoModal(heading, message) {
        const title = el("h3", "", heading);
        title.id = "modal-title";
        openModal([title, el("p", "", message)]);
    }

    /* ---------- rendering ---------- */
    function renderSidebar() {
        const nav = document.getElementById("dash-sidebar");
        nav.replaceChildren();
        MENU.forEach(function (item) {
            const useLink = item.href && !PREVIEW;
            const node = useLink ? el("a", "side-link") : el("button", "side-link");
            if (useLink) { node.href = item.href; } else { node.type = "button"; }
            if (item.id === "dashboard") { node.classList.add("active"); }
            node.append(el("span", "", item.icon), el("span", "", item.label));
            node.addEventListener("click", function () { onMenu(item); });
            nav.append(node);
        });
    }

    async function onMenu(item) {
        document.getElementById("dash-sidebar").classList.remove("open");
        if (item.id === "dashboard") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
        if (item.href && !PREVIEW) { return; }
        if (item.id === "commission") { commissionModal(); return; }
        if (item.service) { serviceModal(item.service); return; }
        if (item.id === "logout") {
            if (PREVIEW) { window.location.assign("login.html"); return; }
            await postJson("/api/auth/logout");
            window.location.assign("login.html");
            return;
        }
        if (PREVIEW) {
            infoModal(item.label, "This section is available after you sign in. Preview Mode shows demo data only.");
        } else if (item.id === "password") {
            infoModal(item.label, "For your security, password changes are handled through support. Use Profile to raise a request with an independently verified channel.");
        } else {
            infoModal(item.label, "Contact your Distributor or the official helpline from Profile for this request.");
        }
    }

    function renderSections() {
        const main = document.getElementById("dash-main");
        main.replaceChildren();
        SECTIONS.forEach(function (section) {
            const wrap = el("section", "service-section");
            wrap.setAttribute("aria-label", section.title);
            wrap.append(el("h2", "", section.title));
            const grid = el("div", "service-grid");
            section.items.forEach(function (key) {
                const tile = el("button", "service-tile");
                tile.type = "button";
                tile.append(el("span", "tile-icon", SERVICES[key].icon), el("span", "", SERVICES[key].name));
                tile.addEventListener("click", function () { serviceModal(key); });
                grid.append(tile);
            });
            wrap.append(grid);
            main.append(wrap);
        });
    }

    function setIdentity(name, id, balance) {
        document.getElementById("partner-name").textContent = name;
        document.getElementById("partner-id").textContent = id;
        document.getElementById("wallet-balance").textContent = balance;
    }

    /* ---------- assistant (verified sessions only) ---------- */
    function addMessage(log, text, who) {
        log.append(el("div", "chat-msg " + who, text));
        log.scrollTop = log.scrollHeight;
    }

    function injectAssistant() {
        const fab = el("button", "chat-fab", "\uD83D\uDCAC");
        fab.type = "button";
        fab.setAttribute("aria-label", "Open assistant");
        const panel = el("div", "chat-panel");
        panel.hidden = true;
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "R.M Digital Centre assistant");
        const log = el("div", "chat-log");
        log.setAttribute("aria-live", "polite");
        const form = el("form", "chat-form");
        const input = el("input");
        input.type = "text";
        input.maxLength = 500;
        input.placeholder = "Ask about our services...";
        input.setAttribute("aria-label", "Your message");
        input.autocomplete = "off";
        const send = el("button", "", "Send");
        send.type = "submit";
        form.append(input, send);
        panel.append(el("div", "chat-head", "R.M Assistant"), log, form);
        document.body.append(fab, panel);
        addMessage(log, "Namaste! How can I help you today?", "bot");

        fab.addEventListener("click", function () {
            panel.hidden = !panel.hidden;
            if (!panel.hidden) { input.focus(); }
        });
        form.addEventListener("submit", async function (event) {
            event.preventDefault();
            const text = input.value.trim();
            if (!text) { return; }
            addMessage(log, text, "user");
            input.value = "";
            send.disabled = true;
            try {
                const result = await postJson("/assistant/chat", { message: text });
                if (result.status === 401) { window.location.assign("login.html"); return; }
                addMessage(log, result.data.reply || result.data.detail || "Sorry, I could not respond right now.", "bot");
            } catch (error) {
                addMessage(log, "The assistant is unavailable. Please try again.", "bot");
            } finally {
                send.disabled = false;
                input.focus();
            }
        });
    }

    /* ---------- init ---------- */
    async function init() {
        renderSidebar();
        document.getElementById("modal-close").addEventListener("click", closeModal);
        modal.addEventListener("click", function (event) { if (event.target === modal) { closeModal(); } });
        document.addEventListener("keydown", function (event) { if (event.key === "Escape" && !modal.hidden) { closeModal(); } });
        const toggle = document.getElementById("menu-toggle");
        toggle.addEventListener("click", function () {
            const open = document.getElementById("dash-sidebar").classList.toggle("open");
            toggle.setAttribute("aria-expanded", String(open));
        });

        const walletNote = function (label) {
            return function () {
                infoModal(label, PREVIEW ? "Wallet actions are disabled in Preview Mode." :
                    "Wallet services are not enabled on your account yet. Contact support from Profile.");
            };
        };
        document.getElementById("wallet-statement").addEventListener("click", walletNote("Wallet Statement"));
        document.getElementById("add-money").addEventListener("click", walletNote("Add Money"));

        if (PREVIEW) {
            document.getElementById("preview-banner").hidden = false;
            setIdentity(DEMO.name, DEMO.id, DEMO.balance);
            renderSections();
            return;
        }

        try {
            const response = await fetch("/api/auth/me", { credentials: "same-origin" });
            if (!response.ok) { throw new Error("unauthenticated"); }
            currentUser = (await response.json()).user;
        } catch (error) {
            window.location.replace("login.html");
            return;
        }
        setIdentity(currentUser.name, currentUser.userId || "", "\u20B90.00");
        renderSections();
        injectAssistant();
    }

    init();
})();
