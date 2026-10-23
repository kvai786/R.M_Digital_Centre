"use strict";

const MASTER_ADMIN_MOBILE = "8509010483";
const APPLICATIONS_KEY = "rm-demo-applications";
const BLOCKED_PARTNER_MOBILES_KEY = "rm-demo-blocked-partner-mobiles";
const DISTRIBUTOR_PIN_MAPPINGS_KEY = "rm-demo-distributor-pin-mappings";
const DISTRIBUTOR_NOTIFICATIONS_KEY = "rm-demo-distributor-notifications";
const OPERATORS_KEY = "rm-demo-sub-admins";
const OPERATOR_REQUESTS_KEY = "rm-demo-operator-requests";
const OPERATOR_WHITELIST_KEY = "rm-demo-sub-admin-whitelist";
const MASTER_APPROVALS_KEY = "rm-demo-approvals";
const CREDENTIALS_KEY = "rm-demo-staff-credentials";
const STAFF_SESSION_KEY = "rm-demo-authenticated-staff";
const PASSWORD_ITERATIONS = 210000;
const STAFF_SESSION_LIFETIME = 8 * 60 * 60 * 1000;
const DOCUMENT_SCAN_API_URL = "http://127.0.0.1:8001/api/scan-document";
const MAX_SCAN_FILE_SIZE = 8 * 1024 * 1024;
document.addEventListener("DOMContentLoaded", function () {
    const currentYear = document.getElementById("current-year");
    if (currentYear) {
        currentYear.textContent = String(new Date().getFullYear());
    }

    initializeApplicationForm();
    initializeDocumentScanner();
    initializePortalLogin();
    initializeOperationsDashboard();
});

function initializeApplicationForm() {
    const form = document.getElementById("application-form");
    if (!form) {
        return;
    }

    const roleInput = document.getElementById("application-role");
    const distributorDocuments = document.getElementById("distributor-documents");
    const roleButtons = document.querySelectorAll("[data-role-choice]");
    const successPanel = document.getElementById("submission-success");
    const status = document.getElementById("application-status");
    const pinRouteStatus = document.getElementById("pin-route-status");
    const applicationLookup = document.querySelector(".application-lookup");
    const lookupForm = document.getElementById("rejected-lookup-form");
    const lookupStatus = document.getElementById("rejected-lookup-status");
    const lookupResult = document.getElementById("rejected-application-result");
    const correctionWorkspace = document.getElementById("correction-workspace");
    const applicationMobileInput = document.getElementById("applicant-mobile");
    const operationalPinInput = document.getElementById("operational-pin");
    const params = new URLSearchParams(window.location.search);
    let editingApplicationId = null;

    function setRole(role) {
        const distributor = role === "distributor";
        roleInput.value = role;
        operationalPinInput.required = !distributor;
        operationalPinInput.disabled = distributor;
        document.getElementById("operational-pin-field").hidden = distributor;
        distributorDocuments.hidden = role !== "distributor";
        distributorDocuments.querySelectorAll("input").forEach(function (input) {
            input.required = role === "distributor";
            input.disabled = role !== "distributor";
        });
        roleButtons.forEach(function (button) {
            const selected = button.dataset.roleChoice === role;
            button.classList.toggle("selected", selected);
            button.setAttribute("aria-selected", String(selected));
            button.tabIndex = selected ? 0 : -1;
        });
        form.setAttribute("aria-labelledby", distributor ? "distributor-tab" : "retailer-tab");
        document.getElementById("application-flow-title").textContent = distributor
            ? "Distributor application details"
            : "Retailer application details";
        document.getElementById("application-flow-description").textContent = distributor
            ? "Apply to build and support a network of Retailer partners."
            : "Apply to provide local customer services as a Retailer partner.";
        document.getElementById("application-submit-button").textContent = editingApplicationId
            ? "Resubmit corrected application"
            : "Submit " + (distributor ? "Distributor" : "Retailer") + " application";
    }

    roleButtons.forEach(function (button) {
        button.addEventListener("click", function () {
            if (editingApplicationId) {
                return;
            }
            setRole(button.dataset.roleChoice);
        });
        button.addEventListener("keydown", function (event) {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                return;
            }
            event.preventDefault();
            const nextRole = event.key === "Home" ? "retailer"
                : event.key === "End" ? "distributor"
                    : button.dataset.roleChoice === "retailer" ? "distributor" : "retailer";
            setRole(nextRole);
            document.getElementById(nextRole + "-tab").focus();
        });
    });
    setRole(params.get("role") === "distributor" ? "distributor" : "retailer");
    operationalPinInput.addEventListener("input", function () {
        const digits = operationalPinInput.value.replace(/\D/g, "").slice(0, 6);
        if (operationalPinInput.value !== digits) {
            operationalPinInput.value = digits;
        }
        operationalPinInput.setCustomValidity("");
        if (digits.length !== 6) {
            pinRouteStatus.textContent = "";
            pinRouteStatus.classList.remove("matched", "unmatched");
            return;
        }
        const distributor = findDistributorForPin(digits);
        if (distributor) {
            pinRouteStatus.textContent = "Matched local Distributor: " + distributor.name +
                " · ID " + distributor.generatedId + ".";
            pinRouteStatus.classList.add("matched");
            pinRouteStatus.classList.remove("unmatched");
        } else {
            pinRouteStatus.textContent = "No approved Distributor is mapped to this PIN code yet.";
            pinRouteStatus.classList.add("unmatched");
            pinRouteStatus.classList.remove("matched");
        }
    });
    if (params.has("application")) {
        document.getElementById("rejected-reference").value = params.get("application");
    }

    function isCorrectionStatus(application) {
        const currentStatus = normalizeApplicationStatus(application);
        return currentStatus === "rejected" || currentStatus === "correction_required";
    }

    function findRejectedApplicationByMobile(mobile) {
        return readList(APPLICATIONS_KEY)
            .filter(function (item) {
                return item.mobile === mobile && isCorrectionStatus(item);
            })
            .sort(function (left, right) {
                const leftTime = new Date(left.rejectedAt || left.submittedAt || 0).getTime();
                const rightTime = new Date(right.rejectedAt || right.submittedAt || 0).getTime();
                return rightTime - leftTime;
            })[0] || null;
    }

    function clearFreshApplicationDetails() {
        form.reset();
        editingApplicationId = null;
        applicationMobileInput.value = "";
        setRole(params.get("role") === "distributor" ? "distributor" : "retailer");
        operationalPinInput.dispatchEvent(new Event("input", { bubbles: true }));
        status.hidden = true;
        status.textContent = "";
    }

    function openCorrectionApplication(application) {
        clearFreshApplicationDetails();
        editingApplicationId = application.id;
        document.getElementById("applicant-name").value = application.name || "";
        applicationMobileInput.value = application.mobile || "";
        document.getElementById("business-name").value = application.business || "";
        document.getElementById("email").value = application.email || "";
        document.getElementById("address").value = application.address || "";
        document.getElementById("city").value = application.city || "";
        operationalPinInput.value = application.operationalPin || "";
        setRole(application.role === "distributor" ? "distributor" : "retailer");
        operationalPinInput.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("correction-reason").textContent =
            application.rejectionReason || "Please review your details and upload the corrected documents.";
        document.getElementById("correction-reference").textContent = application.id;
        applicationLookup.hidden = false;
        correctionWorkspace.hidden = false;
        document.querySelector(".role-picker").hidden = true;
        form.hidden = false;
        successPanel.hidden = true;
        status.hidden = true;
        lookupStatus.hidden = true;
        lookupResult.hidden = true;
        correctionWorkspace.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    [applicationMobileInput, document.getElementById("rejected-mobile")].forEach(function (input) {
        input.addEventListener("paste", function (event) {
            const pastedText = event.clipboardData && event.clipboardData.getData("text");
            if (pastedText === undefined) {
                return;
            }
            event.preventDefault();
            input.value = pastedText.replace(/\D/g, "").slice(0, 10);
            input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        input.addEventListener("input", function () {
            const digits = input.value.replace(/\D/g, "").slice(0, 10);
            if (input.value !== digits) {
                input.value = digits;
            }
            input.setCustomValidity("");
        });
    });

    lookupForm.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!lookupForm.reportValidity()) {
            return;
        }
        const reference = document.getElementById("rejected-reference").value.trim();
        const mobile = document.getElementById("rejected-mobile").value.trim();
        const isBlocked = isPartnerMobileBlocked(mobile);
        if (isBlocked) {
            lookupResult.hidden = true;
            lookupStatus.textContent = "This mobile number is permanently blocked from submitting applications.";
            lookupStatus.hidden = false;
            return;
        }
        const application = readList(APPLICATIONS_KEY).find(function (item) {
            return item.id === reference && item.mobile === mobile;
        });
        lookupResult.hidden = true;
        lookupStatus.hidden = false;
        if (!application) {
            lookupStatus.textContent = "No application matched that reference and registered mobile number.";
            return;
        }
        if (!isCorrectionStatus(application)) {
            const currentStatus = application.status === "approved" ? "approved" : "still pending review";
            lookupStatus.textContent = "This application is " + currentStatus + ". Only rejected applications can be edited and resubmitted here.";
            return;
        }
        openCorrectionApplication(application);
    });

    lookupResult.addEventListener("click", function (event) {
        const button = event.target.closest("[data-resubmit-application]");
        if (!button) {
            return;
        }
        const application = readList(APPLICATIONS_KEY).find(function (item) {
            return item.id === button.dataset.resubmitApplication &&
                item.mobile === document.getElementById("rejected-mobile").value.trim() &&
                isCorrectionStatus(item);
        });
        if (!application) {
            lookupStatus.textContent = "This rejected application is no longer available for editing. Search again for its current status.";
            lookupStatus.hidden = false;
            lookupResult.hidden = true;
            return;
        }
        openCorrectionApplication(application);
    });

    document.getElementById("start-new-application").addEventListener("click", function () {
        correctionWorkspace.hidden = true;
        applicationLookup.hidden = true;
        document.querySelector(".role-picker").hidden = false;
        lookupResult.hidden = true;
        lookupStatus.hidden = true;
        clearFreshApplicationDetails();
        applicationMobileInput.focus();
        successPanel.hidden = true;
    });

    form.addEventListener("submit", async function (event) {
        event.preventDefault();
        const mobileInput = document.getElementById("applicant-mobile");
        if (!/^\d{10}$/.test(mobileInput.value)) {
            mobileInput.setCustomValidity("Enter exactly 10 numeric digits.");
            mobileInput.reportValidity();
            return;
        }
        mobileInput.setCustomValidity("");

        if (isPartnerMobileBlocked(mobileInput.value)) {
            correctionWorkspace.hidden = true;
            status.textContent = "This mobile number is permanently blocked from submitting or correcting applications.";
            status.hidden = false;
            return;
        }
        if (!editingApplicationId) {
            const rejectedApplication = findRejectedApplicationByMobile(mobileInput.value);
            if (rejectedApplication) {
                openCorrectionApplication(rejectedApplication);
                return;
            }
        }
        if (editingApplicationId) {
            const currentCorrection = readList(APPLICATIONS_KEY).find(function (item) {
                return item.id === editingApplicationId && item.mobile === mobileInput.value &&
                    isCorrectionStatus(item);
            });
            if (!currentCorrection) {
                status.textContent = "This application is no longer eligible for correction. Check its current status before continuing.";
                status.hidden = false;
                return;
            }
        } else {
            const existingApplication = readList(APPLICATIONS_KEY).find(function (application) {
                const applicationStatus = normalizeApplicationStatus(application);
                return application.mobile === mobileInput.value &&
                    applicationStatus !== "rejected" &&
                    applicationStatus !== "correction_required" &&
                    applicationStatus !== "blocked";
            });
            if (existingApplication) {
                status.textContent = "An application for this mobile number is already " +
                    (normalizeApplicationStatus(existingApplication) === "approved" ? "approved" : "pending review") +
                    " (reference " + existingApplication.id + "). A duplicate application was not submitted.";
                status.hidden = false;
                return;
            }
        }
        let assignedDistributor = null;
        if (roleInput.value === "retailer") {
            const operationalPin = operationalPinInput.value.trim();
            if (!/^\d{6}$/.test(operationalPin)) {
                operationalPinInput.setCustomValidity("Enter exactly 6 numeric digits for the operational PIN code.");
                operationalPinInput.reportValidity();
                return;
            }
            operationalPinInput.setCustomValidity("");
            assignedDistributor = findDistributorForPin(operationalPin);
            if (!assignedDistributor) {
                status.textContent = "No approved Distributor is mapped to PIN code " + operationalPin +
                    ". Please contact support; your application has not been submitted.";
                status.hidden = false;
                return;
            }
        }
        let fieldError;
        try {
            fieldError = await validatePartnerApplication(form, roleInput.value);
        } catch (error) {
            status.textContent = "The selected documents could not be inspected. Please select the files again.";
            status.hidden = false;
            return;
        }
        if (fieldError) {
            status.textContent = fieldError;
            status.hidden = false;
            return;
        }
        if (!form.reportValidity()) {
            return;
        }

        const data = new FormData(form);
        const applicationData = {
            name: String(data.get("name")).trim(),
            mobile: String(data.get("mobile")).trim(),
            business: String(data.get("business")).trim(),
            email: String(data.get("email")).trim(),
            address: String(data.get("address")).trim(),
            city: String(data.get("city")).trim(),
            role: roleInput.value,
            operationalPin: roleInput.value === "retailer" ? operationalPinInput.value.trim() : "",
            documents: Array.from(form.querySelectorAll('input[type="file"]:not(:disabled)')).map(function (input) {
                return {
                    label: input.labels && input.labels[0] ? input.labels[0].textContent.trim() : input.name,
                    fileName: input.files[0].name,
                    size: input.files[0].size,
                    type: input.files[0].type
                };
            }),
            submittedAt: new Date().toISOString()
        };
        const applications = readList(APPLICATIONS_KEY);
        let application;
        let previousDistributorApplicationId = "";
        if (editingApplicationId) {
            application = applications.find(function (item) {
                return item.id === editingApplicationId && isCorrectionStatus(item);
            });
            if (!application) {
                status.textContent = "This rejected application can no longer be edited. Search again for its current status.";
                status.hidden = false;
                return;
            }
            previousDistributorApplicationId = application.assignedDistributorApplicationId || "";
            if (!Array.isArray(application.revisionHistory)) {
                application.revisionHistory = [];
            }
            application.revisionHistory.push({
                submittedAt: application.submittedAt,
                rejectionReason: application.rejectionReason || "",
                documents: application.documents,
                operationalPin: application.operationalPin || "",
                assignedDistributorApplicationId: previousDistributorApplicationId
            });
            Object.assign(application, applicationData, {
                status: "pending",
                revision: (Number(application.revision) || 1) + 1,
                assignedDistributorApplicationId: assignedDistributor ? assignedDistributor.applicationId : "",
                assignedDistributorId: assignedDistributor ? assignedDistributor.generatedId : "",
                assignedDistributorMobile: assignedDistributor ? assignedDistributor.mobile : "",
                routedAt: assignedDistributor ? new Date().toISOString() : ""
            });
            delete application.rejectionReason;
            delete application.rejectedAt;
            delete application.rejectedBy;
        } else {
            application = Object.assign({
                id: createReference("APP"),
                status: "pending",
                revision: 1
            }, applicationData);
            if (assignedDistributor) {
                application.assignedDistributorApplicationId = assignedDistributor.applicationId;
                application.assignedDistributorId = assignedDistributor.generatedId;
                application.assignedDistributorMobile = assignedDistributor.mobile;
                application.routedAt = new Date().toISOString();
            }
            applications.unshift(application);
        }
        writeList(APPLICATIONS_KEY, applications);
        if (assignedDistributor) {
            const notifications = readList(DISTRIBUTOR_NOTIFICATIONS_KEY);
            if (previousDistributorApplicationId &&
                previousDistributorApplicationId !== assignedDistributor.applicationId) {
                notifications.forEach(function (notification) {
                    if (notification.applicationId === application.id &&
                        notification.distributorApplicationId === previousDistributorApplicationId &&
                        notification.status === "queued") {
                        notification.status = "rerouted";
                        notification.updatedAt = new Date().toISOString();
                    }
                });

            }
            notifications.unshift({
                id: createReference("NTF"),
                distributorApplicationId: assignedDistributor.applicationId,
                distributorId: assignedDistributor.generatedId,
                distributorMobile: assignedDistributor.mobile,
                applicationId: application.id,
                operationalPin: application.operationalPin,
                message: "New Retailer application " + application.id + " is waiting for review for PIN " +
                    application.operationalPin + ".",
                createdAt: new Date().toISOString(),
                status: "queued"
            });
            writeList(DISTRIBUTOR_NOTIFICATIONS_KEY, notifications);
        }

        document.getElementById("application-reference").textContent = application.id;
        document.getElementById("application-success-message").textContent = assignedDistributor
            ? "Your application was routed to " + assignedDistributor.name + " (Distributor ID " +
                assignedDistributor.generatedId + ") for PIN code " + application.operationalPin +
                ". A notification is queued for " + assignedDistributor.mobile +
                " in this browser demo; no SMS was sent."
            : editingApplicationId
                ? "Your corrected demo application and updated document selections were resubmitted for fresh approval."
                : "Your demo application is pending review. In a live service, processing typically takes 24–48 hours. You would receive an SMS after a decision.";
        editingApplicationId = null;
        form.hidden = true;
        document.querySelector(".role-picker").hidden = true;
        correctionWorkspace.hidden = true;
        status.hidden = true;
        successPanel.hidden = false;
        successPanel.scrollIntoView({ behavior: "smooth", block: "center" });
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
                    : error.message || "Could not connect to the local OCR service on port 8001.";
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
    for (const input of fileInputs) {
        if (!input.files || input.files.length !== 1) {
            return "Select every required document before submitting.";
        }
        const file = input.files[0];
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
    if (!mobileForm) {
        return;
    }

    const phoneInput = document.getElementById("login-mobile");
    const passwordForm = document.getElementById("login-password-form");
    const setupForm = document.getElementById("first-time-setup-form");
    const recoveryForm = document.getElementById("password-recovery-form");
    const operatorSetupForm = document.getElementById("operator-setup-form");
    const status = document.getElementById("login-status");
    let selectedStaff = null;

    function setStatus(message) {
        status.textContent = message;
        status.hidden = false;
    }

    function showOnly(form) {
        [mobileForm, passwordForm, setupForm, recoveryForm, operatorSetupForm].forEach(function (item) {
            item.hidden = item !== form;
        });
        status.hidden = true;
    }

    function findStaff(mobile) {
        if (mobile === MASTER_ADMIN_MOBILE) {
            return { mobile: mobile, role: "master", name: "Master Admin" };
        }
        const operator = readList(OPERATORS_KEY).find(function (item) {
            const authorization = findAuthorizedOperator(mobile);
            return item.mobile === mobile && item.status === "active" &&
                authorization && normalizeName(item.name) === normalizeName(authorization.name);
        });
        return operator ? { mobile: operator.mobile, role: "subadmin", name: operator.name } : null;
    }

    function setSession(staff, credential) {
        sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify({
            role: staff.role,
            mobile: staff.mobile,
            name: staff.name,
            credentialVersion: credential.version,
            authenticatedAt: Date.now()
        }));
        window.location.assign("admin.html");
    }

    mobileForm.addEventListener("submit", function (event) {
        event.preventDefault();
        const mobile = phoneInput.value.trim();
        if (!/^\d{10,15}$/.test(mobile)) {
            setStatus("Enter a valid mobile number using digits only.");
            phoneInput.focus();
            return;
        }

        selectedStaff = findStaff(mobile);
        if (selectedStaff) {
            const credential = findCredential(mobile);
            if (credential) {
                const nameInput = document.getElementById("login-name");
                nameInput.required = selectedStaff.role === "subadmin";
                nameInput.value = "";
                document.getElementById("login-name-field").hidden = selectedStaff.role !== "subadmin";
                document.getElementById("login-account-label").textContent = "Sign in to " + selectedStaff.name + " account.";
                document.getElementById("login-password").value = "";
                showOnly(passwordForm);
                (selectedStaff.role === "subadmin" ? nameInput : document.getElementById("login-password")).focus();
            } else {
                document.getElementById("setup-title").textContent = selectedStaff.role === "master"
                    ? "Create Master Admin password"
                    : "Create Sub-Admin password";
                const nameField = document.getElementById("setup-name-field");
                nameField.hidden = selectedStaff.role !== "subadmin";
                document.getElementById("setup-name").required = selectedStaff.role === "subadmin";
                if (selectedStaff.role === "subadmin") {
                    document.getElementById("setup-name").value = selectedStaff.name;
                }
                showOnly(setupForm);
                document.getElementById("setup-password").focus();
            }
            return;
        }

        const operatorExists = readList(OPERATORS_KEY).some(function (item) {
            return item.mobile === mobile;
        });
        if (operatorExists) {
            setStatus("This Sub-Admin account is not active. Contact the Master Admin.");
            return;
        }
        const authorization = findAuthorizedOperator(mobile);
        if (!authorization) {
            setStatus("This mobile number is not authorized for Sub-Admin access. Contact the Master Admin.");
            return;
        }
        const priorRequest = readList(OPERATOR_REQUESTS_KEY).find(function (item) {
            return item.mobile === mobile;
        });
        if (priorRequest && priorRequest.status === "rejected") {
            setStatus("This Sub-Admin request was rejected. Contact the Master Admin.");
            return;
        }
        if (priorRequest && priorRequest.status === "pending") {
            setStatus("Sub-Admin setup is awaiting Master Admin approval. This mobile number cannot be changed for that request.");
            return;
        }

        document.getElementById("operator-mobile").value = mobile;
        document.getElementById("operator-name").value = "";
        showOnly(operatorSetupForm);
        document.getElementById("operator-name").focus();
    });

    setupForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!selectedStaff || !setupForm.reportValidity()) {
            return;
        }
        const password = document.getElementById("setup-password").value;
        const passwordConfirm = document.getElementById("setup-password-confirm").value;
        const recovery = document.getElementById("setup-recovery").value;
        const recoveryConfirm = document.getElementById("setup-recovery-confirm").value;
        if (selectedStaff.role === "subadmin" &&
            normalizeName(document.getElementById("setup-name").value) !== normalizeName(selectedStaff.name)) {
            setStatus("The name does not match the Master Admin's authorized Sub-Admin record.");
            return;
        }
        const passwordError = validatePassword(password);
        if (passwordError) {
            setStatus(passwordError);
            return;
        }
        if (password !== passwordConfirm) {
            setStatus("The passwords do not match.");
            return;
        }
        if (recovery.trim().length < 12 || recovery.length > 256 || recovery !== recoveryConfirm) {
            setStatus("Enter the same recovery phrase in both fields. It must be at least 12 characters.");
            return;
        }
        if (findCredential(selectedStaff.mobile)) {
            setStatus("A password is already set for this account. Sign in or use Forgot password.");
            return;
        }

        try {
            const credential = {
                mobile: selectedStaff.mobile,
                role: selectedStaff.role,
                name: selectedStaff.role === "subadmin"
                    ? selectedStaff.name
                    : "Master Admin",
                password: await hashSecret(password),
                recovery: await hashSecret(recovery),
                version: createReference("AUTH"),
                updatedAt: new Date().toISOString()
            };
            const credentials = readList(CREDENTIALS_KEY);
            credentials.push(credential);
            writeList(CREDENTIALS_KEY, credentials);
            selectedStaff.name = credential.name;
            setSession(selectedStaff, credential);
        } catch (error) {
            setStatus(error.message);
        }
    });

    passwordForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!selectedStaff || !passwordForm.reportValidity()) {
            return;
        }
        try {
            const credential = findCredential(selectedStaff.mobile);
            const submittedName = document.getElementById("login-name").value;
            if (selectedStaff.role === "subadmin" &&
                normalizeName(submittedName) !== normalizeName(selectedStaff.name)) {
                setStatus("The name, mobile number and authorized Sub-Admin account do not match.");
                document.getElementById("login-name").focus();
                return;
            }
            if (!credential || !(await verifySecret(document.getElementById("login-password").value, credential.password))) {
                setStatus("Mobile number or password is incorrect.");
                document.getElementById("login-password").value = "";
                document.getElementById("login-password").focus();
                return;
            }
            if (selectedStaff.role === "subadmin" &&
                normalizeName(credential.name) !== normalizeName(selectedStaff.name)) {
                setStatus("The name, mobile number and authorized Sub-Admin account do not match.");
                document.getElementById("login-password").value = "";
                document.getElementById("login-name").focus();
                return;
            }
            selectedStaff.name = credential.name;
            setSession(selectedStaff, credential);
        } catch (error) {
            setStatus(error.message);
        }
    });

    recoveryForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        if (!recoveryForm.reportValidity()) {
            return;
        }
        const mobile = document.getElementById("recovery-mobile").value.trim();
        try {
            const staff = findStaff(mobile);
            const credential = staff && findCredential(mobile);
            if (!staff || !credential || !(await verifySecret(document.getElementById("recovery-phrase").value, credential.recovery))) {
                setStatus("Account or recovery phrase could not be verified.");
                return;
            }
            const password = document.getElementById("recovery-password").value;
            const passwordError = validatePassword(password);
            if (passwordError) {
                setStatus(passwordError);
                return;
            }
            if (password !== document.getElementById("recovery-password-confirm").value) {
                setStatus("The new passwords do not match.");
                return;
            }
            credential.password = await hashSecret(password);
            credential.version = createReference("AUTH");
            credential.updatedAt = new Date().toISOString();
            writeList(CREDENTIALS_KEY, readList(CREDENTIALS_KEY).map(function (item) {
                return item.mobile === mobile ? credential : item;
            }));
            sessionStorage.removeItem(STAFF_SESSION_KEY);
            recoveryForm.reset();
            selectedStaff = staff;
            document.getElementById("login-account-label").textContent = "Password reset. Sign in to " + staff.name + ".";
            showOnly(passwordForm);
            document.getElementById("login-password").focus();
        } catch (error) {
            setStatus(error.message);
        }
    });

    operatorSetupForm.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!operatorSetupForm.reportValidity()) {
            return;
        }
        const mobile = document.getElementById("operator-mobile").value;
        const operators = readList(OPERATORS_KEY);
        const requests = readList(OPERATOR_REQUESTS_KEY);
        const name = document.getElementById("operator-name").value.trim();
        const authorization = findAuthorizedOperator(mobile);
        if (mobile === MASTER_ADMIN_MOBILE || !authorization ||
            normalizeName(name) !== normalizeName(authorization.name)) {
            setStatus("The name and mobile number must match an identity authorized by the Master Admin.");
            return;
        }
        if (operators.some(function (item) { return item.mobile === mobile; }) ||
            requests.some(function (item) { return item.mobile === mobile; })) {
            setStatus("This number is already assigned or has an enrollment request.");
            return;
        }
        requests.unshift({
            id: createReference("OPR"),
            name: authorization.name,
            mobile: mobile,
            requestedAt: new Date().toISOString(),
            status: "pending"
        });
        writeList(OPERATOR_REQUESTS_KEY, requests);
        operatorSetupForm.reset();
        showOnly(mobileForm);
        phoneInput.value = "";
        setStatus("Setup request submitted for Master Admin approval. After approval, the Sub-Admin can create a password and recovery phrase.");
    });

    document.getElementById("forgot-password").addEventListener("click", function () {
        recoveryForm.reset();
        document.getElementById("recovery-mobile").value = selectedStaff ? selectedStaff.mobile : phoneInput.value.trim();
        showOnly(recoveryForm);
        document.getElementById("recovery-phrase").focus();
    });

    document.getElementById("cancel-recovery").addEventListener("click", function () {
        if (selectedStaff && findCredential(selectedStaff.mobile)) {
            showOnly(passwordForm);
            document.getElementById("login-password").focus();
        } else {
            showOnly(mobileForm);
            phoneInput.focus();
        }
    });

    document.getElementById("change-number").addEventListener("click", function () {
        selectedStaff = null;
        showOnly(mobileForm);
        phoneInput.focus();
    });
}

function initializeOperationsDashboard() {
    const applicationList = document.getElementById("application-list");
    if (!applicationList) {
        return;
    }

    const sessionValue = sessionStorage.getItem(STAFF_SESSION_KEY);
    const accessDenied = document.getElementById("dashboard-access-denied");
    const operationsContent = document.getElementById("operations-content");
    const query = new URLSearchParams(window.location.search);
    const requestedDistributorId = query.get("distributor");
    const requestedQueueToken = query.get("access");
    const distributorMapping = readList(DISTRIBUTOR_PIN_MAPPINGS_KEY).find(function (item) {
        return item.distributorId === requestedDistributorId &&
            item.queueAccessToken === requestedQueueToken;
    });
    const distributorProfile = distributorMapping && readList(APPLICATIONS_KEY).find(function (item) {
        return item.id === distributorMapping.distributorApplicationId &&
            item.role === "distributor" && item.status === "approved" &&
            item.generatedId === requestedDistributorId;
    });
    const isDistributorMode = Boolean(distributorProfile);
    let staff = null;
    let credential = null;
    let isMaster = false;
    let operator = distributorProfile || null;
    if (!isDistributorMode) {
        if (!sessionValue) {
            accessDenied.hidden = false;
            return;
        }
        try {
            staff = JSON.parse(sessionValue);
        } catch (error) {
            sessionStorage.removeItem(STAFF_SESSION_KEY);
            accessDenied.hidden = false;
            return;
        }
        credential = findCredential(staff.mobile);
        if (!credential || credential.version !== staff.credentialVersion ||
            !Number.isFinite(staff.authenticatedAt) ||
            Date.now() - staff.authenticatedAt > STAFF_SESSION_LIFETIME) {
            sessionStorage.removeItem(STAFF_SESSION_KEY);
            accessDenied.hidden = false;
            return;
        }
        isMaster = staff.role === "master" && staff.mobile === MASTER_ADMIN_MOBILE &&
            credential.role === "master";
        operator = isMaster
            ? { name: "Master Admin", mobile: MASTER_ADMIN_MOBILE }
            : readList(OPERATORS_KEY).find(function (item) {
                const authorization = findAuthorizedOperator(staff.mobile);
                return staff.role === "subadmin" && credential.role === "subadmin" &&
                    item.mobile === staff.mobile && item.status === "active" && authorization &&
                    normalizeName(item.name) === normalizeName(authorization.name) &&
                    normalizeName(credential.name) === normalizeName(authorization.name) &&
                    normalizeName(staff.name) === normalizeName(authorization.name);
            });
        if (!operator || (isMaster && staff.mobile !== MASTER_ADMIN_MOBILE)) {
            sessionStorage.removeItem(STAFF_SESSION_KEY);
            accessDenied.hidden = false;
            return;
        }
    }

    operationsContent.hidden = false;
    document.getElementById("operator-caption").textContent = operator.name + " · " +
        (isDistributorMode ? "Distributor workspace · " + operator.generatedId
            : isMaster ? "Master Admin — ultimate control"
                : "Sub-Admin / Operator — locked mobile ending " + operator.mobile.slice(-4));
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

    const dashboardStatus = document.getElementById("dashboard-status");
    let pendingApproval = null;

    function setDashboardStatus(message) {
        dashboardStatus.textContent = message;
        dashboardStatus.hidden = false;
    }

    function ensureCurrentOperatorAccess() {
        if (isDistributorMode) {
            const currentMapping = readList(DISTRIBUTOR_PIN_MAPPINGS_KEY).find(function (item) {
                return item.distributorId === requestedDistributorId &&
                    item.queueAccessToken === requestedQueueToken &&
                    item.distributorApplicationId === distributorProfile.id;
            });
            const currentProfile = readList(APPLICATIONS_KEY).find(function (item) {
                return item.id === distributorProfile.id && item.role === "distributor" &&
                    item.status === "approved" && item.generatedId === requestedDistributorId;
            });
            if (currentMapping && currentProfile) {
                return true;
            }
            operationsContent.hidden = true;
            accessDenied.hidden = false;
            return false;
        }
        if (isMaster) {
            return true;
        }
        const authorization = findAuthorizedOperator(staff.mobile);
        const activeOperator = readList(OPERATORS_KEY).find(function (item) {
            return item.mobile === staff.mobile && item.status === "active";
        });
        const currentCredential = findCredential(staff.mobile);
        const allowed = authorization && activeOperator &&
            normalizeName(authorization.name) === normalizeName(activeOperator.name) &&
            normalizeName(authorization.name) === normalizeName(staff.name) &&
            currentCredential && currentCredential.version === staff.credentialVersion &&
            currentCredential.role === "subadmin" &&
            normalizeName(currentCredential.name) === normalizeName(authorization.name);
        if (!allowed) {
            sessionStorage.removeItem(STAFF_SESSION_KEY);
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
                return application.role !== "retailer" || !application.assignedDistributorApplicationId;
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
                    "). This is a local browser notification preview; SMS was not sent."
                : "No new application notifications. No SMS is sent by this browser demo.";
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
            const documentSummary = documentList.map(function (item) {
                return escapeHTML(item.label) + " (" + escapeHTML(item.fileName) + ")";
            }).join(", ");
            const rejected = application.status === "rejected";
            const pending = application.status === "pending";
            const blocked = application.status === "blocked" || blockedMobiles.includes(application.mobile);
            const statusLabel = blocked ? "Permanently blocked" :
                rejected ? "Rejected · correction allowed" :
                    pending ? "Pending review" : "Approved";
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
                    '<button type="button" class="btn quiet" data-application-action="delete" data-application-id="' +
                        escapeHTML(application.id) + '">Delete record</button></div>';
            return '<article class="application-card">' +
                '<div class="application-details"><span class="application-type">' + roleName + ' · ' + statusLabel + '</span>' +
                '<h3>' + escapeHTML(application.name) + '</h3>' +
                '<p>' + escapeHTML(application.business) + ' · ' + escapeHTML(application.city || "") +
                (application.operationalPin ? ' · PIN ' + escapeHTML(application.operationalPin) : "") + '</p>' +
                '<p class="application-contact">' + escapeHTML(application.mobile || "") + ' · ' + escapeHTML(application.email || "") + '</p>' +
                '<small>Reference ' + escapeHTML(application.id) + ' · Submitted ' + formatDate(application.submittedAt) +
                ' · Revision ' + escapeHTML(application.revision || 1) + '</small>' +
                '<p class="document-summary"><strong>Selected documents (not uploaded):</strong> ' + (documentSummary || "None recorded") + '</p>' +
                (rejected ? decision : "") + '</div>' + '<div class="application-decisions">' +
                    (pending && !blocked ? decision : pending
                        ? '<p class="application-final-status">This number is blocked; no approval is available.</p>'
                        : !rejected ? decision : "") + applicationActions + '</div></article>';
        }).join("");
    }

    function renderOperatorRequests() {
        const container = document.getElementById("operator-request-list");
        if (!isMaster) {
            return;
        }
        const requests = readList(OPERATOR_REQUESTS_KEY);
        if (requests.length === 0) {
            container.innerHTML = '<p class="empty-state">No Sub-Admin enrollment requests.</p>';
            return;
        }
        container.innerHTML = requests.map(function (request) {
            const pending = request.status === "pending";
            const authorization = pending ? findAuthorizedOperator(request.mobile) : null;
            const matchesWhitelist = authorization &&
                normalizeName(authorization.name) === normalizeName(request.name);
            const alreadyAssigned = readList(OPERATORS_KEY).some(function (item) {
                return item.mobile === request.mobile;
            });
            const statusLabel = pending ? "Awaiting Master decision" :
                request.status === "accepted" || request.status === "approved" ? "Accepted" : "Rejected";
            const actions = pending
                ? '<div class="approval-actions"><button type="button" class="btn primary" data-operator-action="approve" data-request-id="' +
                    escapeHTML(request.id) + '"' + (!matchesWhitelist || alreadyAssigned ? " disabled" : "") +
                    '>Accept</button><button type="button" class="btn quiet" data-operator-action="reject" data-request-id="' +
                    escapeHTML(request.id) + '">Reject</button></div>'
                : "";
            const reason = pending && !matchesWhitelist
                ? "This name/mobile pair is not currently on the authorization whitelist."
                : pending && alreadyAssigned ? "This mobile number already has an operator account." : "";
            return '<article class="application-card operator-request-card"><div class="application-details">' +
                '<span class="application-type">' + statusLabel + '</span><h3>' + escapeHTML(request.name) + '</h3>' +
                '<p>Requested mobile: <strong>' + escapeHTML(request.mobile) + '</strong></p>' +
                '<small>Request ' + escapeHTML(request.id) + ' · ' + formatDate(request.requestedAt) + '</small>' +
                '<p class="document-summary">' + escapeHTML(reason || (pending
                    ? "Accept grants access only to this authorized name/mobile pair."
                    : request.status === "rejected" ? "This request was terminated." : "Operator account was accepted by the Master Admin.")) +
                '</p></div>' + actions + '</article>';
        }).join("");
    }

    function renderOperatorWhitelist() {
        if (!isMaster) {
            return;
        }
        const container = document.getElementById("operator-whitelist-list");
        const whitelist = readList(OPERATOR_WHITELIST_KEY);
        if (whitelist.length === 0) {
            container.innerHTML = '<p class="empty-state">No Sub-Admin identities are authorized yet. Add a name and mobile number above.</p>';
            return;
        }
        container.innerHTML = whitelist.map(function (item) {
            const itemStatus = item.status || "active";
            const statusLabel = itemStatus === "active" ? "Active" :
                itemStatus === "held" ? "On hold" :
                    itemStatus === "banned" ? "Permanently banned" : "Revoked";
            const statusClass = itemStatus === "active" ? "complete" : "pending";
            const action = '<div class="operator-lifecycle-actions">' +
                (itemStatus === "active"
                    ? '<button type="button" class="btn quiet" data-whitelist-action="hold" data-whitelist-id="' + escapeHTML(item.id) + '">Hold access</button>'
                    : "") +
                '<button type="button" class="btn quiet" data-whitelist-action="reset" data-whitelist-id="' + escapeHTML(item.id) + '">Reset / Recover / Reactivate</button>' +
                (itemStatus !== "banned"
                    ? '<button type="button" class="btn danger" data-whitelist-action="ban" data-whitelist-id="' + escapeHTML(item.id) + '">Permanent ban</button>'
                    : "") +
                '<button type="button" class="btn quiet" data-whitelist-action="delete" data-whitelist-id="' + escapeHTML(item.id) + '">Delete &amp; allow re-add</button>' +
                '</div>';
            return '<article class="approval-card"><div><span class="status-pill ' +
                statusClass + '">' + statusLabel +
                '</span><p><strong>' + escapeHTML(item.name) + '</strong> · ' + escapeHTML(item.mobile) +
                '</p><small>Added ' + formatDate(item.addedAt) + '</small></div>' + action + '</article>';
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
            const queueUrl = mapping && mapping.queueAccessToken
                ? new URL("admin.html?distributor=" + encodeURIComponent(distributor.generatedId) +
                    "&access=" + encodeURIComponent(mapping.queueAccessToken), window.location.href).toString()
                : "";
            return '<article class="application-card distributor-mapping-card">' +
                '<div class="application-details"><span class="application-type">Approved Distributor</span>' +
                '<h3>' + escapeHTML(distributor.name) + '</h3><p>' + escapeHTML(distributor.business || "") +
                ' · ID <strong>' + escapeHTML(distributor.generatedId) + '</strong></p>' +
                '<p class="application-contact">' + escapeHTML(distributor.mobile) + '</p></div>' +
                '<form class="distributor-mapping-form" data-distributor-application-id="' + escapeHTML(distributor.id) + '">' +
                '<div class="field"><label for="pins-' + escapeHTML(distributor.id) + '">Service PIN codes</label>' +
                '<input id="pins-' + escapeHTML(distributor.id) + '" name="pins" value="' +
                escapeHTML(mapping && Array.isArray(mapping.pins) ? mapping.pins.join(", ") : "") +
                '" maxlength="1000" placeholder="e.g. 110001, 110002" aria-describedby="pin-help-' +
                escapeHTML(distributor.id) + '"><small id="pin-help-' + escapeHTML(distributor.id) +
                '" class="field-hint">Enter comma-separated, unique 6-digit PIN codes. Leave blank to remove this mapping.</small></div>' +
                '<div class="field"><label for="region-' + escapeHTML(distributor.id) + '">Regional area (optional)</label>' +
                '<input id="region-' + escapeHTML(distributor.id) + '" name="region" value="' +
                escapeHTML(mapping && mapping.region || "") + '" maxlength="120" placeholder="City / district / region"></div>' +
                '<button class="btn primary" type="submit">Save PIN mapping</button>' +
                (queueUrl ? '<p class="distributor-queue-link"><strong>Distributor queue link</strong><br><a class="text-link" href="' +
                    escapeHTML(queueUrl) + '" target="_blank" rel="noopener noreferrer">Open local queue preview</a>' +
                    '<br><small>Share only with this Distributor. Browser-demo links are not secure authentication.</small></p>' : "") +
                '</form></article>';
        }).join("");
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
        application.status = "approved";
        application.generatedId = generatedId;
        application.approvedBy = operator.name;
        application.approvedAt = new Date().toISOString();
        if (application.role === "retailer" && application.assignedDistributorApplicationId) {
            application.distributorQueueStatus = "approved";
            application.distributorReviewedAt = application.approvedAt;
        }
        writeList(APPLICATIONS_KEY, applications);
        updateDistributorNotifications(applicationId, "approved");
        renderApplications();
        renderDistributorMappings();
        document.getElementById("approval-password-panel").hidden = true;
        pendingApproval = null;
        setDashboardStatus("Application approved. Simulated SMS to " + (application.mobile || "the registered mobile") +
            ": your " + (application.role === "distributor" ? "Distributor" : "Retailer") +
            " ID is " + generatedId + ". No SMS was sent.");
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
            const currentCredential = findCredential(operator.mobile);
            const validPassword = currentCredential &&
                currentCredential.version === staff.credentialVersion &&
                await verifySecret(document.getElementById("approval-password").value, currentCredential.password);
            if (!validPassword) {
                setDashboardStatus("Password verification failed. No application action was completed.");
                return;
            }
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

    document.getElementById("operator-request-list").addEventListener("click", function (event) {
        const button = event.target.closest("[data-operator-action]");
        if (!button || !isMaster) {
            return;
        }
        const requests = readList(OPERATOR_REQUESTS_KEY);
        const request = requests.find(function (item) {
            return item.id === button.dataset.requestId && item.status === "pending";
        });
        if (!request) {
            return;
        }
        request.status = button.dataset.operatorAction === "approve" ? "accepted" : "rejected";
        request.reviewedAt = new Date().toISOString();
        if (request.status === "accepted") {
            const authorization = findAuthorizedOperator(request.mobile);
            const operators = readList(OPERATORS_KEY);
            if (!authorization || normalizeName(authorization.name) !== normalizeName(request.name)) {
                setDashboardStatus("Acceptance blocked: the name/mobile pair no longer matches the Master Admin whitelist.");
                return;
            }
            if (request.mobile === MASTER_ADMIN_MOBILE || operators.some(function (item) { return item.mobile === request.mobile; })) {
                request.status = "rejected";
                request.reason = "Mobile number is already assigned.";
            } else {
                operators.push({
                    id: createReference("SUB"),
                    name: request.name,
                    mobile: request.mobile,
                    lockedAt: new Date().toISOString(),
                    status: "active"
                });
                writeList(OPERATORS_KEY, operators);
            }
        }
        writeList(OPERATOR_REQUESTS_KEY, requests);
        renderOperatorRequests();
        setDashboardStatus(request.status === "accepted"
            ? "Sub-Admin enrolled. The mobile number is now locked to this account and cannot be changed here."
            : "Sub-Admin enrollment request rejected.");
    });

    document.getElementById("operator-whitelist-form").addEventListener("submit", function (event) {
        event.preventDefault();
        if (!isMaster || !event.currentTarget.reportValidity()) {
            return;
        }
        const name = document.getElementById("whitelist-name").value.trim();
        const mobile = document.getElementById("whitelist-mobile").value.trim();
        const whitelist = readList(OPERATOR_WHITELIST_KEY);
        const status = document.getElementById("whitelist-status");
        if (!/^\d{10,15}$/.test(mobile) || mobile === MASTER_ADMIN_MOBILE) {
            status.textContent = "Enter an authorized Sub-Admin mobile number; the Master Admin number cannot be added.";
            status.hidden = false;
            return;
        }
        if (!normalizeName(name)) {
            status.textContent = "Enter the Sub-Admin's authorized name.";
            status.hidden = false;
            return;
        }
        const existing = whitelist.find(function (item) { return item.mobile === mobile; });
        if (existing) {
            if (existing.status === "banned") {
                status.textContent = "This number is permanently banned. Use Reset / Recover / Reactivate or Delete & allow re-add before authorizing it again.";
                status.hidden = false;
                return;
            }
            if (existing.status === "held") {
                status.textContent = "This number is on hold. Use Reset / Recover / Reactivate before changing its authorized identity.";
                status.hidden = false;
                return;
            }
            if (existing.status === "active" && normalizeName(existing.name) === normalizeName(name)) {
                status.textContent = "This name and mobile number are already authorized.";
                status.hidden = false;
                return;
            }
            existing.name = name;
            existing.status = "active";
            existing.updatedAt = new Date().toISOString();
            writeList(OPERATOR_WHITELIST_KEY, whitelist);
            writeList(OPERATORS_KEY, readList(OPERATORS_KEY).filter(function (item) {
                return item.mobile !== mobile;
            }));
            writeList(CREDENTIALS_KEY, readList(CREDENTIALS_KEY).filter(function (item) {
                return item.mobile !== mobile;
            }));
            writeList(OPERATOR_REQUESTS_KEY, readList(OPERATOR_REQUESTS_KEY).filter(function (item) {
                return item.mobile !== mobile;
            }));
            event.currentTarget.reset();
            status.textContent = "Authorization updated. Old account credentials and requests were cleared; the operator can submit a fresh setup request.";
            status.hidden = false;
            renderOperatorWhitelist();
            renderOperatorRequests();
            return;
        }
        whitelist.unshift({
            id: createReference("AUTHZ"),
            name: name,
            mobile: mobile,
            addedAt: new Date().toISOString(),
            status: "active"
        });
        writeList(OPERATOR_WHITELIST_KEY, whitelist);
        event.currentTarget.reset();
        status.textContent = "Authorized name/mobile pair added. The Sub-Admin may now request access.";
        status.hidden = false;
        renderOperatorWhitelist();
        renderOperatorRequests();
    });

    document.getElementById("operator-whitelist-list").addEventListener("click", function (event) {
        const button = event.target.closest("[data-whitelist-action]");
        if (!button || !isMaster) {
            return;
        }
        const whitelist = readList(OPERATOR_WHITELIST_KEY);
        const identity = whitelist.find(function (item) {
            return item.id === button.dataset.whitelistId;
        });
        if (!identity) {
            return;
        }
        const mobile = identity.mobile;
        const action = button.dataset.whitelistAction;
        const operators = readList(OPERATORS_KEY);
        const requests = readList(OPERATOR_REQUESTS_KEY);
        const credentials = readList(CREDENTIALS_KEY);
        if (action === "hold") {
            identity.status = "held";
            operators.forEach(function (item) {
                if (item.mobile === mobile) item.status = "held";
            });
        } else if (action === "ban") {
            identity.status = "banned";
            identity.bannedAt = new Date().toISOString();
            operators.forEach(function (item) {
                if (item.mobile === mobile) item.status = "banned";
            });
            writeList(CREDENTIALS_KEY, credentials.filter(function (item) { return item.mobile !== mobile; }));
        } else if (action === "reset") {
            identity.status = "active";
            delete identity.bannedAt;
            delete identity.heldAt;
            operators.forEach(function (item) {
                if (item.mobile === mobile) item.status = "active";
            });
            writeList(OPERATOR_REQUESTS_KEY, requests.filter(function (item) { return item.mobile !== mobile; }));
            writeList(CREDENTIALS_KEY, credentials.filter(function (item) { return item.mobile !== mobile; }));
        } else if (action === "delete") {
            writeList(OPERATOR_WHITELIST_KEY, whitelist.filter(function (item) { return item.id !== identity.id; }));
            writeList(OPERATORS_KEY, operators.filter(function (item) { return item.mobile !== mobile; }));
            writeList(OPERATOR_REQUESTS_KEY, requests.filter(function (item) { return item.mobile !== mobile; }));
            writeList(CREDENTIALS_KEY, credentials.filter(function (item) { return item.mobile !== mobile; }));
            renderOperatorWhitelist();
            renderOperatorRequests();
            setDashboardStatus("Sub-Admin authorization, account, requests and credentials deleted. The mobile number can now be added again from scratch.");
            return;
        }
        identity.updatedAt = new Date().toISOString();
        writeList(OPERATOR_WHITELIST_KEY, whitelist);
        writeList(OPERATORS_KEY, operators);
        renderOperatorWhitelist();
        renderOperatorRequests();
        setDashboardStatus(action === "hold"
            ? "Sub-Admin placed on hold. Access and approvals are paused until reset/reactivation."
            : action === "ban"
                ? "Sub-Admin permanently banned. The number cannot re-register until the Master Admin resets or deletes the record."
                : "Sub-Admin state reset and reactivated. Old requests and credentials were cleared; a fresh password setup is required.");
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
        if (!mapping.queueAccessToken) {
            try {
                mapping.queueAccessToken = createDistributorQueueToken();
            } catch (error) {
                status.textContent = error.message;
                status.hidden = false;
                return;
            }
        }
        mapping.distributorId = profile.generatedId;
        mapping.distributorMobile = profile.mobile;
        mapping.distributorName = profile.name;
        mapping.pins = pins;
        mapping.region = region;
        mapping.updatedAt = new Date().toISOString();
        writeList(DISTRIBUTOR_PIN_MAPPINGS_KEY, mappings);
        status.textContent = pins.length
            ? "PIN mapping saved. Matching Retailer applications will be routed to " + profile.name + "'s Distributor queue."
            : "PIN coverage removed. Existing routed applications remain available in this Distributor queue.";
        status.hidden = false;
        renderDistributorMappings();
    });

    document.getElementById("request-change").addEventListener("click", function () {
        if (!ensureCurrentOperatorAccess()) {
            return;
        }
        if (isMaster) {
            setDashboardStatus("Master Admin holds ultimate control. No system change was made by this demo.");
            return;
        }
        const approvals = readList(MASTER_APPROVALS_KEY);
        approvals.unshift({
            id: createReference("REQ"),
            description: "Critical system setting or sensitive data change (demo request)",
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

    document.getElementById("staff-signout").addEventListener("click", function () {
        sessionStorage.removeItem(STAFF_SESSION_KEY);
        window.location.assign("login.html");
    });

    window.addEventListener("storage", function (event) {
        if ([APPLICATIONS_KEY, BLOCKED_PARTNER_MOBILES_KEY, DISTRIBUTOR_PIN_MAPPINGS_KEY,
            DISTRIBUTOR_NOTIFICATIONS_KEY, OPERATORS_KEY, OPERATOR_REQUESTS_KEY,
            OPERATOR_WHITELIST_KEY, MASTER_APPROVALS_KEY, CREDENTIALS_KEY].includes(event.key)) {
            if (isDistributorMode && !ensureCurrentOperatorAccess()) {
                return;
            }
            if ([OPERATORS_KEY, OPERATOR_WHITELIST_KEY, CREDENTIALS_KEY].includes(event.key) &&
                !ensureCurrentOperatorAccess()) {
                return;
            }
            renderApplications();
            renderDistributorMappings();
            renderOperatorRequests();
            renderOperatorWhitelist();
            renderCriticalRequests();
        }
    });

    renderApplications();
    renderDistributorMappings();
    renderOperatorRequests();
    renderOperatorWhitelist();
    renderCriticalRequests();
}

function readList(key) {
    const value = localStorage.getItem(key);
    if (value === null) {
        return [];
    }
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
        throw new Error("Stored portal data for " + key + " is invalid. Clear the demo portal data and reload.");
    }
    return parsed;
}

function isPartnerMobileBlocked(mobile) {
    return readList(BLOCKED_PARTNER_MOBILES_KEY).some(function (item) {
        return item.mobile === mobile;
    }) || readList(APPLICATIONS_KEY).some(function (item) {
        return item.mobile === mobile && normalizeApplicationStatus(item) === "blocked";
    });
}

function normalizeApplicationStatus(application) {
    return String(application.status || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function findDistributorForPin(pin) {
    const applications = readList(APPLICATIONS_KEY);
    const matchingMappings = readList(DISTRIBUTOR_PIN_MAPPINGS_KEY).filter(function (item) {
        return Array.isArray(item.pins) && item.pins.includes(pin);
    });
    if (matchingMappings.length !== 1) {
        return null;
    }
    const mapping = matchingMappings[0];
    const distributor = applications.find(function (item) {
        return item.id === mapping.distributorApplicationId &&
            item.role === "distributor" && item.status === "approved" &&
            item.generatedId === mapping.distributorId;
    });
    return distributor ? {
        applicationId: distributor.id,
        generatedId: distributor.generatedId,
        mobile: distributor.mobile,
        name: distributor.name
    } : null;
}

function createDistributorQueueToken() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== "function") {
        throw new Error("Secure random generation is unavailable; the Distributor queue link was not created.");
    }
    const bytes = window.crypto.getRandomValues(new Uint8Array(24));
    return Array.from(bytes).map(function (byte) {
        return byte.toString(16).padStart(2, "0");
    }).join("");
}

function writeList(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

function findCredential(mobile) {
    return readList(CREDENTIALS_KEY).find(function (item) {
        return item.mobile === mobile;
    }) || null;
}

function findAuthorizedOperator(mobile) {
    return readList(OPERATOR_WHITELIST_KEY).find(function (item) {
        return item.mobile === mobile && item.status === "active";
    }) || null;
}

function normalizeName(name) {
    return String(name || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

async function hashSecret(secret) {
    if (secret.length > 256) {
        throw new Error("Secret must not exceed 256 characters.");
    }
    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
        throw new Error("Password protection requires a secure browser context with Web Crypto support. Open this site on localhost or HTTPS.");
    }
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const key = await window.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const bits = await window.crypto.subtle.deriveBits({
        name: "PBKDF2",
        salt: salt,
        iterations: PASSWORD_ITERATIONS,
        hash: "SHA-256"
    }, key, 256);
    return {
        algorithm: "PBKDF2-SHA-256",
        iterations: PASSWORD_ITERATIONS,
        salt: bytesToBase64(salt),
        hash: bytesToBase64(new Uint8Array(bits))
    };
}

async function verifySecret(secret, stored) {
    if (!stored || stored.algorithm !== "PBKDF2-SHA-256" ||
        !Number.isInteger(stored.iterations) || stored.iterations < 100000 ||
        stored.iterations > PASSWORD_ITERATIONS) {
        return false;
    }
    if (!window.isSecureContext || !window.crypto || !window.crypto.subtle) {
        throw new Error("Password verification requires a secure browser context with Web Crypto support.");
    }
    const salt = base64ToBytes(stored.salt);
    const key = await window.crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        "PBKDF2",
        false,
        ["deriveBits"]
    );
    const bits = await window.crypto.subtle.deriveBits({
        name: "PBKDF2",
        salt: salt,
        iterations: stored.iterations,
        hash: "SHA-256"
    }, key, 256);
    return constantTimeEqual(bytesToBase64(new Uint8Array(bits)), stored.hash);
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

function bytesToBase64(bytes) {
    let binary = "";
    bytes.forEach(function (byte) {
        binary += String.fromCharCode(byte);
    });
    return btoa(binary);
}

function base64ToBytes(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, function (character) {
        return character.charCodeAt(0);
    });
}

function constantTimeEqual(left, right) {
    if (typeof right !== "string" || left.length !== right.length) {
        return false;
    }
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) {
        difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
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
