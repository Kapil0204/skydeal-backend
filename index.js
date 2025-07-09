const form = document.getElementById('flight-form');
const resultsContainer = document.getElementById('results');
const tripTypeInputs = document.getElementsByName('tripType');
const returnDateContainer = document.getElementById('return-date-container');

tripTypeInputs.forEach(input => {
  input.addEventListener('change', () => {
    returnDateContainer.style.display = input.value === 'roundtrip' ? 'block' : 'none';
  });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const origin = document.getElementById('origin').value;
  const destination = document.getElementById('destination').value;
  const date = document.getElementById('departure-date').value;
  const tripType = document.querySelector('input[name="tripType"]:checked').value;

  let url = `https://skydeal-backend.onrender.com/kiwi?origin=${origin}&destination=${destination}&date=${date}`;
  if (tripType === 'roundtrip') {
    const returnDate = document.getElementById('return-date').value;
    url += `&returnDate=${returnDate}`;
  }

  try {
    const res = await fetch(url);
    const data = await res.json();

    const itineraries = data.data || data.itineraries || [];
    const carriers = data.carriers || [];
    const carrierMap = new Map();
    carriers.forEach(c => carrierMap.set(c.code, c.name));

    resultsContainer.innerHTML = '';

    if (itineraries.length === 0) {
      resultsContainer.innerHTML = '<p>No flights found.</p>';
      return;
    }

    itineraries.forEach(flight => {
      const carrierCode = flight.validatingCarrier || flight.carrier || 'N/A';
      const airline = carrierMap.get(carrierCode) || "Unknown Airline";
      const departure = flight.departureTime || flight.departure || "N/A";
      const arrival = flight.arrivalTime || flight.arrival || "N/A";
      const price = flight.price || flight.priceAmount || 'N/A';

      const card = document.createElement('div');
      card.className = 'flight-card';
      card.innerHTML = `
        <h3>✈️ ${airline}</h3>
        <p><strong>Departure:</strong> ${departure}</p>
        <p><strong>Arrival:</strong> ${arrival}</p>
        <p><strong>Price:</strong> ₹${price}</p>
      `;
      resultsContainer.appendChild(card);
    });
  } catch (err) {
    resultsContainer.innerHTML = '<p>Something went wrong. Try again.</p>';
    console.error(err);
  }
});



