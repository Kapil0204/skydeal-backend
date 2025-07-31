import express from 'express';
import cors from 'cors';
import axios from 'axios';
import dotenv from 'dotenv';
import { MongoClient } from 'mongodb';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// -----------------------------
// MongoDB Connection
// -----------------------------
const mongoUri = process.env.MONGODB_URI;
const client = new MongoClient(mongoUri);
let offersCollection;

async function connectDB() {
  try {
    await client.connect();
    const db = client.db('skydeal');
    offersCollection = db.collection('offers');
    console.log('✅ Connected to MongoDB');
  } catch (err) {
    console.error('❌ MongoDB connection error:', err.message);
  }
}
connectDB();

// -----------------------------
// Amadeus Flight Search Endpoint
// -----------------------------
app.post('/search', async (req, res) => {
  const { from, to, departureDate, passengers, travelClass } = req.body;

  try {
    const response = await axios.post('https://test.api.amadeus.com/v1/shopping/flight-offers', {
      currencyCode: 'INR',
      originLocationCode: from,
      destinationLocationCode: to,
      departureDate,
      adults: passengers,
      travelClass,
      nonStop: false,
      max: 10
    }, {
      headers: {
        Authorization: `Bearer ${process.env.AMADEUS_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    const offers = response.data.data || [];

    const flights = offers.map((offer, index) => {
      const segment = offer.itineraries[0].segments[0];
      const price = parseFloat(offer.price.total);
      const airlineCode = segment.carrierCode;
      const flightNumber = segment.number;
      const departure = segment.departure.at;
      const arrival = segment.arrival.at;

      return {
        id: index,
        airline: airlineCode,
        flightNumber,
        departureTime: departure,
        arrivalTime: arrival,
        basePrice: price
      };
    });

    res.json({ flights });
  } catch (err) {
    console.error('❌ Amadeus error:', err.message);
    res.status(500).json({ error: 'Failed to fetch flight data' });
  }
});

// -----------------------------
// Simulated OTA Price Modal
// -----------------------------
app.post('/simulate-ota-prices', (req, res) => {
  const { basePrice } = req.body;
  const markup = 100;

  const simulatedPrices = [
    { ota: 'MakeMyTrip', price: basePrice + markup },
    { ota: 'Goibibo', price: basePrice + markup },
    { ota: 'EaseMyTrip', price: basePrice + markup },
    { ota: 'Yatra', price: basePrice + markup },
    { ota: 'Cleartrip', price: basePrice + markup }
  ];

  res.json(simulatedPrices);
});

// -----------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
