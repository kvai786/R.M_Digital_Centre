"use strict";

(function () {
    async function loadCampaign() {
        const banner = document.getElementById("growth-campaign");
        if (!banner) return;
        try {
            const response = await fetch("/api/public/growth-campaign", { credentials: "same-origin", cache: "no-store" });
            if (!response.ok) throw new Error("Campaign details could not be loaded.");
            const campaign = await response.json();
            if (!campaign.active) return;
            const badge = document.getElementById("dynamic-trend-badge");
            const campaignTerms = campaign.title + " " + campaign.message;
            if (badge && /zero joining fee/i.test(campaignTerms) && /\bearly\b/i.test(campaignTerms)) {
                badge.hidden = false;
            }

            const title = document.createElement("strong");
            title.textContent = campaign.title;
            const message = document.createElement("span");
            message.textContent = campaign.message;
            const region = document.createElement("small");
            region.textContent = "For " + campaign.region + ". Applications remain subject to review and service-area coverage.";
            const links = document.createElement("div");
            links.className = "growth-campaign-actions";
            for (const [role, label] of [["retailer", "Apply as Retailer"], ["distributor", "Apply as Distributor"]]) {
                const link = document.createElement("a");
                link.className = "btn primary";
                link.href = "/register.html?role=" + role;
                link.textContent = label;
                links.append(link);
            }
            banner.replaceChildren(title, message, region, links);
            banner.hidden = false;
        } catch (error) {
            console.warn("The current onboarding campaign is unavailable.", error);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", loadCampaign);
    } else {
        loadCampaign();
    }
})();
