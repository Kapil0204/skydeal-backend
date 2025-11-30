<!-- script.js — SkyDeal frontend -->
<script>
const BACKEND_BASE = "https://skydeal-backend.onrender.com"; // your Render URL

// Elements
const btnOpenPM = document.getElementById("btnOpenPaymentModal");
const btnSearch = document.getElementById("btnSearch");

const modal = document.getElementById("paymentModal");
const modalBackdrop = document.getElementById("paymentModalBackdrop");
const modalClose = document.getElementById("pmClose");
const pmTabs = document.getElementById("pmTabs");
const pmBody = document.getElementById("pmBody");
const pmCancel = document.getElementById("pmCancel");
const pmApply = document.getElementById("pmApply");
const pmCount = document.getElementById("pmCount");

// State
let paymentData = {
  creditCard: [],
  debitCard: [],
  wallet: [],
  upi: [],
  netBanking: [],
  emi: [],
};
let selected = new Set(); // values are strings like "creditCard::ICICI Visa"

// ---------- Modal helpers ----------
function openModal() {
  modal.classList.remove("hidden");
  modalBackdrop.classList.remove("hidden");
}
function closeModal() {
  modal.classList.add("hidden");
  modalBackdrop.classList.add("hidden");
}

// Build tabs -> when tab clicked, render a grid of checkboxes
const TYPE_LABELS = {
  creditCard: "Credit Cards",
  debitCard: "Debit Cards",
  wallet: "Wallets",
  upi: "UPI",
  netBanking: "NetBanking",
  emi: "EMI",
};

function renderTabs(activeKey = "creditCard") {
  pmTabs.innerHTML = "";
  Object.keys(TYPE_LABELS).forEach((key) => {
    const btn = document.createElement("button");
    btn.className =
      "px-3 py-1 rounded-md text-sm font-medium " +
      (key === activeKey ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-200 hover:bg-gray-600");
    btn.textContent = TYPE_LABELS[key];
    btn.addEventListener("click", () => {
      renderTabs(key);
      renderOptions(key);
    });
    pmTabs.appendChild(btn);
  });
}

function renderOptions(key) {
  const list = paymentData[key] || [];
  pmBody.innerHTML = "";
  if (!list.length) {
    pmBody.innerHTML = `<div class="text-gray-300 text-sm">No options</div>`;
    return;
  }
  const grid = document.createElement("div");
  grid.className = "grid grid-cols-2 md:grid-cols-3 gap-3";

  list.forEach((label) => {
    const id = `${key}::${label}`;
    const wrapper = document.createElement("label");
    wrapper.className =
      "flex items-center gap-2 px-3 py-2 rounded-md bg-gray-700 hover:bg-gray-600 cursor-pointer";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "form-checkbox h-4 w-4";
    cb.checked = selected.has(id);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(id);
      else selected.delete(id);
      updateSelectedCount();
    });
    const span = document.createElement("span");
    span.className = "text-gray-100 text-sm";
    span.textContent = label;
    wrapper.appendChild(cb);
    wrapper.appendChild(span);
    grid.appendChild(wrapper);
  });

  pmBody.appendChild(grid);
}

function updateSelectedCount() {
  const count = selected.size;
  pmCount.textContent = count ? `${count} selected` : "Select Payment Methods";
}

// Expose selections for search
function getSelectedPaymentFilters() {
  // returns { creditCard: ["ICICI Visa", ...], debitCard: [...], ... }
  const out = { creditCard: [], debitCard: [], wallet: [], upi: [], netBanking: [], emi: [] };
  for (const key of selected) {
    const [type, label] = key.split("::");
    if (out[type]) out[type].push(label);
  }
  return out;
}
window.getSelectedPaymentFilters = getSelectedPaymentFilters;

// ---------- Fetch methods ----------
async function fetchPaymentMethods() {
  const url = `${BACKEND_BASE}/api/payment-methods`;
  const r = await fetch(url);
  const data = await r.json();
  // data = { creditCard:[], debitCard:[], wallet:[], upi:[], netBanking:[], emi:[] }
  paymentData = data || paymentData;
}

// ---------- Wire up ----------
btnOpenPM?.addEventListener("click", async () => {
  await fetchPaymentMethods();
  renderTabs("creditCard");
  renderOptions("creditCard");
  openModal();
});

pmCancel?.addEventListener("click", () => {
  closeModal();
});

pmApply?.addEventListener("click", () => {
  // update button label and close
  updateSelectedCount();
  closeModal();
});

modalClose?.addEventListener("click", () => closeModal());
modalBackdrop?.addEventListener("click", () => closeModal());

// ---------- Search (stub – calls backend; integrate your UI render) ----------
btnSearch?.addEventListener("click", async () => {
  const from = document.getElementById("fromInput")?.value?.trim()?.toUpperCase();
  const to = document.getElementById("toInput")?.value?.trim()?.toUpperCase();
  const dep = document.getElementById("departureDateInput")?.value;   // YYYY-MM-DD
  const ret = document.getElementById("returnDateInput")?.value || dep;
  const pax = parseInt(document.getElementById("passengersSelect")?.value || "1", 10);
  const cabin = document.getElementById("classSelect")?.value || "Economy";

  const filters = getSelectedPaymentFilters(); // you can send this later to price popup logic

  try {
    // optional: show loading state
    const r = await fetch(`${BACKEND_BASE}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to,
        departureDate: dep,
        returnDate: ret,
        passengers: pax,
        travelClass: cabin,
        currency: "INR",
        region: "IN",
        paymentFilters: filters, // kept for next milestone
      }),
    });
    const data = await r.json();
    // TODO: render results into the two flight panels (outbound/return)
    console.log("search results", data);
  } catch (e) {
    console.error("search error", e);
  }
});

// Initial label
updateSelectedCount();
</script>
