import express from 'express';
import cors from 'cors';
import axios from 'axios';
import cheerio from 'cheerio';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables from .env

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ----------------------
// Simulated Flight Data
// ----------------------
app.post('/simulated-flights', (req, res) => {
  const { from, to, departureDate, returnDate, passengers, travelClass, paymentMethods, tripType } = req.body;

  const bestDeals = {
    'ICICI Bank': { portal: 'MakeMyTrip', offer: '10% off', code: 'SKYICICI10', price: 4900 },
    'HDFC Bank': { portal: 'Goibibo', offer: '12% off', code: 'HDFCFLY12', price: 4750 },
    'SBI Card': { portal: 'EaseMyTrip', offer: '₹500 off', code: 'SBIFLY500', price: 5100 },
    'Axis Bank': { portal: 'Cleartrip', offer: '15% off', code: 'AXISAIR15', price: 4600 },
  };

  const sampleFlights = [
    {
      flightName: "IndiGo",
      departureTime: "06:00",
      arrivalTime: "08:00",
      basePrice: 5500,
      bestDeal: bestDeals[paymentMethods[0]] || null
    },
    {
      flightName: "SpiceJet",
      departureTime: "09:30",
      arrivalTime: "11:45",
      basePrice: 5800,
      bestDeal: bestDeals[paymentMethods[0]] || null
    }
  ];

  const returnFlights = [
    {
      flightName: "Air India Express",
      departureTime: "18:00",
      arrivalTime: "20:15",
      basePrice: 5300,
      bestDeal: bestDeals[paymentMethods[0]] || null
    },
    {
      flightName: "Akasa Air",
      departureTime: "21:00",
      arrivalTime: "23:20",
      basePrice: 5600,
      bestDeal: bestDeals[paymentMethods[0]] || null
    }
  ];

  res.json({
    outbound: sampleFlights,
    return: tripType === 'round' ? returnFlights : []
  });
});

// ---------------------------------
// Scraping Route for MMT Flight Offers
// ---------------------------------
app.get('/scrape-mmt-offers', async (req, res) => {
  try {
    const url = 'https://www.makemytrip.com/promos/flight-offers.html';
    const proxyUrl = `http://api.scraperapi.com?api_key=${process.env.SCRAPERAPI_KEY}&url=${encodeURIComponent(url)}`;

    const response = await axios.get(proxyUrl);
    const $ = cheerio.load(response.data);

    const offers = [];

    $('.offer-content').each((i, el) => {
      const text = $(el).text();
      const title = $(el).find('.offer-title').text().trim();
      const codeMatch = text.match(/code\s*[:\-–]?\s*([A-Z0-9]+)/i);
      const bankMatch = text.match(/ICICI|HDFC|SBI|AXIS|IndusInd|RBL|Kotak|Standard Chartered/i);
      const categoryMatch = text.match(/flight|fly|air/i);

      if (categoryMatch) {
        offers.push({
          title: title || 'No title',
          offerText: text.trim().replace(/\s+/g, ' ').substring(0, 300),
          code: codeMatch ? codeMatch[1] : 'N/A',
          bank: bankMatch ? bankMatch[0] : 'General'
        });
      }
    });

    res.json({ offers });
  } catch (error) {
    res.status(500).json({ error: 'Scraping failed', details: error.message });
  }
});

// ----------------------
// Start Server
// ----------------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
