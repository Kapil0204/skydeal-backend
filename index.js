import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.send('SkyDeal backend is live');
});

app.post("/search", async (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, tripType } = req.body;

  try {
    // Step 1: Get Amadeus access token
    const tokenRes = await axios.post("https://test.api.amadeus.com/v1/security/oauth2/token",
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.AMADEUS_CLIENT_ID,
        client_secret: process.env.AMADEUS_CLIENT_SECRET
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      }
    );

    const accessToken = tokenRes.data.access_token;
    console.log("✅ Amadeus token acquired");

    // Step 2: Fetch flight offers
    const flightRes = await axios.get("https://test.api.amadeus.com/v2/shopping/flight-offers", {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        originLocationCode: from,
        destinationLocationCode: to,
        departureDate,
        returnDate: tripType === 'round-trip' ? returnDate : undefined,
        adults: passengers,
        travelClass,
        currencyCode: "INR",
        max: 50
      }
    });

    const offers = flightRes.data.data || [];

    // 🔍 Debug log: Raw offers from Amadeus
    console.log("🔍 RAW Amadeus offers:\n", JSON.stringify(offers, null, 2));

    // Step 3: Format outbound flights
    const formatFlight = (offer, legIndex = 0) => {
      const itinerary = offer.itineraries[legIndex];
      if (!itinerary || !itinerary.segments || itinerary.segments.length === 0) return null;

      const segments = itinerary.segments;
      const firstSegment = segments[0];
      const lastSegment = segments[segments.length - 1];
      const stops = segments.length - 1;

      return {
        flightNumber: firstSegment.carrierCode + " " + firstSegment.number,
        airlineName: offer.validatingAirlineCodes[0] || firstSegment.carrierCode,
        departure: firstSegment.departure.at.slice(11, 16),
        arrival: lastSegment.arrival.at.slice(11, 16),
        price: offer.price.total,
        stops
      };
    };

    // Step 4: Deduplicate by flightNumber + departure time
    const dedupeFlights = (flights) => {
      const seen = new Set();
      return flights.filter(flight => {
        if (!flight) return false;
        const key = `${flight.flightNumber}-${flight.departure}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

    const outboundFlights = dedupeFlights(
      offers.map(offer => formatFlight(offer, 0))
    );

    const returnFlights = tripType === "round-trip"
      ? dedupeFlights(
          offers.map(offer => formatFlight(offer, 1)).filter(f => f !== null)
        )
      : [];

    res.json({ outboundFlights, returnFlights });

  } catch (err) {
    console.error("❌ Error in /search:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch flights" });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 SkyDeal backend running on port ${PORT}`);
});
