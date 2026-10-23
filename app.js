document.addEventListener("DOMContentLoaded", function () {
    console.log("R.M Digital Centre Master Distributor Portal Loaded Successfully.");

    const currentYear = document.getElementById("current-year");
    if (currentYear) {
        currentYear.textContent = new Date().getFullYear();
    }
});
