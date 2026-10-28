(function () {
    "use strict";

    const SLAB_NOTE = "Indicative slabs. Final rates follow your approved partner agreement and may change.";

    // Replace these URLs if the department publishes a different official address.
    const GOVT_LINKS = [
        {
            label: "Krishak Bandhu",
            note: "Department of Agriculture, Govt. of West Bengal",
            url: "https://agriculture.wb.gov.in/krishak-bandhu-natun-"
        },
        {
            label: "Joy Bangla (Jai Bangla)",
            note: "West Bengal Government schemes directory (wb.gov.in)",
            url: "https://wb.gov.in/government-schemes.aspx"
        }
    ];

    const SERVICES = {
        aeps: {
            name: "AEPS",
            enquiry: "AEPS / RD device information",
            desc: "Aadhaar Enabled Payment System: cash withdrawal, balance enquiry, mini statement and Aadhaar Pay for eligible Aadhaar-linked accounts.",
            steps: ["Customer shares Aadhaar number and selects the bank", "Customer authenticates on a certified RD device", "Transaction is confirmed and a receipt is issued"],
            slabs: [["Withdrawal \u20B9100 - \u20B9499", "\u20B91.00"], ["Withdrawal \u20B9500 - \u20B91,999", "\u20B95.00"], ["Withdrawal \u20B92,000 - \u20B910,000", "\u20B97.00"], ["Balance enquiry", "\u20B90.25"], ["Mini statement", "\u20B90.50"]]
        },
        microatm: {
            name: "Micro ATM",
            enquiry: "Micro ATM / money transfer",
            desc: "Assisted card-based banking and cash access using an authorized Micro ATM device.",
            steps: ["Customer inserts or taps the debit card", "Customer enters the card PIN on the device", "Cash is handed over and a receipt is printed"],
            slabs: [["Device", "Price on request; no commission"], ["Transactions", "As per partner agreement"]]
        },
        dmt: {
            name: "Money Transfer",
            enquiry: "Micro ATM / money transfer",
            desc: "Domestic money transfer to any bank account, subject to provider availability.",
            steps: ["Register the sender with mobile OTP", "Add and verify the beneficiary account", "Enter the amount and confirm the transfer"],
            slabs: [["\u20B91 - \u20B95,000", "\u20B96.00 flat"], ["\u20B95,001 - \u20B925,000", "0.40%"]]
        },
        loan: {
            name: "Loan Repayment",
            enquiry: "Loan repayment support",
            desc: "Help customers make eligible loan EMI repayments at a nearby assisted service centre.",
            steps: ["Select the bank or NBFC", "Enter the loan account number and fetch the dues", "Collect the payment and share the receipt"],
            slabs: [["Per payment", "\u20B95.00"]]
        },
        electricity: {
            name: "Electricity Bill",
            enquiry: "BBPS / bill payment",
            desc: "Pay electricity bills across boards through Bharat BillPay.",
            steps: ["Choose the electricity board", "Enter the consumer number and fetch the bill", "Collect the amount and confirm the payment"],
            slabs: [["Per bill", "0.50% - 1.00%"]]
        },
        watergas: {
            name: "Water & Gas",
            enquiry: "BBPS / bill payment",
            desc: "Water bills, piped gas bills and cylinder booking payments.",
            steps: ["Choose the water or gas provider", "Enter the customer or consumer ID", "Confirm the amount and complete the payment"],
            slabs: [["Gas / water bill", "0.50%"]]
        },
        mobile: {
            name: "Mobile & DTH",
            enquiry: "BBPS / bill payment",
            desc: "Prepaid mobile recharge for all operators and DTH recharge.",
            steps: ["Enter the mobile or DTH subscriber number", "Choose the operator and plan", "Collect the amount and confirm the recharge"],
            slabs: [["Prepaid (all operators)", "2.0%"]]
        },
        bills: {
            name: "Other Bills",
            enquiry: "BBPS / bill payment",
            desc: "Fastag, broadband, credit card and other bills through Bharat BillPay (BBPS).",
            steps: ["Pick the biller category", "Enter the account details and fetch the bill", "Collect the amount and confirm the payment"],
            slabs: [["Fastag", "0.50%"], ["Broadband", "1.00%"], ["Credit card bill", "0.30%"]]
        },
        pan: {
            name: "PAN Card",
            enquiry: "PAN card processing",
            desc: "Assisted new PAN applications and correction requests through authorized service providers.",
            steps: ["Collect identity and address proofs", "Fill in the application and verify with eKYC", "Submit and share the acknowledgement number"],
            slabs: [["New PAN", "\u20B925 per application"], ["Correction", "\u20B915 per application"]]
        },
        desk: {
            name: "Service Desk",
            enquiry: "Retailer or Distributor support",
            desc: "Onboarding, device and service support from the R.M Digital Centre team.",
            steps: ["Describe what you need in the enquiry form", "Our team reviews and contacts you", "Get onboarded or resolved"],
            slabs: [["Support", "Free for approved partners"]]
        }
    };

    const dialog = document.getElementById("service-modal");
    const body = document.getElementById("service-modal-body");
    const closeButton = document.getElementById("service-modal-close");
    if (!dialog || !body) {
        return;
    }

    let lastTrigger = null;

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) {
            node.className = className;
        }
        if (text !== undefined) {
            node.textContent = text;
        }
        return node;
    }

    function heading(text) {
        const h = el("h3", "service-modal-title", text);
        h.id = "service-modal-title";
        return h;
    }

    function section(title) {
        return el("h4", "service-modal-section", title);
    }

    function renderService(service) {
        body.replaceChildren();
        body.append(heading(service.name), el("p", "service-modal-desc", service.desc));

        body.append(section("How it works"));
        const steps = el("ol", "service-modal-steps");
        service.steps.forEach(function (step) {
            steps.append(el("li", "", step));
        });
        body.append(steps);

        body.append(section("Commission details"));
        const table = el("table", "service-modal-table");
        const head = el("tr");
        head.append(el("th", "", "Slab / Type"), el("th", "", "Commission"));
        table.append(head);
        service.slabs.forEach(function (row) {
            const tr = el("tr");
            tr.append(el("td", "", row[0]), el("td", "", row[1]));
            table.append(tr);
        });
        body.append(table, el("p", "service-modal-note", SLAB_NOTE));

        const actions = el("div", "service-modal-actions");
        const proceed = el("button", "btn primary", "Proceed to Form");
        proceed.type = "button";
        proceed.addEventListener("click", function () {
            proceedToForm(service.enquiry);
        });
        const cancel = el("button", "btn quiet", "Close");
        cancel.type = "button";
        cancel.addEventListener("click", closeModal);
        actions.append(proceed, cancel);
        body.append(actions);
    }

    function renderGovt() {
        body.replaceChildren();
        body.append(heading("Government schemes"),
            el("p", "service-modal-desc", "Choose a scheme to open its official West Bengal government page in a new tab."));
        const list = el("div", "service-modal-links");
        GOVT_LINKS.forEach(function (item) {
            const link = el("a", "service-modal-link");
            link.href = item.url;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.append(el("strong", "", item.label), el("span", "", item.note));
            list.append(link);
        });
        body.append(list);

        const actions = el("div", "service-modal-actions");
        const proceed = el("button", "btn primary", "Need help applying? Proceed to Form");
        proceed.type = "button";
        proceed.addEventListener("click", function () {
            proceedToForm("Krishak Bandhu / Jai Bangla");
        });
        const cancel = el("button", "btn quiet", "Close");
        cancel.type = "button";
        cancel.addEventListener("click", closeModal);
        actions.append(proceed, cancel);
        body.append(actions);
    }

    function openModal(key, trigger) {
        if (key === "govt") {
            renderGovt();
        } else if (SERVICES[key]) {
            renderService(SERVICES[key]);
        } else {
            return;
        }
        lastTrigger = trigger;
        if (typeof dialog.showModal === "function") {
            dialog.showModal();
        } else {
            dialog.setAttribute("open", "");
        }
    }

    function closeModal() {
        if (typeof dialog.close === "function") {
            dialog.close();
        } else {
            dialog.removeAttribute("open");
        }
        if (lastTrigger) {
            lastTrigger.focus();
        }
    }

    function proceedToForm(enquiry) {
        const select = document.getElementById("service-request-type");
        if (select) {
            select.value = enquiry;
        }
        closeModal();
        const target = document.getElementById("service-request");
        if (target) {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
        const nameField = document.getElementById("service-request-name");
        if (nameField) {
            nameField.focus({ preventScroll: true });
        }
    }

    document.querySelectorAll("[data-service-key]").forEach(function (tile) {
        tile.addEventListener("click", function () {
            openModal(tile.dataset.serviceKey, tile);
        });
    });
    closeButton.addEventListener("click", closeModal);
    document.addEventListener("keydown", function (event) {
        if (event.key === "Escape" && dialog.open) {
            event.preventDefault();
            closeModal();
        }
    });
    dialog.addEventListener("click", function (event) {
        if (event.target === dialog) {
            closeModal();
        }
    });
})();
