"use strict";

(function () {
    let activePrompt = null;

    function csrfToken() {
        const match = document.cookie.match(/(?:^|; )rm_csrf=([^;]*)/);
        return match ? decodeURIComponent(match[1]) : "";
    }

    function requestAdminStepUp() {
        if (activePrompt) {
            return activePrompt;
        }

        activePrompt = new Promise(function (resolve) {
            const dialog = document.createElement("dialog");
            dialog.className = "admin-step-up-dialog";
            dialog.setAttribute("aria-labelledby", "admin-step-up-title");
            dialog.setAttribute("aria-describedby", "admin-step-up-description");

            const heading = document.createElement("h2");
            heading.id = "admin-step-up-title";
            heading.textContent = "Verify this admin action";
            const description = document.createElement("p");
            description.id = "admin-step-up-description";
            description.textContent = "Confirm your current password and authenticator code. This verification is single-use and expires in five minutes.";
            const form = document.createElement("form");
            const passwordLabel = document.createElement("label");
            passwordLabel.textContent = "Current password";
            const password = document.createElement("input");
            password.type = "password";
            password.autocomplete = "current-password";
            password.maxLength = 128;
            password.required = true;
            passwordLabel.append(password);
            const codeLabel = document.createElement("label");
            codeLabel.textContent = "6-digit authenticator code";
            const code = document.createElement("input");
            code.type = "text";
            code.inputMode = "numeric";
            code.pattern = "[0-9]{6}";
            code.maxLength = 6;
            code.autocomplete = "one-time-code";
            code.required = true;
            codeLabel.append(code);
            const status = document.createElement("p");
            status.className = "admin-step-up-status";
            status.setAttribute("role", "status");
            status.setAttribute("aria-live", "polite");
            const actions = document.createElement("div");
            actions.className = "admin-step-up-actions";
            const cancel = document.createElement("button");
            cancel.type = "button";
            cancel.textContent = "Cancel";
            const verify = document.createElement("button");
            verify.type = "submit";
            verify.textContent = "Verify and continue";
            actions.append(cancel, verify);
            form.append(passwordLabel, codeLabel, status, actions);
            dialog.append(heading, description, form);

            let finished = false;
            function closePrompt(token) {
                if (finished) {
                    return;
                }
                finished = true;
                dialog.close();
                dialog.remove();
                activePrompt = null;
                resolve(token);
            }

            dialog.addEventListener("close", function () {
                if (!finished) {
                    finished = true;
                    dialog.remove();
                    activePrompt = null;
                    resolve(null);
                }
            });
            cancel.addEventListener("click", function () { closePrompt(null); });
            form.addEventListener("submit", async function (event) {
                event.preventDefault();
                verify.disabled = true;
                status.textContent = "";
                try {
                    const response = await fetch("/api/auth/admin-step-up", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: {
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                            "X-CSRF-Token": csrfToken(),
                        },
                        body: JSON.stringify({ password: password.value, code: code.value }),
                    });
                    const result = await response.json().catch(function () { return {}; });
                    if (!response.ok) {
                        const detail = Array.isArray(result.detail)
                            ? result.detail.map(function (item) { return item.msg; }).join("; ")
                            : result.detail;
                        throw new Error(detail || "Verification failed. Try again.");
                    }
                    if (typeof result.stepUpToken !== "string" || !result.stepUpToken) {
                        throw new Error("The server did not issue a verification token.");
                    }
                    closePrompt(result.stepUpToken);
                } catch (error) {
                    status.textContent = error.message || "Verification failed. Try again.";
                    password.focus();
                } finally {
                    if (!finished) {
                        verify.disabled = false;
                    }
                }
            });

            document.body.append(dialog);
            if (typeof dialog.showModal !== "function") {
                dialog.remove();
                activePrompt = null;
                resolve(null);
                return;
            }
            dialog.showModal();
            password.focus();
        });
        return activePrompt;
    }

    window.requestAdminStepUp = requestAdminStepUp;
}());
