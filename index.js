const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

app.get('/kiwi', async (req, res) => {
  try {
    const { origin, destination, date, returnDate, adults, travelClass } = req.query;

    const params = {
      fly_from: origin,
      fly_to: destination,
      date_from: date,
      date_to: date,
      return_from: returnDate || '',
      return_to: returnDate || '',
      flight_type: returnDate ? 'round' : 'oneway',
      curr: 'INR',
      sort: 'price',
      adults: adults || 1,
      selected_cabins: travelClass || 'M',
      partner_market: 'us'
    };

    const options = {
      method: 'GET',
      url: 'https://kiwi-com-cheap-flights.p.rapidapi.com/v2/search',
      params,
      headers: {
        'X-RapidAPI-Key': 'YOUR_RAPIDAPI_KEY', // <--- INSERT YOUR RAPIDAPI KEY HERE
        'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
      }
    };

    const response = await axios.request(options);
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching flights:', error.message);
    res.status(error.response?.status || 500).json({
      error: 'Failed to fetch from Kiwi API',
      details: error.response?.data || error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});




