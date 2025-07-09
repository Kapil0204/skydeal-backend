const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;

app.get("/kiwi", async (req, res) => {
  const { origin, destination, date } = req.query;

  const options = {
    method: 'GET',
    url: 'https://kiwi-com-cheap-flights.p.rapidapi.com/cheap',
    params: {
      from: origin,
      to: destination,
      date: date,
      partner: 'picky',
      currency: 'INR'
    },
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'kiwi-com-cheap-flights.p.rapidapi.com'
    }
  };

  try {
    const response = await axios.request(options);
    res.json(response.data);
  } catch (error) {
    console.error("Kiwi API error:", error.message);
    res.status(500).json({ error: "Failed to fetch from Kiwi API" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});


