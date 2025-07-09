const express = require("express");
const axios = require("axios");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "kiwi.com";

app.get("/kiwi", async (req, res) => {
  const { origin, destination, date, adults = 1, travelClass = "M" } = req.query;

  try {
    const response = await axios.get("https://kiwi-com.p.rapidapi.com/v2/search", {
      headers: {
        "X-RapidAPI-Key": RAPIDAPI_KEY,
        "X-RapidAPI-Host": "kiwi-com.p.rapidapi.com",
      },
      params: {
        fly_from: origin,
        fly_to: destination,
        date_from: date,
        date_to: date,
        curr: "INR",
        adults,
        selected_cabins: travelClass,
        one_for_city: 0,
        max_stopovers: 1
      },
    });

    res.json(response.data);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch from Kiwi API" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

