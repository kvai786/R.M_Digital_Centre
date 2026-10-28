"use strict";

const APPLICATIONS_KEY = "rm-demo-applications";
const BLOCKED_PARTNER_MOBILES_KEY = "rm-demo-blocked-partner-mobiles";
const DISTRIBUTOR_PIN_MAPPINGS_KEY = "rm-demo-distributor-pin-mappings";
const DISTRIBUTOR_NOTIFICATIONS_KEY = "rm-demo-distributor-notifications";
const MASTER_APPROVALS_KEY = "rm-demo-approvals";
const PENDING_WELCOME_KEY = "rm-demo-pending-welcome";
const RETAIL_PROFILES_KEY = "rm-demo-retail-profiles";
const UPLINE_REQUESTS_KEY = "rm-demo-upline-requests";
const SERVICE_REQUESTS_KEY = "rm-demo-service-requests";
const DOCUMENT_SCAN_API_URL = "/api/scan-document";
const MAX_SCAN_FILE_SIZE = 8 * 1024 * 1024;
let PORTAL_STATE = {};
let PORTAL_USER = null;
let PORTAL_RETAILER = null;
const PORTAL_WRITE_QUEUES = new Map();

async function apiRequest(path, options) {
    const requestOptions = Object.assign({ credentials: "same-origin" }, options || {});
    const method = String(requestOptions.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
        const csrf = document.cookie.split("; ").find(function (item) { return item.startsWith("rm_csrf="); });
        if (csrf) {
            requestOptions.headers = Object.assign({}, requestOptions.headers, {
                "X-CSRF-Token": decodeURIComponent(csrf.slice("rm_csrf=".length)),
            });
        }
    }
    if (requestOptions.body && typeof requestOptions.body !== "string" &&
        !(requestOptions.body instanceof FormData)) {
        requestOptions.headers = Object.assign({}, requestOptions.headers, { "Content-Type": "application/json" });
        requestOptions.body = JSON.stringify(requestOptions.body);
    }
    const response = await fetch(path, requestOptions);
    const result = await response.json().catch(function () { return {}; });
    if (!response.ok) {
        throw new Error(result.detail || "The server could not complete this request.");
    }
    return result;
}

function reportApiFailure(error) {
    console.error("Portal API request failed:", error);
    const status = document.getElementById("dashboard-status") ||
        document.getElementById("application-status") ||
        document.getElementById("login-status") ||
        document.getElementById("service-request-status");
    if (status) {
        status.textContent = error.message || "The server request failed. Please try again.";
        status.hidden = false;
    }
}

async function hydratePortalData() {
    const page = document.body.dataset.page;
    if (page === "operations") {
        try {
            const result = await apiRequest("/api/portal/state");
            PORTAL_USER = result.user;
            PORTAL_STATE = result.state;
        } catch (error) {
            if (!/sign in|session has expired/i.test(error.message)) {
                throw error;
            }
        }
    } else if (page === "retailer") {
        try {
            const result = await apiRequest("/api/retailer/profile");
            PORTAL_USER = result.profile;
            PORTAL_RETAILER = result;
        } catch (error) {
            if (!/sign in|session has expired|permission/i.test(error.message)) {
                throw error;
            }
        }
    }
}

document.addEventListener("DOMContentLoaded", async function () {
    try {
        await hydratePortalData();
    } catch (error) {
        reportApiFailure(error);
    }
    const currentYear = document.getElementById("current-year");
    if (currentYear) {
        currentYear.textContent = String(new Date().getFullYear());
    }

    initializeServerApplicationForm();
    initializeDocumentScanner();
    initializePortalLogin();
    initializeOperationsDashboard();
    initializeRetailerDashboard();
    initializeServiceRequests();
    initializePwa();
});

function initializeServerApplicationForm() {
    const form = document.getElementById("application-form");
    if (!form) {
        return;
    }
    const roleInput = document.getElementById("application-role");
    const distributorDocuments = document.getElementById("distributor-documents");
    const operationalPin = document.getElementById("operational-pin");
    const distributorPins = document.getElementById("distributor-service-pincodes");
    const status = document.getElementById("application-status");
    const roleButtons = document.querySelectorAll("[data-role-choice]");
    const lookupForm = document.getElementById("rejected-lookup-form");
    const lookupStatus = document.getElementById("rejected-lookup-status");
    const lookupResult = document.getElementById("rejected-application-result");
    const correctionWorkspace = document.getElementById("correction-workspace");
    const successPanel = document.getElementById("submission-success");
    let editingApplicationId = "";

    function showStatus(element, message) {
        element.textContent = message;
        element.hidden = false;
    }

    function setRole(role) {
        const isDistributor = role === "distributor";
        roleInput.value = role;
        document.getElementById("distributor-pin-field").hidden = !isDistributor;
        distributorPins.disabled = !isDistributor;
        distributorPins.required = isDistributor;
        ["distributor-jurisdiction", "distributor-referral"].forEach(function (id) {
            const input = document.getElementById(id);
            input.disabled = !isDistributor;
            input.required = isDistributor;
        });
        const retailerKyc = document.getElementById("retailer-kyc-doc");
        retailerKyc.disabled = isDistributor;
        retailerKyc.required = !isDistributor;
        document.getElementById("retailer-kyc-field").hidden = isDistributor;
        operationalPin.disabled = isDistributor;
        document.getElementById("operational-pin-field").hidden = isDistributor;
        distributorDocuments.hidden = !isDistributor;
        distributorDocuments.querySelectorAll("input").forEach(function (input) {
            input.disabled = !isDistributor;
            input.required = isDistributor;
        });
        form.querySelectorAll('input[name="retailerIdentity"], input[name="retailerAddressProof"], input[name="retailerBusinessProof"]')
            .forEach(function (input) { input.required = true; });
        roleButtons.forEach(function (button) {
            const selected = button.dataset.roleChoice === role;
            button.classList.toggle("selected", selected);
            button.setAttribute("aria-selected", String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        form.setAttribute("aria-labelledby", isDistributor ? "distributor-tab" : "retailer-tab");
        document.getElementById("application-flow-title").textContent =
            isDistributor ? "Distributor application details" : "Retailer application details";
        document.getElementById("application-flow-description").textContent = isDistributor
            ? "Apply to build and support a network of Retailer partners."
            : "Apply to provide local customer services as a Retailer partner.";
        document.getElementById("application-submit-button").textContent =
            editingApplicationId ? "Resubmit corrected application"
                : "Submit " + (isDistributor ? "Distributor" : "Retailer") + " application";
    }

    const initialRole = new URLSearchParams(window.location.search).get("role") === "distributor"
        ? "distributor" : "retailer";
    roleButtons.forEach(function (button) {
        button.addEventListener("click", function () {
            if (!editingApplicationId) setRole(button.dataset.roleChoice);
        });
        button.addEventListener("keydown", function (event) {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const role = event.key === "Home" ? "retailer" : event.key === "End" ? "distributor"
                : button.dataset.roleChoice === "retailer" ? "distributor" : "retailer";
            setRole(role);
            document.getElementById(role + "-tab").focus();
        });
    });
    setRole(initialRole);

    operationalPin.addEventListener("input", async function () {
        const pin = operationalPin.value.replace(/\D/g, "").slice(0, 6);
        operationalPin.value = pin;
        const routeStatus = document.getElementById("pin-route-status");
        routeStatus.classList.remove("matched", "unmatched");
        routeStatus.textContent = "";
        if (pin.length !== 6) return;
        try {
            const result = await apiRequest("/api/public/pin-route?pin=" + encodeURIComponent(pin));
            if (result.matched) {
                routeStatus.textContent = "Matched local Distributor: " + result.name + " · ID " + result.distributorId + ".";
                routeStatus.classList.add("matched");
            } else {
                routeStatus.textContent = "No approved Distributor is mapped yet. The Master Admin will review this application.";
                routeStatus.classList.add("unmatched");
            }
        } catch (error) {
            reportApiFailure(error);
        }
    });

    function openCorrection(application) {
        editingApplicationId = application.id;
        setRole(application.role === "distributor" ? "distributor" : "retailer");
        const values = {
            "applicant-name": application.name,
            "applicant-mobile": application.mobile,
            "business-name": application.business,
            email: application.email,
            address: application.address,
            city: application.city,
            "operational-pin": application.operationalPin || "",
            "distributor-service-pincodes": (application.servicePincodes || []).join(", "),
        };
        Object.keys(values).forEach(function (id) {
            const input = document.getElementById(id);
            if (input) input.value = values[id] || "";
        });
        document.querySelector(".role-picker").hidden = true;
        document.querySelector(".application-lookup").hidden = false;
        correctionWorkspace.hidden = false;
        document.getElementById("correction-title").textContent = "Update your application";
        document.getElementById("correction-reference").textContent = application.id;
        document.getElementById("correction-reason").textContent =
            application.rejectionReason || "Upload the required documents again, correct your details, and resubmit.";
        document.getElementById("start-new-application").focus();
        form.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    lookupForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        lookupStatus.hidden = true;
        lookupResult.hidden = true;
        const reference = document.getElementById("rejected-reference").value.trim();
        const mobile = document.getElementById("rejected-mobile").value.trim();
        try {
            const result = await apiRequest("/api/applications/lookup?reference=" +
                encodeURIComponent(reference) + "&mobile=" + encodeURIComponent(mobile));
            const application = result.application;
            if (!["rejected", "correction_required"].includes(application.status)) {
                showStatus(lookupStatus, "Only rejected applications can be corrected here.");
                return;
            }
            lookupResult.innerHTML = '<p>Application <strong>' + escapeHTML(application.id) +
                '</strong> was rejected. Reason: ' + escapeHTML(application.rejectionReason || "Please review your details.") +
                '</p><button class="btn primary" type="button" data-resubmit-application>Correct application</button>';
            lookupResult.hidden = false;
            lookupResult.querySelector("[data-resubmit-application]").addEventListener("click", function () {
                openCorrection(application);
            });
        } catch (error) {
            showStatus(lookupStatus, error.message);
        }
    });

    document.getElementById("start-new-application").addEventListener("click", function () {
        editingApplicationId = "";
        form.reset();
        setRole(initialRole);
        document.querySelector(".role-picker").hidden = false;
        correctionWorkspace.hidden = true;
        lookupResult.hidden = true;
        status.hidden = true;
    });

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        status.hidden = true;
        const mobile = document.getElementById("applicant-mobile").value.trim();
        if (!/^\d{10}$/.test(mobile)) {
            showStatus(status, "Enter exactly 10 numeric digits for the mobile number.");
            return;
        }
        if (!editingApplicationId) {
            try {
                const current = await apiRequest("/api/public/application-status?mobile=" + encodeURIComponent(mobile));
                if (current.blocked) {
                    showStatus(status, "This mobile number is blocked from submitting applications.");
                    return;
                }
                if (current.application && ["pending", "approved"].includes(current.application.status)) {
                    showStatus(status, "An application for this mobile is already on file (reference " +
                        current.application.id + "). A duplicate application was not submitted.");
                    return;
                }
                if (current.application && ["rejected", "correction_required"].includes(current.application.status)) {
                    const found = await apiRequest("/api/applications/lookup?reference=" +
                        encodeURIComponent(current.application.id) + "&mobile=" + encodeURIComponent(mobile));
                    openCorrection(found.application);
                    return;
                }
            } catch (error) {
                showStatus(status, error.message);
                return;
            }
        }
        const pins = roleInput.value === "distributor"
            ? distributorPins.value.split(",").map(function (pin) { return pin.trim(); }).filter(Boolean)
            : [];
        if (roleInput.value === "retailer" && !/^\d{6}$/.test(operationalPin.value.trim())) {
            showStatus(status, "Enter a valid six-digit operational PIN code.");
            return;
        }
        if (new Set(pins).size !== pins.length || pins.some(function (pin) { return !/^\d{6}$/.test(pin); })) {
            showStatus(status, "Enter unique six-digit Distributor service PIN codes, separated by commas.");
            return;
        }
        let fieldError;
        try {
            fieldError = await validatePartnerApplication(form, roleInput.value);
        } catch (error) {
            showStatus(status, "The selected documents could not be inspected. Please select them again.");
            return;
        }
        if (fieldError) {
            showStatus(status, fieldError);
            return;
        }
        if (!form.reportValidity()) return;
        const formData = new FormData(form);
        const payload = {
            name: String(formData.get("name")).trim(),
            mobile: mobile,
            business: String(formData.get("business")).trim(),
            email: String(formData.get("email")).trim(),
            address: String(formData.get("address")).trim(),
            city: String(formData.get("city")).trim(),
            role: roleInput.value,
            operationalPin: roleInput.value === "retailer" ? operationalPin.value.trim() : "",
            servicePincodes: pins,
            correctionReference: editingApplicationId,
            idType: String(formData.get("idType") || ""),
            idLast4: String(formData.get("idLast4") || "").trim(),
            jurisdiction: roleInput.value === "distributor" ? String(formData.get("jurisdiction") || "").trim() : "",
            referralCode: roleInput.value === "distributor" ? String(formData.get("referralCode") || "").trim() : "",
            mobileConfirmed: formData.get("mobileConfirmed") === "on",
            privacyAccepted: formData.get("privacyAccepted") === "on",
            website: String(formData.get("website") || ""),
        };
        const documentInputs = Array.from(form.querySelectorAll('input[type="file"]:not(:disabled)'));
        const requestBody = new FormData();
        requestBody.append("application", JSON.stringify(payload));
        requestBody.append("document_fields", JSON.stringify(documentInputs.map(function (input) {
            return input.name;
        })));
        documentInputs.forEach(function (input) {
            requestBody.append("files", input.files[0], input.files[0].name);
        });
        try {
            const result = await apiRequest("/api/applications", { method: "POST", body: requestBody });
            const application = result.application;
            document.getElementById("application-reference").textContent = application.id;
            document.getElementById("application-success-message").textContent = result.assignedDistributor
                ? "Your application was routed to " + result.assignedDistributor.name + " (Distributor ID " +
                    result.assignedDistributor.generatedId + ") for review."
                : application.role === "retailer"
                    ? "No approved Distributor covers PIN code " + application.operationalPin +
                        ". The application was routed to the Master Admin for review."
                    : editingApplicationId
                        ? "Your corrected application was securely submitted for review."
                        : "Your application was securely submitted for review.";
            form.hidden = true;
            document.querySelector(".role-picker").hidden = true;
            document.querySelector(".application-lookup").hidden = true;
            successPanel.hidden = false;
        } catch (error) {
            showStatus(status, error.message);
        }
    });
}

function initializeDocumentScanner() {
    const form = document.getElementById("application-form");
    if (!form) {
        return;
    }

    const documentInputs = document.querySelectorAll(
        '#application-form input[type="file"]'
    );
    const scannerControls = [];

    documentInputs.forEach(function (input) {
        const field = input.closest(".field");
        if (!field) {
            return;
        }

        const controls = document.createElement("div");
        controls.className = "document-scan-controls";

        const scanButton = document.createElement("button");
        scanButton.className = "text-button document-scan-button";
        scanButton.type = "button";
        scanButton.textContent = "Scan image text (optional)";
        scanButton.disabled = true;
        scanButton.setAttribute("aria-describedby", input.id + "-scan-status");

        const scanStatus = document.createElement("p");
        scanStatus.className = "document-scan-status";
        scanStatus.id = input.id + "-scan-status";
        scanStatus.setAttribute("role", "status");
        scanStatus.setAttribute("aria-live", "polite");
        scanStatus.hidden = true;

        controls.append(scanButton, scanStatus);
        field.append(controls);
        scannerControls.push({ button: scanButton, status: scanStatus });

        input.addEventListener("change", function () {
            scanButton.disabled = !input.files || input.files.length !== 1 ||
                !isSupportedScanImage(input.files[0]);
            scanStatus.hidden = true;
            scanStatus.textContent = input.files && input.files.length === 1 &&
                !isSupportedScanImage(input.files[0])
                ? "OCR supports JPEG and PNG images only. PDF documents can still be submitted."
                : "";
            scanStatus.hidden = !scanStatus.textContent;
        });

        scanButton.addEventListener("click", async function () {
            const imageFile = input.files && input.files[0];
            if (!imageFile || !isSupportedScanImage(imageFile)) {
                scanStatus.textContent = "Select a JPEG or PNG image to scan.";
                scanStatus.hidden = false;
                return;
            }
            if (imageFile.size > MAX_SCAN_FILE_SIZE) {
                scanStatus.textContent = "Images must be 8 MB or smaller to scan.";
                scanStatus.hidden = false;
                return;
            }

            scanButton.disabled = true;
            scanStatus.textContent = "Scanning image with the local OCR service…";
            scanStatus.hidden = false;
            const formData = new FormData();
            formData.append("file", imageFile);
            const controller = new AbortController();
            const timeoutId = window.setTimeout(function () {
                controller.abort();
            }, 30000);

            try {
                const response = await fetch(DOCUMENT_SCAN_API_URL, {
                    method: "POST",
                    body: formData,
                    signal: controller.signal
                });
                let result;
                try {
                    result = await response.json();
                } catch (error) {
                    throw new Error("The local OCR service returned an unreadable response.");
                }
                if (!response.ok || result.status !== "success") {
                    throw new Error(result.message || result.detail || "The image could not be scanned.");
                }

                scanStatus.textContent = result.extracted_text
                    ? "Extracted text (not saved): " + result.extracted_text
                    : "No readable text was found. OCR does not verify document authenticity.";
            } catch (error) {
                scanStatus.textContent = error.name === "AbortError"
                    ? "The scan timed out. Try again when the local OCR service is available."
                    : error.message || "Could not connect to the local OCR service. Check that the portal is running and try again.";
            } finally {
                window.clearTimeout(timeoutId);
                scanButton.disabled = !input.files || input.files.length !== 1 ||
                    !isSupportedScanImage(input.files[0]);
            }
        });
    });

    form.addEventListener("reset", function () {
        scannerControls.forEach(function (control) {
            control.button.disabled = true;
            control.status.textContent = "";
            control.status.hidden = true;
        });
    });
}

function isSupportedScanImage(file) {
    return file.type === "image/jpeg" || file.type === "image/png";
}

async function validatePartnerApplication(form, role) {
    const name = document.getElementById("applicant-name").value.trim();
    const business = document.getElementById("business-name").value.trim();
    const address = document.getElementById("address").value.trim();
    const city = document.getElementById("city").value.trim();
    if (name.length < 2 || !/\p{L}/u.test(name) || /\d/.test(name)) {
        return "Enter a valid name using letters; numbers are not accepted in the name field.";
    }
    if (business.length < 2 || !/\p{L}/u.test(business)) {
        return "Enter a valid shop or business name.";
    }
    if (address.length < 5 || !/\p{L}/u.test(address)) {
        return "Enter a complete business address.";
    }
    if (city.length < 2 || !/\p{L}/u.test(city)) {
        return "Enter a valid city or district.";
    }
    const email = document.getElementById("email");
    if (!email.checkValidity()) {
        return "Enter a valid email address.";
    }
    const fileInputs = Array.from(form.querySelectorAll('input[type="file"]:not(:disabled)'));
    let totalDocumentBytes = 0;
    for (const input of fileInputs) {
        if (!input.files || input.files.length !== 1) {
            return "Select every required document before submitting.";
        }
        const file = input.files[0];
        totalDocumentBytes += file.size;
        if (totalDocumentBytes > 40 * 1024 * 1024) {
            return "All selected documents together must be 40 MB or smaller.";
        }
        if (file.size === 0 || file.size > 10 * 1024 * 1024 ||
            !/\.(pdf|jpe?g|png)$/i.test(file.name)) {
            return "Each document must be a non-empty PDF, JPG or PNG file no larger than 10 MB.";
        }
        const extension = file.name.split(".").pop().toLowerCase();
        const signature = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        const isPDF = extension === "pdf" &&
            signature[0] === 0x25 && signature[1] === 0x50 && signature[2] === 0x44 &&
            signature[3] === 0x46 && signature[4] === 0x2d;
        const isJPEG = (extension === "jpg" || extension === "jpeg") &&
            signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
        const isPNG = extension === "png" &&
            signature[0] === 0x89 && signature[1] === 0x50 && signature[2] === 0x4e &&
            signature[3] === 0x47 && signature[4] === 0x0d && signature[5] === 0x0a &&
            signature[6] === 0x1a && signature[7] === 0x0a;
        if (!isPDF && !isJPEG && !isPNG) {
            return "A selected document's file contents do not match its PDF, JPG or PNG file type.";
        }
    }
    if (role !== "retailer" && role !== "distributor") {
        return "Choose a valid partner application type.";
    }
    return "";
}

function initializePortalLogin() {
    const mobileForm = document.getElementById("portal-login-form");
    if (!mobileForm) return;
    const passwordForm = document.getElementById("login-password-form");
    const setupForm = document.getElementById("first-time-setup-form");
    const recoveryForm = document.getElementById("password-recovery-form");
    const staffSetupForm = document.getElementById("staff-setup-form");
    const twoFactorForm = document.getElementById("two-factor-form");
    const retailerActivationForm = document.getElementById("retailer-activation-form");
    const status = document.getElementById("login-status");
    let selectedAccount = null;
    let preAuth = "";
    let twoFactorMode = "";

    function setStatus(message) {
        status.textContent = message;
        status.hidden = false;
    }

    function showOnly(target) {
        [mobileForm, passwordForm, setupForm, recoveryForm, staffSetupForm, twoFactorForm, retailerActivationForm]
            .forEach(function (form) { form.hidden = form !== target; });
        const welcome = document.getElementById("login-welcome");
        if (welcome) { welcome.hidden = true; }
        status.hidden = true;
    }

    function redirectForUser(user) {
        // The name is shown only here, after the password (and 2FA, if required) was verified.
        [mobileForm, passwordForm, setupForm, recoveryForm, staffSetupForm, twoFactorForm, retailerActivationForm]
            .forEach(function (form) { form.hidden = true; });
        status.hidden = true;
        const welcome = document.getElementById("login-welcome");
        if (welcome) {
            document.getElementById("login-welcome-name").textContent = user.name;
            welcome.hidden = false;
        }
        window.setTimeout(function () { navigateForUser(user); }, welcome ? 1200 : 0);
    }

    function navigateForUser(user) {
        if (user.role === "retailer") {
            window.location.assign("retailer.html");
            return;
        }
        sessionStorage.setItem(PENDING_WELCOME_KEY, JSON.stringify({
            name: user.name,
            role: user.role,
        }));
        window.location.assign("admin.html");
    }

    function showMobileStep() {
        selectedAccount = null;
        preAuth = "";
        showOnly(mobileForm);
        document.getElementById("login-mobile").focus();
    }

    async function showTwoFactor(result) {
        preAuth = result.preAuth;
        twoFactorMode = result.twoFactor;
        const enroll = twoFactorMode === "enroll";
        document.getElementById("two-factor-enroll").hidden = !enroll;
        document.getElementById("two-factor-verify-intro").hidden = enroll;
        document.getElementById("two-factor-code").value = "";
        if (enroll) {
            const setup = await apiRequest("/api/auth/2fa/enroll-start", {
                method: "POST", body: { preAuth: preAuth },
            });
            document.getElementById("two-factor-qr").src = setup.qr;
            document.getElementById("two-factor-key").textContent = setup.manualKey;
        }
        showOnly(twoFactorForm);
        document.getElementById("two-factor-code").focus();
    }

    mobileForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        const identifier = document.getElementById("login-mobile").value.trim();
        if (!/^\d{10,15}$/.test(identifier) && !/^[A-Za-z]{2,5}\d{4,}$/.test(identifier) &&
            !/^APP-[A-Za-z0-9]{12}$/i.test(identifier)) {
            setStatus("Enter a valid mobile number, Retail ID or Application ID.");
            return;
        }
        try {
            selectedAccount = await apiRequest("/api/auth/lookup", {
                method: "POST",
                body: { identifier: identifier, name: document.getElementById("login-name").value.trim() },
            });
            const step = selectedAccount.step;
            if (step === "staff_setup") {
                staffSetupForm.reset();
                showOnly(staffSetupForm);
                document.getElementById("staff-setup-password").focus();
            } else if (step === "activate") {
                retailerActivationForm.reset();
                showOnly(retailerActivationForm);
                document.getElementById("retail-activation-mobile").focus();
            } else if (step === "bootstrap" || step === "setup") {
                const isBootstrap = step === "bootstrap";
                document.getElementById("setup-title").textContent = isBootstrap
                    ? "Create owner password" : "Create your password";
                document.getElementById("bootstrap-token-field").hidden = !isBootstrap;
                document.getElementById("bootstrap-token").required = isBootstrap;
                document.getElementById("activation-token-field").hidden = isBootstrap;
                document.getElementById("activation-token").required = !isBootstrap;
                showOnly(setupForm);
                document.getElementById("setup-password").focus();
            } else {
                document.getElementById("login-password").value = "";
                showOnly(passwordForm);
                document.getElementById("login-password").focus();
            }
        } catch (error) {
            setStatus(error.message);
        }
    });

    staffSetupForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!selectedAccount || !staffSetupForm.reportValidity()) return;
        const password = document.getElementById("staff-setup-password").value;
        const recovery = document.getElementById("staff-setup-recovery").value;
        if (validatePassword(password)) {
            setStatus(validatePassword(password));
            return;
        }
        if (password !== document.getElementById("staff-setup-password-confirm").value ||
            recovery !== document.getElementById("staff-setup-recovery-confirm").value) {
            setStatus("The password and recovery phrase confirmations must match.");
            return;
        }
        try {
            await apiRequest("/api/auth/staff-setup", {
                method: "POST",
                body: {
                    name: document.getElementById("login-name").value.trim(),
                    mobile: selectedAccount.identifier,
                    password: password,
                    recovery: recovery,
                },
            });
            showMobileStep();
            document.getElementById("login-name").value = "";
            document.getElementById("login-mobile").value = "";
            setStatus("Setup confirmation submitted. You can sign in once the owner approves your account.");
        } catch (error) {
            setStatus(error.message);
        }
    });

    twoFactorForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!preAuth || !twoFactorForm.reportValidity()) return;
        try {
            const route = twoFactorMode === "enroll" ? "/api/auth/2fa/enroll-verify" : "/api/auth/2fa/verify";
            const result = await apiRequest(route, {
                method: "POST",
                body: { preAuth: preAuth, code: document.getElementById("two-factor-code").value.trim() },
            });
            document.getElementById("two-factor-qr").removeAttribute("src");
            redirectForUser(result.user);
        } catch (error) {
            setStatus(error.message);
            document.getElementById("two-factor-code").value = "";
        }
    });
    document.getElementById("two-factor-cancel").addEventListener("click", function () {
        document.getElementById("two-factor-qr").removeAttribute("src");
        showMobileStep();
    });
    document.getElementById("staff-setup-back").addEventListener("click", showMobileStep);

    setupForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!selectedAccount || !setupForm.reportValidity()) return;
        const password = document.getElementById("setup-password").value;
        const confirm = document.getElementById("setup-password-confirm").value;
        const recovery = document.getElementById("setup-recovery").value;
        if (validatePassword(password)) {
            setStatus(validatePassword(password));
            return;
        }
        if (password !== confirm || recovery.length < 12 ||
            recovery !== document.getElementById("setup-recovery-confirm").value) {
            setStatus("Passwords must match, and the recovery phrase must match and contain at least 12 characters.");
            return;
        }
        const payload = {
            identifier: selectedAccount.identifier,
            name: "",
            password: password,
            recovery: recovery,
            bootstrapToken: document.getElementById("bootstrap-token")?.value || "",
            activationToken: document.getElementById("activation-token")?.value || "",
        };
        try {
            const route = selectedAccount.step === "bootstrap" ? "/api/auth/bootstrap" : "/api/auth/setup";
            const result = await apiRequest(route, { method: "POST", body: payload });
            if (result.twoFactor) {
                await showTwoFactor(result);
                return;
            }
            redirectForUser(result.user);
        } catch (error) {
            setStatus(error.message);
        }
    });

    passwordForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!selectedAccount || !passwordForm.reportValidity()) return;
        const payload = {
            identifier: selectedAccount.identifier,
            password: document.getElementById("login-password").value,
            name: document.getElementById("login-name").value.trim(),
        };
        try {
            const result = await apiRequest("/api/auth/login", { method: "POST", body: payload });
            if (result.twoFactor) {
                await showTwoFactor(result);
                return;
            }
            redirectForUser(result.user);
        } catch (error) {
            setStatus(error.message);
            document.getElementById("login-password").value = "";
            document.getElementById("login-password").focus();
        }
    });

    retailerActivationForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!selectedAccount || !retailerActivationForm.reportValidity()) return;
        const password = document.getElementById("retail-activation-password").value;
        if (validatePassword(password)) {
            setStatus(validatePassword(password));
            return;
        }
        if (password !== document.getElementById("retail-activation-password-confirm").value) {
            setStatus("The passwords do not match.");
            return;
        }
        const recovery = document.getElementById("retail-activation-recovery").value;
        if (recovery.length < 12 ||
            recovery !== document.getElementById("retail-activation-recovery-confirm").value) {
            setStatus("The recovery phrase must match and contain at least 12 characters.");
            return;
        }
        try {
            const result = await apiRequest("/api/retailer/activate", {
                method: "POST",
                body: {
                    identifier: selectedAccount.identifier,
                    name: document.getElementById("retail-activation-mobile").value.trim(),
                    password: password,
                    recovery: recovery,
                    activationToken: document.getElementById("retail-activation-token").value.trim(),
                },
            });
            redirectForUser(result.user);
        } catch (error) {
            setStatus(error.message);
        }
    });

    recoveryForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!recoveryForm.reportValidity()) return;
        const password = document.getElementById("recovery-password").value;
        if (validatePassword(password)) {
            setStatus(validatePassword(password));
            return;
        }
        if (password !== document.getElementById("recovery-password-confirm").value) {
            setStatus("The new passwords do not match.");
            return;
        }
        try {
            await apiRequest("/api/auth/recover", {
                method: "POST",
                body: {
                    identifier: document.getElementById("recovery-mobile").value.trim(),
                    recovery: document.getElementById("recovery-phrase").value,
                    password: password,
                },
            });
            selectedAccount = null;
            showOnly(mobileForm);
            document.getElementById("login-mobile").value = "";
            setStatus("Password updated. Continue with your new password.");
        } catch (error) {
            setStatus(error.message);
        }
    });

    document.getElementById("forgot-password").addEventListener("click", function () {
        document.getElementById("recovery-mobile").value = selectedAccount
            ? selectedAccount.mobile || selectedAccount.identifier
            : document.getElementById("login-mobile").value.trim();
        showOnly(recoveryForm);
        document.getElementById("recovery-phrase").focus();
    });
    document.getElementById("cancel-recovery").addEventListener("click", function () {
        if (!selectedAccount) {
            showOnly(mobileForm);
            return;
        }
        showOnly(passwordForm);
        document.getElementById("login-password").focus();
    });
    document.getElementById("change-number").addEventListener("click", function () {
        selectedAccount = null;
        showOnly(mobileForm);
        document.getElementById("login-mobile").focus();
    });
    document.getElementById("retail-activation-back").addEventListener("click", function () {
        selectedAccount = null;
        showOnly(mobileForm);
        document.getElementById("login-mobile").focus();
    });
}

function setNote(element, message) {
    if (!element) return;
    element.textContent = message;
    element.hidden = false;
}

function ownerStaffCard(item, actions) {
    const labels = {
        whitelisted_pending_setup: "Awaiting staff password setup",
        pending_owner_final_approval: "Pending your final approval",
        ready_for_2fa: "Approved · authenticator not yet linked",
        active: "Active · 2FA enrolled",
        revoked: "Revoked",
    };
    return '<article class="application-card"><div class="application-details"><span class="application-type">' +
        escapeHTML(item.role === "masteradmin" ? "Master Admin" : "Sub-Admin") + ' · ' +
        escapeHTML(labels[item.status] || item.status) + '</span><h3>' + escapeHTML(item.name) + '</h3><p>' +
        escapeHTML(item.mobile) + ' · ' + escapeHTML(item.scope) + '</p></div><div class="approval-actions">' +
        actions.map(function (action) {
            return '<button type="button" class="btn ' + (action[2] || "quiet") + '" data-staff-action="' + action[0] +
                '" data-staff-id="' + escapeHTML(item.id) + '">' + action[1] + '</button>';
        }).join("") + '</div></article>';
}

function initializeOwnerStaffAdmin(user) {
    const isOwner = user.role === "master";
    const canHelpline = isOwner || user.role === "masteradmin";
    const ownerSection = document.getElementById("owner-staff-section");
    const helplineSection = document.getElementById("helpline-section");
    if (helplineSection) helplineSection.hidden = !canHelpline;
    if (ownerSection) ownerSection.hidden = !isOwner;

    if (canHelpline && helplineSection) {
        const status = document.getElementById("helpline-status");
        apiRequest("/api/admin/helpline").then(function (result) {
            document.getElementById("helpline-phone").value = result.phone || "";
        }).catch(function (error) { setNote(status, error.message); });
        document.getElementById("helpline-form").addEventListener("submit", async function (event) {
            event.preventDefault();
            if (!event.currentTarget.reportValidity()) return;
            try {
                const result = await apiRequest("/api/admin/helpline", {
                    method: "PUT", body: { phone: document.getElementById("helpline-phone").value.trim() },
                });
                setNote(status, "Helpline updated to " + result.phone + ". Approved partners will see it immediately.");
            } catch (error) {
                setNote(status, error.message);
            }
        });
    }
    if (!isOwner || !ownerSection) return;

    const status = document.getElementById("owner-staff-status");
    const queue = document.getElementById("owner-staff-queue");
    const list = document.getElementById("owner-staff-list");

    async function refresh() {
        try {
            const items = await apiRequest("/api/owner/staff");
            const pending = items.filter(function (item) { return item.status === "pending_owner_final_approval"; });
            queue.innerHTML = pending.length ? pending.map(function (item) {
                return ownerStaffCard(item, [["approve", "Approve &amp; Unlock 2FA", "primary"], ["reject", "Reject"]]);
            }).join("") : '<p class="empty-state">No staff are waiting for final approval.</p>';
            list.innerHTML = items.length ? items.map(function (item) {
                const actions = [];
                if (item.status === "active" || item.status === "ready_for_2fa") {
                    actions.push(["reset", "Reset 2FA &amp; password"]);
                }
                if (item.status !== "revoked") actions.push(["revoke", "Revoke access", "danger"]);
                return ownerStaffCard(item, actions);
            }).join("") : '<p class="empty-state">No staff have been pre-authorized yet.</p>';
        } catch (error) {
            setNote(status, error.message);
        }
    }

    document.querySelectorAll("#preauth-masteradmin-form, #preauth-subadmin-form").forEach(function (form) {
        form.addEventListener("submit", async function (event) {
            event.preventDefault();
            if (!form.reportValidity()) return;
            const data = new FormData(form);
            try {
                await apiRequest("/api/owner/staff", {
                    method: "POST",
                    body: {
                        role: form.dataset.role, name: String(data.get("name")).trim(),
                        mobile: String(data.get("mobile")).trim(), scope: String(data.get("scope")).trim(),
                    },
                });
                form.reset();
                setNote(status, "Pre-authorized with status whitelisted_pending_setup. The staff member now sets a password from the login page.");
                refresh();
            } catch (error) {
                setNote(status, error.message);
            }
        });
    });
    [queue, list].forEach(function (container) {
        container.addEventListener("click", async function (event) {
            const button = event.target.closest("[data-staff-action]");
            if (!button) return;
            try {
                await apiRequest("/api/owner/staff/" + encodeURIComponent(button.dataset.staffId) + "/action", {
                    method: "POST", body: { action: button.dataset.staffAction },
                });
                setNote(status, "Action completed: " + button.dataset.staffAction + ".");
                refresh();
            } catch (error) {
                setNote(status, error.message);
            }
        });
    });
    refresh();
}

function initializeSupport(user, knownHelpline) {
    const isPartner = user.role === "retailer" || user.role === "distributor";
    const isStaff = user.role === "master" || user.role === "masteradmin" || user.role === "subadmin";
    const status = document.getElementById("ticket-status");

    if (isPartner) {
        const section = document.getElementById("distributor-support-section");
        if (section) section.hidden = false;
        const helplineElement = document.getElementById("partner-helpline");
        if (helplineElement) {
            const show = function (phone) { helplineElement.textContent = phone || "Not available yet"; };
            if (knownHelpline !== undefined) show(knownHelpline);
            else apiRequest("/api/helpline").then(function (result) { show(result.phone); }).catch(function () { show(""); });
        }
        const form = document.getElementById("support-ticket-form");
        const mine = document.getElementById("my-ticket-list");
        const refreshMine = async function () {
            try {
                const tickets = await apiRequest("/api/support/tickets");
                mine.innerHTML = tickets.length ? tickets.map(function (ticket) {
                    return '<article class="application-card"><div class="application-details"><span class="application-type">' +
                        escapeHTML(ticket.category) + ' · ' + escapeHTML(ticket.status) + '</span><h3>' +
                        escapeHTML(ticket.subject) + '</h3><p>' + escapeHTML(ticket.message) + '</p><small>' +
                        escapeHTML(ticket.id) + ' · ' + escapeHTML(formatDate(ticket.createdAt)) + '</small></div></article>';
                }).join("") : '<p class="empty-state">You have not submitted any tickets.</p>';
            } catch (error) {
                setNote(status, error.message);
            }
        };
        if (form) {
            form.addEventListener("submit", async function (event) {
                event.preventDefault();
                if (!form.reportValidity()) return;
                const data = new FormData(form);
                try {
                    await apiRequest("/api/support/tickets", {
                        method: "POST",
                        body: {
                            category: String(data.get("category")), subject: String(data.get("subject")).trim(),
                            message: String(data.get("message")).trim(),
                        },
                    });
                    form.reset();
                    setNote(status, "Your ticket was submitted. The support team will respond.");
                    refreshMine();
                } catch (error) {
                    setNote(status, error.message);
                }
            });
            refreshMine();
        }
    }

    if (isStaff) {
        const section = document.getElementById("support-tickets-section");
        const container = document.getElementById("support-ticket-list");
        if (!section || !container) return;
        section.hidden = false;
        const refreshAll = async function () {
            try {
                const tickets = await apiRequest("/api/support/tickets");
                container.innerHTML = tickets.length ? tickets.map(function (ticket) {
                    return '<article class="application-card"><div class="application-details"><span class="application-type">' +
                        escapeHTML(ticket.category) + ' · ' + escapeHTML(ticket.status) + ' · ' + escapeHTML(ticket.role) +
                        '</span><h3>' + escapeHTML(ticket.subject) + '</h3><p>' + escapeHTML(ticket.message) + '</p><small>' +
                        escapeHTML(ticket.name) + ' · ' + escapeHTML(ticket.mobile) + ' · ' + escapeHTML(ticket.id) +
                        '</small></div>' + (ticket.status === "open"
                            ? '<div class="approval-actions"><button type="button" class="btn quiet" data-close-ticket="' +
                                escapeHTML(ticket.id) + '">Close ticket</button></div>' : "") + '</article>';
                }).join("") : '<p class="empty-state">No support tickets.</p>';
            } catch (error) {
                container.innerHTML = '<p class="empty-state">' + escapeHTML(error.message) + '</p>';
            }
        };
        container.addEventListener("click", async function (event) {
            const button = event.target.closest("[data-close-ticket]");
            if (!button) return;
            try {
                await apiRequest("/api/support/tickets/" + encodeURIComponent(button.dataset.closeTicket) + "/close",
                    { method: "POST", body: {} });
                refreshAll();
            } catch (error) {
                container.insertAdjacentHTML("afterbegin", '<p class="empty-state">' + escapeHTML(error.message) + '</p>');
            }
        });
        refreshAll();
    }
}

function playWelcomeVoice(userName, role) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
        return;
    }
    const greeting = role === "master"
        ? "Welcome to your Super Admin Panel, " + userName + "."
        : role === "masteradmin"
            ? "Welcome Master Admin, " + userName + "."
            : role === "distributor"
            ? "Welcome to your Distributor workspace, " + userName + "."
            : "Welcome Sub-Admin, " + userName + ".";
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(greeting);
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
}

function initializeOperationsDashboard() {
    const applicationList = document.getElementById("application-list");
    if (!applicationList) {
        return;
    }

    const accessDenied = document.getElementById("dashboard-access-denied");
    const operationsContent = document.getElementById("operations-content");
    const staff = PORTAL_USER;
    const isDistributorMode = Boolean(staff && staff.role === "distributor");
    const distributorProfile = isDistributorMode
        ? readList("rm-demo-distributor-profile")[0] : null;
    const isMaster = Boolean(staff && staff.role === "master");
    const operator = distributorProfile || staff;
    if (!staff || !["master", "masteradmin", "subadmin", "distributor"].includes(staff.role) ||
        (isDistributorMode && !distributorProfile)) {
        accessDenied.hidden = false;
        return;
    }

    operationsContent.hidden = false;
    initializePartnerNetwork(staff);
    if (!isDistributorMode) {
        const pendingWelcome = sessionStorage.getItem(PENDING_WELCOME_KEY);
        if (pendingWelcome) {
            sessionStorage.removeItem(PENDING_WELCOME_KEY);
            try {
                const welcome = JSON.parse(pendingWelcome);
                if (welcome.role === staff.role && welcome.name === staff.name) {
                    playWelcomeVoice(welcome.name, welcome.role);
                }
            } catch (error) {
                console.warn("The pending welcome message could not be read:", error);
            }
        }
    }
    document.getElementById("operator-caption").textContent = operator.name + " · " +
        (isDistributorMode ? "Distributor workspace · " + operator.generatedId
            : isMaster ? "Super Admin (Owner) — ultimate control"
                : staff.role === "masteradmin" ? "Master Admin"
                    : "Sub-Admin — locked mobile ending " + operator.mobile.slice(-4));
    if (isDistributorMode) {
        document.querySelector(".dashboard-heading .eyebrow").textContent = "DISTRIBUTOR WORKSPACE";
        document.querySelector(".dashboard-heading h1").textContent = "Local Retailer application queue";
        document.querySelector(".dashboard-heading > div > p:not(.eyebrow)").textContent =
            "Review applications routed to your approved PIN code territory.";
        document.querySelector("#applications-title").textContent = "Retailer applications for your territory";
        document.querySelector("#applications-title").closest(".section-heading")
            .querySelector(".section-desc").textContent =
            "Only Retailer applications assigned to Distributor ID " + operator.generatedId +
            " are shown in this queue.";
        document.querySelector("#applications-title").closest(".section-heading")
            .querySelector(".eyebrow").textContent = "ASSIGNED TERRITORY QUEUE";
        document.querySelector("#sensitive-section").hidden = true;
        document.querySelector(".operator-controls").hidden = true;
        document.querySelector(".dashboard-stats .stat-card:nth-child(2)").hidden = true;
    }
    document.querySelectorAll(".master-only").forEach(function (section) {
        section.hidden = !isMaster;
    });
    initializeOwnerStaffAdmin(staff);
    initializeSupport(staff);

    const dashboardStatus = document.getElementById("dashboard-status");
    let pendingApproval = null;

    function setDashboardStatus(message) {
        dashboardStatus.textContent = message;
        dashboardStatus.hidden = false;
    }

    async function renderCustomerDocuments() {
        if (!isMaster) {
            return;
        }
        const container = document.getElementById("customer-document-list");
        const status = document.getElementById("customer-document-status");
        container.innerHTML = '<p class="empty-state">Loading customer applications and documents…</p>';
        status.hidden = true;
        try {
            const records = await apiRequest("/api/admin/documents");
            if (!ensureCurrentOperatorAccess()) return;
            container.innerHTML = records.length ? records.map(function (application) {
                const recordLabel = application.formType ||
                    (application.role === "distributor" ? "Distributor application" : "Retailer application");
                const referenceLabel = application.recordType === "transaction"
                    ? "Transaction " + (application.business || application.id)
                    : "Reference " + application.id;
                const files = Array.isArray(application.documents) ? application.documents : [];
                const fileList = files.length ? files.map(function (file) {
                    return '<li><span><strong>' + escapeHTML(file.label) + '</strong> · ' +
                        escapeHTML(file.fileName) +
                        (file.revision ? ' · revision ' + escapeHTML(file.revision) : '') +
                        ' · ' + formatFileSize(file.size) + '</span><a class="btn quiet" href="' +
                        escapeHTML(file.downloadUrl) + '" target="_blank" rel="noopener">View / Download Document</a></li>';
                }).join("") : '<li>No uploaded documents are available for this submission.</li>';
                return '<article class="application-card customer-document-card"><div class="application-details">' +
                    '<span class="application-type">' + escapeHTML(recordLabel) + ' · ' +
                    escapeHTML(application.status) + '</span><h3>' + escapeHTML(application.name) + '</h3>' +
                    '<p>' + escapeHTML(application.mobile) + ' · ' + escapeHTML(application.email || "No email") +
                    '</p><p>' + escapeHTML(application.business || "") + '</p>' +
                    '<small>' + escapeHTML(referenceLabel) + ' · Submitted ' +
                    escapeHTML(formatDateTime(application.submittedAt)) + '</small>' +
                    '<ul class="customer-document-list">' + fileList + '</ul></div></article>';
            }).join("") : '<p class="empty-state">No customer applications have been submitted.</p>';
        } catch (error) {
            status.textContent = error.message || "Customer applications could not be loaded.";
            status.hidden = false;
            container.innerHTML = "";
        }
    }

    document.addEventListener("click", async function (event) {
        const button = event.target.closest("[data-issue-setup-code]");
        if (!button || !isMaster) return;
        button.disabled = true;
        try {
            const result = await apiRequest(
                "/api/admin/accounts/" + encodeURIComponent(button.dataset.issueSetupCode) + "/setup-code",
                { method: "POST", body: {} }
            );
            setDashboardStatus("One-time setup code for " + result.identifier + " (" + result.mobile +
                "): " + result.code + ". Share it only through a separately verified channel; it expires in 7 days.");
        } catch (error) {
            setDashboardStatus(error.message);
        } finally {
            button.disabled = false;
        }
    });

    function ensureCurrentOperatorAccess() {
        if (!PORTAL_USER) {
            operationsContent.hidden = true;
            accessDenied.hidden = false;
            return false;
        }
        return true;
    }

    function renderApplications() {
        const applications = readList(APPLICATIONS_KEY);
        const blockedMobiles = readList(BLOCKED_PARTNER_MOBILES_KEY).map(function (item) {
            return item.mobile;
        });
        const visible = isDistributorMode
            ? applications.filter(function (application) {
                return application.assignedDistributorApplicationId === distributorProfile.id;
            })
            : applications.filter(function (application) {
                return application.role !== "retailer" ||
                    (!application.assignedDistributorApplicationId &&
                        (isMaster || application.assignedMasterAdmin !== true));
            });
        const notificationStatus = document.getElementById("distributor-notification-status");
        if (isDistributorMode) {
            const queuedNotifications = readList(DISTRIBUTOR_NOTIFICATIONS_KEY).filter(function (item) {
                return item.distributorApplicationId === distributorProfile.id &&
                    item.status === "queued";
            });
            notificationStatus.textContent = queuedNotifications.length
                ? queuedNotifications.length + " new application notification" +
                    (queuedNotifications.length === 1 ? "" : "s") + " for Distributor ID " +
                    distributorProfile.generatedId + " (" + distributorProfile.mobile +
                    "). Sign in to review the assigned queue."
                : "No new application notifications.";
            notificationStatus.hidden = false;
        } else {
            notificationStatus.hidden = true;
        }
        document.getElementById("pending-count").textContent = String(visible.filter(function (application) {
            return application.status === "pending";
        }).length);
        if (visible.length === 0) {
            applicationList.innerHTML = '<p class="empty-state">' +
                (isDistributorMode
                    ? "No Retailer applications have been routed to your PIN code territory yet."
                    : "No applications are waiting for review. New submissions will appear here.") +
                '</p>';
            return;
        }
        applicationList.innerHTML = visible.map(function (application) {
            const roleName = application.role === "distributor" ? "Distributor" : "Retailer";
            const documentList = Array.isArray(application.documents) ? application.documents : [];
            const documentSummary = isMaster && documentList.length
                ? '<p class="document-summary"><strong>Documents:</strong> ' +
                    documentList.length + ' attached; see Customer Documents / Applications below.</p>'
                : "";
            const rejected = application.status === "rejected";
            const pending = application.status === "pending";
            const blocked = application.status === "blocked" || blockedMobiles.includes(application.mobile);
            const statusLabel = blocked ? "Permanently blocked" :
                rejected ? "Rejected · correction allowed" :
                    pending ? "Pending review" : "Approved";
            const servicePinSummary = Array.isArray(application.servicePincodes)
                ? application.servicePincodes.join(", ")
                : "";
            const decision = rejected
                ? '<p class="rejection-reason"><strong>Rejection reason:</strong> ' +
                    escapeHTML(application.rejectionReason || "No reason recorded") + '</p>' +
                    '<a class="text-link" href="register.html?application=' + encodeURIComponent(application.id) +
                    '">Applicant correction page</a>'
                : pending ? '<form class="approval-form" data-application-id="' + escapeHTML(application.id) + '">' +
                    '<label for="generated-' + escapeHTML(application.id) + '">Generated ' + roleName + ' ID</label>' +
                    '<input id="generated-' + escapeHTML(application.id) + '" name="generatedId" autocomplete="off" placeholder="Enter ID from company portal" required>' +
                    '<button class="btn primary" type="submit">Approve application</button></form>' +
                    '<form class="reject-form" data-application-id="' + escapeHTML(application.id) + '">' +
                    '<label for="reason-' + escapeHTML(application.id) + '">Reason for rejection</label>' +
                    '<textarea id="reason-' + escapeHTML(application.id) + '" name="reason" maxlength="500" placeholder="Explain what needs correction" required></textarea>' +
                    '<button class="btn quiet" type="submit">Reject &amp; Allow Correction</button></form>'
                : '<p class="application-final-status">' + (blocked
                    ? "This mobile is blocked and cannot submit new applications."
                    : "Approved " + (application.generatedId ? "with ID " + escapeHTML(application.generatedId) : "")) + '</p>';
            const applicationActions = isDistributorMode ? "" :
                '<div class="application-queue-actions">' +
                    (blocked ? '<span class="status-pill pending">Number blocked</span>'
                        : '<button type="button" class="btn danger" data-application-action="block" data-application-id="' +
                            escapeHTML(application.id) + '">Block number</button>') +
                    (isMaster ? '<button type="button" class="btn quiet" data-application-action="delete" data-application-id="' +
                        escapeHTML(application.id) + '">Delete record</button>' : "") + '</div>';
            return '<article class="application-card">' +
                '<div class="application-details"><span class="application-type">' + roleName + ' · ' + statusLabel + '</span>' +
                '<h3>' + escapeHTML(application.name) + '</h3>' +
                '<p>' + escapeHTML(application.business) + ' · ' + escapeHTML(application.city || "") +
                (application.operationalPin ? ' · PIN ' + escapeHTML(application.operationalPin) : "") + '</p>' +
                (servicePinSummary
                    ? '<p>Distributor service PINs: ' + escapeHTML(servicePinSummary) + '</p>'
                    : "") +
                (application.assignedMasterAdmin
                    ? '<p class="master-fallback-label">Master Admin review · no approved Distributor covers this PIN</p>'
                    : "") +
                '<p class="application-contact">' + escapeHTML(application.mobile || "") + ' · ' + escapeHTML(application.email || "") + '</p>' +
                '<small>Reference ' + escapeHTML(application.id) + ' · Submitted ' + formatDate(application.submittedAt) +
                ' · Revision ' + escapeHTML(application.revision || 1) + '</small>' +
                documentSummary +
                (isMaster && application.status === "approved"
                    ? '<button class="btn quiet" type="button" data-issue-setup-code="' +
                        escapeHTML(application.generatedId || application.mobile) + '">Issue / reissue setup code</button>'
                    : "") +
                (rejected ? decision : "") + '</div>' + '<div class="application-decisions">' +
                    (pending && !blocked ? decision : pending
                        ? '<p class="application-final-status">This number is blocked; no approval is available.</p>'
                        : !rejected ? decision : "") + applicationActions + '</div></article>';
        }).join("");
    }

    function renderDistributorMappings() {
        if (!isMaster) {
            return;
        }
        const container = document.getElementById("distributor-mapping-list");
        const distributors = readList(APPLICATIONS_KEY).filter(function (application) {
            return application.role === "distributor" && application.status === "approved" &&
                application.generatedId;
        });
        const mappings = readList(DISTRIBUTOR_PIN_MAPPINGS_KEY);
        if (distributors.length === 0) {
            container.innerHTML = '<p class="empty-state">Approve a Distributor application and assign its official Distributor ID before mapping service PIN codes.</p>';
            return;
        }
        container.innerHTML = distributors.map(function (distributor) {
            const mapping = mappings.find(function (item) {
                return item.distributorApplicationId === distributor.id;
            });
            const queueUrl = new URL("login.html", window.location.href).toString();
            return '<article class="application-card distributor-mapping-card">' +
                '<div class="application-details"><span class="application-type">Approved Distributor</span>' +
                '<h3>' + escapeHTML(distributor.name) + '</h3><p>' + escapeHTML(distributor.business || "") +
                ' · ID <strong>' + escapeHTML(distributor.generatedId) + '</strong></p>' +
                '<p class="application-contact">' + escapeHTML(distributor.mobile) + '</p>' +
                '<button class="btn quiet" type="button" data-issue-setup-code="' +
                    escapeHTML(distributor.generatedId || distributor.mobile) + '">Issue / reissue setup code</button></div>' +
                '<form class="distributor-mapping-form" data-distributor-application-id="' + escapeHTML(distributor.id) + '">' +
                '<div class="field"><label for="pins-' + escapeHTML(distributor.id) + '">Service PIN codes</label>' +
                '<input id="pins-' + escapeHTML(distributor.id) + '" name="pins" value="' +
                    escapeHTML(Array.isArray(distributor.servicePincodes) && distributor.servicePincodes.length
                        ? distributor.servicePincodes.join(", ")
                        : mapping && Array.isArray(mapping.pins) ? mapping.pins.join(", ") : "") +
                '" maxlength="1000" placeholder="e.g. 110001, 110002" aria-describedby="pin-help-' +
                escapeHTML(distributor.id) + '"><small id="pin-help-' + escapeHTML(distributor.id) +
                '" class="field-hint">Enter comma-separated, unique 6-digit PIN codes. Leave blank to remove this mapping.</small></div>' +
                '<div class="field"><label for="region-' + escapeHTML(distributor.id) + '">Regional area (optional)</label>' +
                '<input id="region-' + escapeHTML(distributor.id) + '" name="region" value="' +
                escapeHTML(mapping && mapping.region || "") + '" maxlength="120" placeholder="City / district / region"></div>' +
                '<button class="btn primary" type="submit">Save PIN mapping</button>' +
                '<p class="distributor-queue-link"><strong>Distributor access</strong><br><a class="text-link" href="' +
                    escapeHTML(queueUrl) + '">Sign in to the Distributor portal</a></p>' +
                '</form></article>';
        }).join("");
    }

    function renderRetailerProfiles() {
        if (!isMaster) {
            return;
        }
        const profiles = readList(RETAIL_PROFILES_KEY);
        const container = document.getElementById("retailer-profile-list");
        container.innerHTML = profiles.length ? profiles.map(function (profile) {
            return '<article class="approval-card"><div><span class="status-pill ' +
                (profile.isPasswordSet ? "complete" : "pending") + '">' +
                (profile.isPasswordSet ? "Activated" : "First login pending") +
                '</span><p><strong>' + escapeHTML(profile.userId) + '</strong> · ' +
                escapeHTML(profile.name) + '</p><small>' + escapeHTML(profile.mobile) +
                ' · ' + escapeHTML(profile.email) + '</small>' +
                (!profile.isPasswordSet ? '<p><button class="btn quiet" type="button" data-issue-setup-code="' +
                    escapeHTML(profile.userId) + '">Issue / reissue setup code</button></p>' : "") +
                '</div></article>';
        }).join("") : '<p class="empty-state">No pre-created Retailer profiles have been added yet.</p>';
    }

    function renderUplineRequests() {
        if (!isMaster) {
            return;
        }
        const requests = readList(UPLINE_REQUESTS_KEY);
        const container = document.getElementById("upline-request-list");
        container.innerHTML = requests.length ? requests.map(function (request) {
            const pending = request.status === "pending";
            return '<article class="approval-card"><div><span class="status-pill ' +
                (pending ? "pending" : "complete") + '">' +
                (pending ? "Awaiting review" : "Reviewed") +
                '</span><p><strong>' + escapeHTML(request.userId) + '</strong> · ' +
                escapeHTML(request.name) + '</p><small>' + escapeHTML(request.mobile) +
                ' · Requested ' + formatDate(request.requestedAt) + '</small></div>' +
                (pending ? '<button class="btn quiet" type="button" data-upline-action="review" data-upline-id="' +
                    escapeHTML(request.id) + '">Mark reviewed</button>' : "") + '</article>';
        }).join("") : '<p class="empty-state">No Upline change requests.</p>';
    }

    function renderCriticalRequests() {
        const container = document.getElementById("approval-list");
        if (!isMaster) {
            document.getElementById("approval-count").textContent = "—";
            container.innerHTML = '<p class="empty-state">Critical-change requests are routed to the Master Admin for review.</p>';
            return;
        }
        const approvals = readList(MASTER_APPROVALS_KEY);
        const pending = approvals.filter(function (approval) {
            return approval.status === "pending";
        });
        document.getElementById("approval-count").textContent = String(pending.length);
        if (approvals.length === 0) {
            container.innerHTML = '<p class="empty-state">No Master Admin approval requests.</p>';
            return;
        }
        container.innerHTML = approvals.map(function (approval) {
            const waiting = approval.status === "pending";
            const label = waiting ? "Awaiting Master approval" : approval.status === "approved" ? "Approved" : "Rejected";
            const actions = waiting
                ? '<div class="approval-actions"><button type="button" class="btn primary" data-critical-action="approved" data-approval-id="' + escapeHTML(approval.id) + '">Approve request</button><button type="button" class="btn quiet" data-critical-action="rejected" data-approval-id="' + escapeHTML(approval.id) + '">Reject</button></div>'
                : "";
            return '<article class="approval-card"><div><span class="status-pill ' + (waiting ? "pending" : "complete") + '">' + label + '</span>' +
                '<p>' + escapeHTML(approval.description) + '</p><small>Requested by ' + escapeHTML(approval.operator) + ' · ' + formatDate(approval.requestedAt) + '</small></div>' + actions + '</article>';
        }).join("");
    }

    function finishApplicationApproval(applicationId, generatedId) {
        const applications = readList(APPLICATIONS_KEY);
        const application = applications.find(function (item) {
            return item.id === applicationId && item.status === "pending";
        });
        if (!application) {
            pendingApproval = null;
            document.getElementById("approval-password-panel").hidden = true;
            setDashboardStatus("This application is no longer pending. The queue has been refreshed.");
            renderApplications();
            return;
        }
        let distributorMapping = null;
        let distributorMappings = readList(DISTRIBUTOR_PIN_MAPPINGS_KEY);
        if (application.role === "distributor" &&
            Array.isArray(application.servicePincodes) && application.servicePincodes.length) {
            const pins = application.servicePincodes;
            const overlappingProfile = applications.find(function (item) {
                return item.id !== application.id && item.role === "distributor" &&
                    item.status === "approved" && Array.isArray(item.servicePincodes) &&
                    item.servicePincodes.some(function (pin) { return pins.includes(pin); });
            });
            const overlappingMapping = distributorMappings.find(function (item) {
                return item.distributorApplicationId !== application.id &&
                    Array.isArray(item.pins) && item.pins.some(function (pin) { return pins.includes(pin); });
            });
            if (overlappingProfile || overlappingMapping) {
                setDashboardStatus("Approval blocked: one or more service PIN codes are already assigned to another approved Distributor. Resolve the overlap before approving.");
                document.getElementById("approval-password-panel").hidden = true;
                pendingApproval = null;
                return;
            }
            distributorMapping = distributorMappings.find(function (item) {
                return item.distributorApplicationId === application.id;
            }) || { distributorApplicationId: application.id, createdAt: new Date().toISOString() };
            distributorMapping.distributorId = generatedId;
            distributorMapping.distributorMobile = application.mobile;
            distributorMapping.distributorName = application.name;
            distributorMapping.pins = pins;
            distributorMapping.updatedAt = new Date().toISOString();
            if (!distributorMappings.includes(distributorMapping)) {
                distributorMappings.push(distributorMapping);
            }
        }
        application.status = "approved";
        application.generatedId = generatedId;
        application.approvedBy = operator.name;
        application.approvedAt = new Date().toISOString();
        if (application.role === "retailer" && application.assignedDistributorApplicationId) {
            application.distributorQueueStatus = "approved";
            application.distributorReviewedAt = application.approvedAt;
        }
        writeList(APPLICATIONS_KEY, applications);
        if (distributorMapping) {
            writeList(DISTRIBUTOR_PIN_MAPPINGS_KEY, distributorMappings);
        }
        updateDistributorNotifications(applicationId, "approved");
        renderApplications();
        renderCustomerDocuments();
        renderDistributorMappings();
        document.getElementById("approval-password-panel").hidden = true;
        pendingApproval = null;
        setDashboardStatus("Application approved. The " + (application.role === "distributor" ? "Distributor" : "Retailer") +
            " ID is " + generatedId + ". The partner can complete first-time setup and sign in to the authenticated portal." +
            (distributorMapping ? " Service PINs are active and the Distributor account can review its routed queue." : ""));
    }

    function finishApplicationRejection(applicationId, reason) {
        const applications = readList(APPLICATIONS_KEY);
        const application = applications.find(function (item) {
            return item.id === applicationId && item.status === "pending";
        });
        if (!application) {
            pendingApproval = null;
            document.getElementById("approval-password-panel").hidden = true;
            setDashboardStatus("This application is no longer pending. The queue has been refreshed.");
            renderApplications();
            renderCustomerDocuments();
            return;
        }
        application.status = "rejected";
        application.rejectionReason = reason;
        application.rejectedBy = operator.name;
        application.rejectedAt = new Date().toISOString();
        if (application.role === "retailer" && application.assignedDistributorApplicationId) {
            application.distributorQueueStatus = "rejected";
            application.distributorReviewedAt = application.rejectedAt;
        }
        writeList(APPLICATIONS_KEY, applications);
        updateDistributorNotifications(applicationId, "rejected");
        renderApplications();
        document.getElementById("approval-password-panel").hidden = true;
        pendingApproval = null;
        setDashboardStatus("Application rejected. The applicant can use reference " + application.id +
            " and their registered mobile number to review the reason, edit details and re-upload documents.");
    }

    function finishApplicationQueueAction(action, applicationId) {
        const applications = readList(APPLICATIONS_KEY);
        const application = applications.find(function (item) {
            return item.id === applicationId;
        });
        if (!application) {
            setDashboardStatus("This application record no longer exists.");
            renderApplications();
            return;
        }
        if (action === "delete") {
            writeList(APPLICATIONS_KEY, applications.filter(function (item) {
                return item.id !== applicationId;
            }));
            setDashboardStatus("Application record " + applicationId + " deleted.");
        } else if (action === "block") {
            const blockedMobiles = readList(BLOCKED_PARTNER_MOBILES_KEY);
            if (!blockedMobiles.some(function (item) { return item.mobile === application.mobile; })) {
                blockedMobiles.unshift({
                    mobile: application.mobile,
                    blockedAt: new Date().toISOString(),
                    blockedBy: operator.name,
                    sourceApplication: applicationId
                });
                writeList(BLOCKED_PARTNER_MOBILES_KEY, blockedMobiles);
            }
            applications.forEach(function (item) {
                if (item.mobile === application.mobile) {
                    item.status = "blocked";
                    item.blockedAt = new Date().toISOString();
                    item.blockedBy = operator.name;
                }
            });
            writeList(APPLICATIONS_KEY, applications);
            setDashboardStatus("Mobile number " + application.mobile + " permanently blocked from submitting or resubmitting applications.");
        }
        renderApplications();
        document.getElementById("approval-password-panel").hidden = true;
        pendingApproval = null;
    }

    function updateDistributorNotifications(applicationId, status) {
        if (!isMaster && !isDistributorMode) {
            return;
        }
        const notifications = readList(DISTRIBUTOR_NOTIFICATIONS_KEY);
        notifications.forEach(function (notification) {
            if (notification.applicationId === applicationId) {
                notification.status = status;
                notification.updatedAt = new Date().toISOString();
            }
        });
        writeList(DISTRIBUTOR_NOTIFICATIONS_KEY, notifications);
    }

    applicationList.addEventListener("click", function (event) {
        const button = event.target.closest("[data-application-action]");
        if (!button || !ensureCurrentOperatorAccess()) {
            return;
        }
        const action = button.dataset.applicationAction;
        if (action !== "block" && action !== "delete") {
            return;
        }
        const applicationId = button.dataset.applicationId;
        if (isMaster) {
            finishApplicationQueueAction(action, applicationId);
            return;
        }
        pendingApproval = { action: action, applicationId: applicationId };
        document.getElementById("approval-password-destination").textContent =
            "Confirm your password to " + (action === "block"
                ? "permanently block this applicant's mobile number"
                : "delete this application record") +
            " as the signed-in operator (" + operator.mobile.slice(-4) + ").";
        document.getElementById("confirm-application-action").textContent =
            action === "block" ? "Confirm permanent block" : "Confirm deletion";
        document.getElementById("approval-password").value = "";
        document.getElementById("approval-password-panel").hidden = false;
        document.getElementById("approval-password").focus();
        document.getElementById("approval-password-panel").scrollIntoView({ behavior: "smooth", block: "center" });
    });

    applicationList.addEventListener("submit", function (event) {
        const form = event.target.closest(".approval-form, .reject-form");
        if (!form) {
            return;
        }
        event.preventDefault();
        if (!ensureCurrentOperatorAccess()) {
            return;
        }
        if (!form.reportValidity()) {
            return;
        }
        const rejection = form.matches(".reject-form");
        const formData = new FormData(form);
        const generatedId = rejection ? "" : String(formData.get("generatedId")).trim();
        const reason = rejection ? String(formData.get("reason")).trim() : "";
        if (rejection ? !reason : !generatedId) return;
        if (isMaster) {
            if (rejection) {
                finishApplicationRejection(form.dataset.applicationId, reason);
            } else {
                finishApplicationApproval(form.dataset.applicationId, generatedId);
            }
            return;
        }
        if (isDistributorMode) {
            if (rejection) {
                finishApplicationRejection(form.dataset.applicationId, reason);
            } else {
                finishApplicationApproval(form.dataset.applicationId, generatedId);
            }
            return;
        }
        pendingApproval = {
            applicationId: form.dataset.applicationId,
            generatedId: generatedId,
            action: rejection ? "reject" : "approve",
            reason: reason
        };
        document.getElementById("approval-password-destination").textContent =
            "Confirm your password to " + (rejection ? "reject this application and allow correction" : "approve this application") +
            " as the signed-in operator (" + operator.mobile.slice(-4) + ").";
        document.getElementById("confirm-application-action").textContent =
            rejection ? "Confirm rejection" : "Confirm & approve";
        document.getElementById("approval-password").value = "";
        document.getElementById("approval-password-panel").hidden = false;
        document.getElementById("approval-password").focus();
        document.getElementById("approval-password-panel").scrollIntoView({ behavior: "smooth", block: "center" });
        dashboardStatus.hidden = true;
    });

    document.getElementById("approval-password-form").addEventListener("submit", async function (event) {
        event.preventDefault();
        const form = event.currentTarget;
        if (!ensureCurrentOperatorAccess() || !pendingApproval || !form.reportValidity()) {
            return;
        }
        try {
            await apiRequest("/api/auth/verify-password", {
                method: "POST",
                body: {
                    identifier: PORTAL_USER.mobile,
                    password: document.getElementById("approval-password").value,
                },
            });
            if (pendingApproval.action === "reject") {
                finishApplicationRejection(pendingApproval.applicationId, pendingApproval.reason);
            } else if (pendingApproval.action === "approve") {
                finishApplicationApproval(pendingApproval.applicationId, pendingApproval.generatedId);
            } else {
                finishApplicationQueueAction(pendingApproval.action, pendingApproval.applicationId);
            }
        } catch (error) {
            setDashboardStatus(error.message);
        }
    });

    document.getElementById("cancel-approval-password").addEventListener("click", function () {
        pendingApproval = null;
        document.getElementById("approval-password-panel").hidden = true;
        document.getElementById("confirm-application-action").textContent = "Confirm action";
    });

    document.getElementById("distributor-mapping-list").addEventListener("submit", function (event) {
        const form = event.target.closest(".distributor-mapping-form");
        if (!form || !isMaster || !ensureCurrentOperatorAccess()) {
            return;
        }
        event.preventDefault();
        const distributorApplicationId = form.dataset.distributorApplicationId;
        const profile = readList(APPLICATIONS_KEY).find(function (item) {
            return item.id === distributorApplicationId && item.role === "distributor" &&
                item.status === "approved" && item.generatedId;
        });
        const status = document.getElementById("distributor-mapping-status");
        if (!profile) {
            status.textContent = "This Distributor is no longer approved. Refresh the page and review their status.";
            status.hidden = false;
            renderDistributorMappings();
            return;
        }
        const formData = new FormData(form);
        const pins = String(formData.get("pins") || "").split(",").map(function (pin) {
            return pin.trim();
        }).filter(Boolean);
        const region = String(formData.get("region") || "").trim();
        if (pins.some(function (pin) { return !/^\d{6}$/.test(pin); }) ||
            new Set(pins).size !== pins.length) {
            status.textContent = "Enter unique 6-digit PIN codes, separated by commas.";
            status.hidden = false;
            return;
        }
        const mappings = readList(DISTRIBUTOR_PIN_MAPPINGS_KEY);
        const duplicateOwner = mappings.find(function (mapping) {
            return mapping.distributorApplicationId !== profile.id &&
                Array.isArray(mapping.pins) && mapping.pins.some(function (pin) {
                    return pins.includes(pin);
                });
        }) || readList(APPLICATIONS_KEY).find(function (application) {
            return application.id !== profile.id && application.role === "distributor" &&
                application.status === "approved" && Array.isArray(application.servicePincodes) &&
                application.servicePincodes.some(function (pin) { return pins.includes(pin); });
        });
        if (duplicateOwner) {
            status.textContent = "One or more PIN codes are already assigned to another Distributor. Each PIN must have only one owner.";
            status.hidden = false;
            return;
        }
        let mapping = mappings.find(function (item) {
            return item.distributorApplicationId === profile.id;
        });
        if (!mapping) {
            mapping = { distributorApplicationId: profile.id, createdAt: new Date().toISOString() };
            mappings.push(mapping);
        }
        mapping.distributorId = profile.generatedId;
        mapping.distributorMobile = profile.mobile;
        mapping.distributorName = profile.name;
        mapping.pins = pins;
        mapping.region = region;
        mapping.updatedAt = new Date().toISOString();
        const applications = readList(APPLICATIONS_KEY);
        const currentProfile = applications.find(function (application) {
            return application.id === profile.id;
        });
        currentProfile.servicePincodes = pins;
        writeList(APPLICATIONS_KEY, applications);
        writeList(DISTRIBUTOR_PIN_MAPPINGS_KEY, mappings);
        status.textContent = pins.length
            ? "PIN mapping saved. Matching Retailer applications will be routed to " + profile.name + "'s Distributor queue."
            : "PIN coverage removed. Existing routed applications remain available in this Distributor queue.";
        status.hidden = false;
        renderDistributorMappings();
    });

    document.getElementById("retailer-profile-form").addEventListener("submit", function (event) {
        event.preventDefault();
        const form = event.currentTarget;
        const status = document.getElementById("retailer-profile-status");
        if (!isMaster || !ensureCurrentOperatorAccess() || !form.reportValidity()) {
            return;
        }
        const data = new FormData(form);
        const userId = String(data.get("userId")).trim().toUpperCase();
        const mobile = String(data.get("mobile")).trim();
        const profiles = readList(RETAIL_PROFILES_KEY);
        if (profiles.some(function (profile) {
            return String(profile.userId).toLocaleLowerCase() === userId.toLocaleLowerCase() ||
                profile.mobile === mobile;
        })) {
            status.textContent = "That Retail ID or mobile number is already assigned to a Retailer profile.";
            status.hidden = false;
            return;
        }
        profiles.push({
            userId: userId,
            name: String(data.get("name")).trim(),
            mobile: mobile,
            email: String(data.get("email")).trim(),
            isPasswordSet: false,
            createdAt: new Date().toISOString()
        });
        writeList(RETAIL_PROFILES_KEY, profiles);
        form.reset();
        status.textContent = "Retailer profile added. The Retailer can activate the ID once with their registered mobile number.";
        status.hidden = false;
        renderRetailerProfiles();
    });

    document.getElementById("upline-request-list").addEventListener("click", function (event) {
        const button = event.target.closest("[data-upline-action]");
        if (!button || !isMaster || !ensureCurrentOperatorAccess()) {
            return;
        }
        const requests = readList(UPLINE_REQUESTS_KEY);
        const request = requests.find(function (item) {
            return item.id === button.dataset.uplineId && item.status === "pending";
        });
        if (!request) {
            return;
        }
        request.status = "reviewed";
        request.reviewedAt = new Date().toISOString();
        writeList(UPLINE_REQUESTS_KEY, requests);
        renderUplineRequests();
    });

    document.getElementById("request-change").addEventListener("click", function () {
        if (!ensureCurrentOperatorAccess()) {
            return;
        }
        if (isMaster) {
            setDashboardStatus("Master Admin holds ultimate control. No system change was made.");
            return;
        }
        const approvals = readList(MASTER_APPROVALS_KEY);
        approvals.unshift({
            id: createReference("REQ"),
            description: "Critical system setting or sensitive data change request",
            operator: operator.name,
            requestedAt: new Date().toISOString(),
            status: "pending"
        });
        writeList(MASTER_APPROVALS_KEY, approvals);
        setDashboardStatus("Critical change request sent to the Master Admin queue. It cannot be applied until approved.");
    });

    document.getElementById("approval-list").addEventListener("click", function (event) {
        const button = event.target.closest("[data-critical-action]");
        if (!button || !isMaster) {
            return;
        }
        const approvals = readList(MASTER_APPROVALS_KEY);
        const approval = approvals.find(function (item) {
            return item.id === button.dataset.approvalId && item.status === "pending";
        });
        if (!approval) {
            return;
        }
        approval.status = button.dataset.criticalAction;
        approval.reviewedAt = new Date().toISOString();
        approval.reviewedBy = operator.name;
        writeList(MASTER_APPROVALS_KEY, approvals);
        renderCriticalRequests();
        setDashboardStatus(approval.status === "approved"
            ? "Master Admin approved the request. A real system should now apply the protected change on the server."
            : "Master Admin rejected the critical-change request.");
    });

    document.getElementById("staff-signout").addEventListener("click", async function () {
        try {
            await apiRequest("/api/auth/logout", { method: "POST", body: {} });
            window.location.assign("login.html");
        } catch (error) {
            setDashboardStatus(error.message);
        }
    });

    window.addEventListener("focus", async function () {
        try {
            const result = await apiRequest("/api/portal/state");
            PORTAL_USER = result.user;
            PORTAL_STATE = result.state;
            if (!ensureCurrentOperatorAccess()) return;
            renderApplications();
            renderCustomerDocuments();
            renderDistributorMappings();
            renderCriticalRequests();
            renderRetailerProfiles();
            renderUplineRequests();
        } catch (error) {
            if (/sign in|session has expired|not active/i.test(error.message)) {
                operationsContent.hidden = true;
                accessDenied.hidden = false;
            } else {
                setDashboardStatus(error.message);
            }
        }
    });

    renderApplications();
    renderCustomerDocuments();
    renderDistributorMappings();
    renderCriticalRequests();
    renderRetailerProfiles();
    renderUplineRequests();
}

function networkCell(text, className) {
    const span = document.createElement("span");
    span.textContent = text;
    if (className) span.className = className;
    return span;
}

function networkButton(label, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn quiet";
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
}

function initializePartnerNetwork(staff) {
    const status = document.getElementById("network-status");
    function say(message) {
        status.textContent = message;
        status.hidden = false;
    }
    async function act(applicationId, action, reason) {
        try {
            const result = await apiRequest("/api/admin/partners/" + encodeURIComponent(applicationId) + "/action", {
                method: "POST", body: { action: action, reason: reason || "" },
            });
            const codes = (result.setupCodes || []).map(function (item) {
                return item.identifier + " one-time setup code: " + item.code;
            });
            say("Partner " + result.status + ". " + codes.join(" "));
            await load();
        } catch (error) {
            say(error.message);
        }
    }
    function pill(statusValue) {
        const css = statusValue === "approved" ? "complete" : "pending";
        return networkCell(statusValue.replace("_", " "), "status-pill " + css);
    }

    async function loadDistributorView() {
        const section = document.getElementById("distributor-network-section");
        const result = await apiRequest("/api/distributor/retailers");
        section.hidden = false;
        document.getElementById("net-total").textContent = result.summary.total;
        document.getElementById("net-active").textContent = result.summary.active;
        document.getElementById("net-pending").textContent = result.summary.pending;
        document.getElementById("net-transactions").textContent = result.summary.transactions;
        const list = document.getElementById("distributor-network-list");
        list.replaceChildren();
        if (!result.retailers.length) {
            const empty = document.createElement("p");
            empty.className = "empty-state";
            empty.textContent = "No Retailers are mapped to your Distributor ID yet.";
            list.append(empty);
        }
        result.retailers.forEach(function (item) {
            const card = document.createElement("article");
            card.className = "application-card network-row";
            card.append(
                networkCell(item.name + (item.business ? " — " + item.business : ""), "network-name"),
                networkCell(item.retailerId ? "Retail ID " + item.retailerId : "Awaiting approval"),
                networkCell(item.mobile + " · " + item.city + (item.pin ? " · PIN " + item.pin : "")),
                networkCell(item.transactionCount + " transaction(s)"),
                pill(item.status + (item.active ? " (active)" : "")),
            );
            if (item.status === "pending") {
                card.append(
                    networkButton("Approve", function () { act(item.applicationId, "approve"); }),
                    networkButton("Reject", function () {
                        const reason = window.prompt("Reason for rejection (shown to the applicant):", "");
                        if (reason !== null) act(item.applicationId, "reject", reason);
                    }),
                );
            }
            list.append(card);
        });
    }

    async function loadAdminView() {
        const section = document.getElementById("partner-network-section");
        const result = await apiRequest("/api/admin/network");
        section.hidden = false;
        const list = document.getElementById("partner-network-list");
        list.replaceChildren();
        const approvedDistributors = result.distributors.filter(function (item) { return item.status === "approved"; });
        function actions(item) {
            const box = document.createElement("div");
            box.className = "network-actions";
            if (item.status === "pending") box.append(networkButton("Approve", function () { act(item.applicationId, "approve"); }));
            if (item.status === "approved") box.append(networkButton("Suspend", function () {
                const reason = window.prompt("Reason for suspension:", "");
                if (reason !== null) act(item.applicationId, "suspend", reason);
            }));
            if (item.status === "suspended") box.append(networkButton("Reactivate", function () { act(item.applicationId, "reactivate"); }));
            return box;
        }
        result.distributors.forEach(function (distributor) {
            const group = document.createElement("article");
            group.className = "application-card network-group";
            group.append(
                networkCell(distributor.name + " (" + (distributor.partnerId || "pending") + ")", "network-name"),
                networkCell([distributor.jurisdiction, distributor.city, distributor.pincodes.length
                    ? "PIN " + distributor.pincodes.join(", ") : ""].filter(Boolean).join(" · ")),
                networkCell(distributor.mobile + " · " + distributor.retailerCount + " retailer(s), " +
                    distributor.activeRetailerCount + " active"),
                pill(distributor.status), actions(distributor),
            );
            result.retailers.filter(function (r) { return r.distributorApplicationId === distributor.applicationId; })
                .forEach(function (retailer) { group.append(retailerRow(retailer)); });
            list.append(group);
        });
        const unassigned = result.retailers.filter(function (r) {
            return !result.distributors.some(function (d) { return d.applicationId === r.distributorApplicationId; });
        });
        if (unassigned.length) {
            const group = document.createElement("article");
            group.className = "application-card network-group";
            group.append(networkCell("Master Admin queue (no Distributor assigned)", "network-name"));
            unassigned.forEach(function (retailer) { group.append(retailerRow(retailer)); });
            list.append(group);
        }
        function retailerRow(retailer) {
            const row = document.createElement("div");
            row.className = "network-row";
            const select = document.createElement("select");
            select.setAttribute("aria-label", "Re-assign " + retailer.name + " to a Distributor");
            const none = new Option("Master Admin queue", "");
            select.append(none);
            approvedDistributors.forEach(function (d) {
                select.append(new Option(d.name + " (" + d.partnerId + ")", d.applicationId));
            });
            select.value = retailer.distributorApplicationId || "";
            select.addEventListener("change", async function () {
                try {
                    await apiRequest("/api/admin/retailers/" + encodeURIComponent(retailer.applicationId) + "/reassign", {
                        method: "POST", body: { distributorApplicationId: select.value },
                    });
                    say(retailer.name + " was re-assigned.");
                    await load();
                } catch (error) {
                    say(error.message);
                    select.value = retailer.distributorApplicationId || "";
                }
            });
            row.append(
                networkCell(retailer.name + (retailer.partnerId ? " (" + retailer.partnerId + ")" : ""), "network-name"),
                networkCell(retailer.mobile + " · " + retailer.city + (retailer.pin ? " · PIN " + retailer.pin : "")),
                pill(retailer.status), select, actions(retailer),
            );
            return row;
        }
    }

    async function load() {
        try {
            if (staff.role === "distributor") await loadDistributorView();
            else await loadAdminView();
        } catch (error) {
            say(error.message);
        }
    }
    load();
}

function initializeRetailerDashboard() {
    const content = document.getElementById("retailer-profile-content");
    if (!content) return;
    const denied = document.getElementById("retailer-access-denied");
    if (!PORTAL_RETAILER || !PORTAL_USER || PORTAL_USER.role !== "retailer") {
        denied.hidden = false;
        return;
    }
    const profile = PORTAL_RETAILER.profile;
    content.hidden = false;
    document.getElementById("retailer-welcome").textContent = "Welcome, " + profile.name;
    document.getElementById("retailer-profile-id").textContent = profile.userId;
    document.getElementById("retailer-profile-name").textContent = profile.name;
    document.getElementById("retailer-profile-mobile").textContent = profile.mobile;
    document.getElementById("retailer-profile-email").textContent = profile.email || "Not configured";
    const distributor = PORTAL_RETAILER.distributor;
    if (distributor) {
        document.getElementById("assigned-distributor-card").hidden = false;
        document.getElementById("distributor-name").textContent = distributor.name;
        document.getElementById("distributor-id").textContent = distributor.distributorId || "—";
        document.getElementById("distributor-mobile").textContent = distributor.mobile +
            (distributor.email ? " · " + distributor.email : "");
        const area = distributor.area || {};
        document.getElementById("distributor-area").textContent = [
            area.jurisdiction, area.city, (area.pincodes || []).length ? "PIN " + area.pincodes.join(", ") : "",
        ].filter(Boolean).join(" · ") || "Not recorded";
    }
    initializeSupport(PORTAL_USER, PORTAL_RETAILER.helpline);
    document.getElementById("retailer-signout").addEventListener("click", async function () {
        try {
            await apiRequest("/api/auth/logout", { method: "POST", body: {} });
            window.location.assign("login.html");
        } catch (error) {
            reportApiFailure(error);
        }
    });
}

function initializeServiceRequests() {
    const form = document.getElementById("service-request-form");
    if (form) {
        document.querySelectorAll("[data-service-choice]").forEach(function (link) {
            link.addEventListener("click", function () {
                document.getElementById("service-request-type").value = link.dataset.serviceChoice;
            });
        });
        form.addEventListener("submit", async function (event) {
            event.preventDefault();
            const status = document.getElementById("service-request-status");
            if (!form.reportValidity()) {
                return;
            }
            const data = new FormData(form);
            const mobile = String(data.get("mobile")).trim();
            if (!/^\d{10}$/.test(mobile)) {
                status.textContent = "Enter a valid 10-digit mobile number.";
                status.hidden = false;
                return;
            }
            try {
                await apiRequest("/api/service-enquiries", {
                    method: "POST",
                    body: {
                name: String(data.get("name")).trim(),
                mobile: mobile,
                service: String(data.get("service")).trim(),
                message: String(data.get("message") || "").trim(),
                    },
                });
                form.reset();
                status.textContent = "Your service enquiry has been securely sent to our operations team.";
                status.hidden = false;
            } catch (error) {
                status.textContent = error.message;
                status.hidden = false;
            }
        });
    }

    const container = document.getElementById("service-request-list");
    if (!container) {
        return;
    }
    function renderServiceRequests() {
        const requests = readList(SERVICE_REQUESTS_KEY);
        container.innerHTML = requests.length ? requests.map(function (request) {
            const pending = request.status === "pending";
            return '<article class="application-card"><div class="application-details">' +
                '<span class="application-type">' + (pending ? "New enquiry" : "Contacted") + '</span>' +
                '<h3>' + escapeHTML(request.service) + '</h3><p>' + escapeHTML(request.name) +
                ' · ' + escapeHTML(request.mobile) + '</p><p>' + escapeHTML(request.message || "No details added.") +
                '</p><small>Request ' + escapeHTML(request.id) + ' · ' + formatDate(request.requestedAt) +
                '</small></div>' + (pending ? '<button class="btn quiet" type="button" data-service-action="contacted" data-service-id="' +
                    escapeHTML(request.id) + '">Mark contacted</button>' : "") + '</article>';
        }).join("") : '<p class="empty-state">No service enquiries have been submitted.</p>';
    }
    container.addEventListener("click", function (event) {
        const button = event.target.closest("[data-service-action]");
        if (!button) {
            return;
        }
        const requests = readList(SERVICE_REQUESTS_KEY);
        const request = requests.find(function (item) {
            return item.id === button.dataset.serviceId && item.status === "pending";
        });
        if (!request) {
            return;
        }
        request.status = "contacted";
        request.contactedAt = new Date().toISOString();
        writeList(SERVICE_REQUESTS_KEY, requests);
        renderServiceRequests();
    });
    window.addEventListener("storage", function (event) {
        if (event.key === SERVICE_REQUESTS_KEY) {
            renderServiceRequests();
        }
    });
    renderServiceRequests();
}

function initializePwa() {
    const statusElements = document.querySelectorAll("#install-app-status");
    const installButtons = document.querySelectorAll("#install-app-button");
    let installPrompt = null;
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches ||
        navigator.standalone === true;
    function showStatus(message) {
        statusElements.forEach(function (element) {
            element.textContent = message;
            element.hidden = false;
        });
    }
    if ("serviceWorker" in navigator &&
        (window.isSecureContext || window.location.hostname === "localhost" ||
            window.location.hostname === "127.0.0.1")) {
        navigator.serviceWorker.register("sw.js").catch(function (error) {
            console.error("Service worker registration failed:", error);
            showStatus("Offline support could not be enabled. Check the browser's service-worker settings and reload.");
        });
    }
    if (!isStandalone) {
        installButtons.forEach(function (button) {
            button.textContent = isIOS ? "Add to Home Screen" : "Install app";
            button.hidden = false;
        });
    }
    window.addEventListener("beforeinstallprompt", function (event) {
        event.preventDefault();
        installPrompt = event;
        installButtons.forEach(function (button) {
            button.textContent = "Install app";
            button.hidden = false;
        });
    });
    installButtons.forEach(function (button) {
        button.addEventListener("click", async function () {
            if (!installPrompt) {
                showStatus(isIOS
                    ? "In Safari, tap Share, then choose Add to Home Screen."
                    : "To install, open your browser menu and choose Install app or Add to Home Screen.");
                return;
            }
            installPrompt.prompt();
            const result = await installPrompt.userChoice;
            installPrompt = null;
            installButtons.forEach(function (installButton) {
                installButton.hidden = true;
            });
            if (result.outcome === "accepted") {
                showStatus("R.M Digital Centre was added to your device.");
            }
        });
    });
    window.addEventListener("appinstalled", function () {
        installPrompt = null;
        installButtons.forEach(function (button) {
            button.hidden = true;
        });
        showStatus("R.M Digital Centre is installed.");
    });
}

function readList(key) {
    const value = PORTAL_STATE[key];
    return Array.isArray(value) ? JSON.parse(JSON.stringify(value)) : [];
}

function normalizeApplicationStatus(application) {
    return String(application.status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function findDistributorForPin(pin) {
    const applications = readList(APPLICATIONS_KEY);
    const mappings = readList(DISTRIBUTOR_PIN_MAPPINGS_KEY);
    const matches = applications.filter(function (application) {
        if (application.role !== "distributor" || application.status !== "approved" ||
            !application.generatedId) {
            return false;
        }
        const mapping = mappings.find(function (item) {
            return item.distributorApplicationId === application.id &&
                item.distributorId === application.generatedId;
        });
        const profilePins = Array.isArray(application.servicePincodes)
            ? application.servicePincodes
            : [];
        const mappingPins = mapping && Array.isArray(mapping.pins) ? mapping.pins : [];
        return profilePins.includes(pin) || mappingPins.includes(pin);
    });
    if (matches.length !== 1) {
        return null;
    }
    const distributor = matches[0];
    return distributor ? {
        applicationId: distributor.id,
        generatedId: distributor.generatedId,
        mobile: distributor.mobile,
        name: distributor.name
    } : null;
}

function writeList(key, value) {
    if (!Array.isArray(value)) {
        throw new Error("Portal collections must be arrays.");
    }
    PORTAL_STATE[key] = JSON.parse(JSON.stringify(value));
    const previous = PORTAL_WRITE_QUEUES.get(key) || Promise.resolve();
    const next = previous.then(function () {
        return apiRequest("/api/portal/state/" + encodeURIComponent(key), {
            method: "PUT",
            body: { value: PORTAL_STATE[key] },
        });
    }).then(function (result) {
        if (result.setupCodes && result.setupCodes.length) {
            const status = document.getElementById("dashboard-status");
            if (status) {
                status.textContent = "One-time account setup code(s) — share through a separately verified channel: " +
                    result.setupCodes.map(function (item) {
                        return item.identifier + " (" + item.mobile + "): " + item.code;
                    }).join(" · ");
                status.hidden = false;
            }
        }
        return result;
    }).catch(function (error) {
        reportApiFailure(error);
        return null;
    });
    PORTAL_WRITE_QUEUES.set(key, next);
    return next;
}

function normalizeName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function validatePassword(password) {
    if (password.length < 12) {
        return "Use a password with at least 12 characters.";
    }
    if (password.length > 128) {
        return "Use a password with no more than 128 characters.";
    }
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) ||
        !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
        return "Include at least one uppercase letter, lowercase letter, number and symbol.";
    }
    return "";
}

function createReference(prefix) {
    return prefix + "-" + Date.now().toString(36).toUpperCase() + "-" +
        Math.random().toString(36).slice(2, 6).toUpperCase();
}

function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
        return {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[character];
    });
}

function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "recently" : date.toLocaleDateString();
}

function formatDateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "time unavailable" : date.toLocaleString();
}

function formatFileSize(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) {
        return "size unavailable";
    }
    return value < 1024 * 1024
        ? Math.max(1, Math.round(value / 1024)) + " KB"
        : (value / (1024 * 1024)).toFixed(1) + " MB";
}
