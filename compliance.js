(function () {
    "use strict";
    const grid = document.getElementById("credential-grid");
    const empty = document.getElementById("credential-empty");
    const year = document.getElementById("current-year");
    if (year) year.textContent = String(new Date().getFullYear());

    function card(item) {
        const article = document.createElement("article");
        article.className = "credential-card";
        const title = document.createElement("h3");
        title.textContent = item.title;
        const issuer = document.createElement("p");
        issuer.textContent = "Issued by " + item.issuer;
        const id = document.createElement("p");
        const label = document.createElement("strong");
        label.textContent = item.idLabel + ": ";
        id.append(label, document.createTextNode(item.id));
        article.append(title, issuer, id);
        // Only link to https verification pages.
        if (/^https:\/\//i.test(item.verifyUrl || "")) {
            const link = document.createElement("a");
            link.href = item.verifyUrl;
            link.rel = "noopener noreferrer";
            link.target = "_blank";
            link.textContent = "Verify with issuer";
            article.append(link);
        }
        return article;
    }

    fetch("credentials.json", { cache: "no-cache" })
        .then(function (response) { return response.json(); })
        .then(function (data) {
            const shown = (data.credentials || []).filter(function (item) { return item.verified === true && item.id; });
            grid.replaceChildren.apply(grid, shown.map(card));
            empty.hidden = shown.length > 0;
        })
        .catch(function () { empty.hidden = false; });
})();
