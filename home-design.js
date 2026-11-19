"use strict";

(function () {
    const FONT_CLASSES = ["rm-font-system", "rm-font-humanist", "rm-font-rounded", "rm-font-classic"];
    const THEME_CLASSES = [
        "rm-home-standard", "rm-home-festive", "rm-home-monsoon",
        "rm-home-summer", "rm-home-winter", "rm-home-trend",
    ];

    function applyDesign(config) {
        const root = document.documentElement;
        root.classList.remove.apply(root.classList, FONT_CLASSES.concat(THEME_CLASSES));
        const theme = config && THEME_CLASSES.includes("rm-home-" + config.theme) ? config.theme : "standard";
        const font = config && FONT_CLASSES.includes("rm-font-" + config.font) ? config.font : "system";
        root.classList.add("rm-home-" + theme, "rm-font-" + font);
    }

    async function load() {
        if (new URLSearchParams(window.location.search).has("design-preview")) {
            try {
                const preview = JSON.parse(sessionStorage.getItem("rm-homepage-preview") || "null");
                if (preview) {
                    applyDesign(preview);
                    sessionStorage.removeItem("rm-homepage-preview");
                    return;
                }
            } catch (error) {
                sessionStorage.removeItem("rm-homepage-preview");
            }
        }
        try {
            const response = await fetch("/api/public/homepage-design", {
                credentials: "same-origin",
                cache: "no-store",
            });
            if (!response.ok) { throw new Error("Homepage design is unavailable."); }
            applyDesign(await response.json());
        } catch (error) {
            console.warn("Using the standard homepage design.", error);
            applyDesign({ theme: "standard", font: "system" });
        }
    }

    window.RMHomeDesign = { apply: applyDesign };
    load();
}());
