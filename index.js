import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ----------------------
// Utility: Remove Exact Duplicates
// ----------------------
function removeExactDuplicates(flights) {
  const seen = new Set();
  return flights.filter(flight => {
    const key = `${flight.flightName}-${flight.departure}-${flight.arrival}-${flight.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ----------------------
// Real Flights via Amadeus
// ----------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

  const amadeusUrl = 'https://test.api.amadeus.com/v2/shopping/flight-offers';

  const params = {
    originLocationCode: from,
    destinationLocationCode: to,
    departureDate,
    adults: passengers,
    travelClass,
    currencyCode: 'INR',
    nonStop: false,
    max: 250
  };

  if (tripType === 'round-trip' && returnDate) {
    params.returnDate = returnDate;
  }

  try {
    const response = await axios.get(amadeusUrl, {
      params,
      headers: {
        Authorization: `Bearer ${process.env.AMADEUS_ACCESS_TOKEN}`
      }
    });

    const data = response.data;

    const outboundFlights = removeExactDuplicates(
      data.data.map(flight => ({
        flightName: flight.validatingAirlineCodes[0] + ' ' + flight.itineraries[0].segments[0].number,
        departure: flight.itineraries[0].segments[0].departure.at.slice(11, 16),
        arrival: flight.itineraries[0].segments[0].arrival.at.slice(11, 16),
        price: parseFloat(flight.price.total)
      }))
    );

    const returnFlights = tripType === 'round-trip'
      ? removeExactDuplicates(
          data.data.map(flight => {
            const segment = flight.itineraries[1]?.segments[0];
            if (!segment) return null;
            return {
              flightName: flight.validatingAirlineCodes[0] + ' ' + segment.number,
              departure: segment.departure.at.slice(11, 16),
              arrival: segment.arrival.at.slice(11, 16),
              price: parseFloat(flight.price.total)
            };
          }).filter(f => f)
        )
      : [];

    res.json({ outboundFlights, returnFlights });

  } catch (error) {
    console.error('Error fetching flights:', error.message);
    res.status(500).json({ error: 'Failed to fetch flights' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
