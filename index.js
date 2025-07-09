const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());

app.get("/", (req, res) => {
  res.send("SkyDeal backend is live");
});

app.get("/kiwi", async (req, res) => {
  const { origin, destination, date } = req.query;

  if (!origin || !destination || !date) {
    return res.status(400).json({ error: "Missing required query parameters" });
  }

  const options = {
    method: 'GET',
    url: 'https://kiwi-com.p.rapidapi.com/v2/search',
    params: {
      fly_from: origin,
      fly_to: destination,
      date_from: date,
      date_to: date,
      one_for_city: 1,
      curr: 'INR',
      limit: 10
    },
    headers: {
      'X-RapidAPI-Key': process.env.RAPIDAPI_KEY,
      'X-RapidAPI-Host': 'kiwi-com.p.rapidapi.com'
    }
  };

  try {
    const response = await axios.request(options);
    res.json(response.data);
  } catch (error) {
    console.error("Kiwi API fetch failed:", error.message);
    res.status(500).json({ error: "Failed to fetch from Kiwi API" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
