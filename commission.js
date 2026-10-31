(function () {
    "use strict";
    const TITLES = { aeps: "AEPS", micro_atm: "Micro ATM", bill_payment: "Bill payments" };
    const note = document.getElementById("commission-note");
    const container = document.getElementById("commission-tables");

    function cell(text) {
        const td = document.createElement("td");
        td.textContent = text;
        return td;
    }

    function rate(value, unit) {
        return unit === "percent" ? value + "%" : "\u20B9" + value;
    }

    function range(slab) {
        const upper = slab.maxAmount ? "\u20B9" + slab.maxAmount : "and above";
        return "\u20B9" + slab.minAmount + " - " + upper;
    }

    function table(service, slabs, showDistributor) {
        const wrap = document.createElement("div");
        const heading = document.createElement("h2");
        heading.textContent = TITLES[service] || service;
        const tbl = document.createElement("table");
        tbl.className = "oc-table";
        const head = document.createElement("tr");
        ["Service", "Amount range", "Retailer"].concat(showDistributor ? ["Distributor"] : []).forEach(function (title) {
            const th = document.createElement("th");
            th.textContent = title;
            head.appendChild(th);
        });
        tbl.appendChild(head);
        slabs.forEach(function (slab) {
            const row = document.createElement("tr");
            row.appendChild(cell(slab.label));
            row.appendChild(cell(range(slab)));
            row.appendChild(cell(rate(slab.retailerRate, slab.unit)));
            if (showDistributor) row.appendChild(cell(rate(slab.distributorRate, slab.unit)));
            tbl.appendChild(row);
        });
        wrap.append(heading, tbl);
        return wrap;
    }

    async function load() {
        try {
            const response = await fetch("/api/commission-slabs", { credentials: "same-origin" });
            if (response.status === 401 || response.status === 403) {
                note.textContent = "Please sign in as a retailer or distributor to view commission slabs.";
                return;
            }
            const data = await response.json();
            const showDistributor = data.role !== "retailer";
            const groups = {};
            data.slabs.forEach(function (slab) { (groups[slab.service] = groups[slab.service] || []).push(slab); });
            container.replaceChildren.apply(container, Object.keys(TITLES).filter(function (key) { return groups[key]; })
                .map(function (key) { return table(key, groups[key], showDistributor); }));
            note.textContent = data.published
                ? "Current commission rates. Rates may change; the portal always shows the latest."
                : "Indicative rates only. Official rates will be published by R.M Digital Centre.";
        } catch (error) {
            note.textContent = "Could not load commission slabs. Please try again.";
        }
    }

    load();
})();
