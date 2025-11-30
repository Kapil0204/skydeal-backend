// script.js
const API_BASE = 'https://skydeal-backend.onrender.com';

// UI elements
const fromInput = document.getElementById('fromInput');
const toInput = document.getElementById('toInput');
const departDate = document.getElementById('departDate');
const returnDate = document.getElementById('returnDate');
const paxSelect = document.getElementById('paxSelect');
const cabinSelect = document.getElementById('cabinSelect');
const tripOneWay = document.getElementById('tripOneWay');
const tripRound = document.getElementById('tripRound');

const searchBtn = document.getElementById('searchBtn');
const outboundList = document.getElementById('outboundList');
const returnList = document.getElementById('returnList');

const paymentBtn = document.getElementById('paymentSelectBtn');
const paymentBtnLabel = document.getElementById('paymentSelectBtnLabel');
const pmOverlay = document.getElementById('paymentOverlay');
const pmModal = document.getElementById('paymentModal');

const tabButtons = [...document.querySelectorAll('.pm-tab')];
const listCredit = document.getElementById('pm-list-credit');
const listDebit = document.getElementById('pm-list-debit');
const listWallet = document.getElementById('pm-list-wallet');
const listUPI = document.getElementById('pm-list-upi');
const listNet = document.getElementById('pm-list-netbanking');
const listEMI = document.getElementById('pm-list-emi');
const pmClear = document.getElementById('pmClearBtn');
const pmDone = document.getElementById('pmDoneBtn');

// selected payment methods
let selectedPM = []; // [{type:'credit', label:'HDFC'}...]

// map UI tab → API key in /payment-options
const TAB_TO_APIKEY = {
  creditCard: 'CreditCard',
  debitCard: 'DebitCard',
  wallet: 'Wallet',
  upi: 'UPI',
  netBanking: 'NetBanking',
  emi: 'EMI'
};

// get active UI tab key
function activeTabKey() {
  const b = tabButtons.find(x => x.classList.contains('pm-tab-active'));
  return b?.dataset.pmTab || 'creditCard';
}

// show/hide modal
function openModal() { pmOverlay.classList.remove('hidden'); pmModal.classList.remove('hidden'); }
function closeModal() { pmOverlay.classList.add('hidden'); pmModal.classList.add('hidden'); }

// load payment options from backend and render in current tab
async function loadPaymentOptions() {
  const r = await fetch(`${API_BASE}/payment-options`);
  const data = await r.json();
  const opts = data?.options || {};

  const renderList = (ul, items, type) => {
    ul.innerHTML = '';
    if (!items || items.length === 0) {
      ul.innerHTML = `<li class="pm-empty">No options available.</li>`;
      return;
    }
    items.forEach(label => {
      const id = `${type}:${label}`;
      const checked = selectedPM.some(s => s.type === type && s.label === label);
      const li = document.createElement('li');
      li.className = 'pm-item';
      li.innerHTML = `
        <input type="checkbox" id="${id}" ${checked ? 'checked':''}/>
        <label for="${id}">${label}</label>
      `;
      li.querySelector('input').addEventListener('change', (e) => {
        if (e.target.checked) {
          selectedPM.push({ type, label });
        } else {
          selectedPM = selectedPM.filter(s => !(s.type === type && s.label === label));
        }
        updatePaymentButtonLabel();
      });
      ul.appendChild(li);
    });
  };

  renderList(listCredit, opts.CreditCard, 'credit');
  renderList(listDebit,  opts.DebitCard,  'debit');
  renderList(listWallet, opts.Wallet,     'wallet');
  renderList(listUPI,    opts.UPI,        'upi');
  renderList(listNet,    opts.NetBanking, 'netbanking');
  renderList(listEMI,    opts.EMI,        'emi');
}

// tab switching
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    tabButtons.forEach(b => b.classList.remove('pm-tab-active'));
    btn.classList.add('pm-tab-active');

    document.querySelectorAll('[data-pm-panel]').forEach(p => p.classList.add('hidden'));
    document.querySelector(`[data-pm-panel="${btn.dataset.pmTab}"]`).classList.remove('hidden');
  });
});

function updatePaymentButtonLabel() {
  if (!selectedPM.length) {
    paymentBtnLabel.textContent = 'Select Payment Methods';
  } else {
    paymentBtnLabel.textContent = `${selectedPM.length} selected`;
  }
}

paymentBtn.addEventListener('click', async () => {
  await loadPaymentOptions();
  openModal();
});
pmOverlay.addEventListener('click', closeModal);
pmClear.addEventListener('click', () => { selectedPM = []; updatePaymentButtonLabel(); loadPaymentOptions(); });
pmDone.addEventListener('click', closeModal);

// trip toggle controls return date enable
function syncTripUI() {
  if (tripOneWay.checked) {
    returnDate.disabled = true;
    returnDate.value = '';
  } else {
    returnDate.disabled = false;
  }
}
tripOneWay.addEventListener('change', syncTripUI);
tripRound.addEventListener('change', syncTripUI);
syncTripUI();

// render flight cards
function renderFlights(container, flights) {
  if (!flights || flights.length === 0) {
    container.classList.add('empty');
    container.innerHTML = 'No flights';
    return;
  }
  container.classList.remove('empty');
  container.innerHTML = flights.map(f => `
    <div class="flight-card">
      <div class="fc-title">${f.airlineName} <span style="opacity:.75">${f.flightNumber}</span></div>
      <div class="fc-time">${f.departure} → ${f.arrival} • Stops: ${f.stops}</div>
      <div class="fc-price">₹${f.price}</div>
      <details style="margin-top:6px">
        <summary>Portal prices (+₹250 markup)</summary>
        <ul style="margin-top:6px">
          ${f.portalPrices.map(p => `<li>${p.portal}: ₹${p.finalPrice}</li>`).join('')}
        </ul>
      </details>
    </div>
  `).join('');
}

// search click
searchBtn.addEventListener('click', async () => {
  searchBtn.disabled = true;

  const body = {
    from: (fromInput.value || 'BOM').trim().toUpperCase(),
    to:   (toInput.value   || 'DEL').trim().toUpperCase(),
    departureDate: departDate.value || new Date().toISOString().slice(0,10),
    returnDate: tripRound.checked ? (returnDate.value || '') : '',
    passengers: Number(paxSelect.value || 1),
    travelClass: (cabinSelect.value || 'Economy'),
    tripType: tripRound.checked ? 'round-trip' : 'one-way',
    paymentMethods: selectedPM.map(s => ({ bank: s.label, type: s.type }))
  };

  try {
    const r = await fetch(`${API_BASE}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();

    renderFlights(outboundList, data.outboundFlights);
    renderFlights(returnList, data.returnFlights);
  } catch (e) {
    console.error(e);
    outboundList.classList.add('empty');
    outboundList.textContent = 'Error fetching flights';
    returnList.classList.add('empty');
    returnList.textContent = 'Error fetching flights';
  } finally {
    searchBtn.disabled = false;
  }
});
