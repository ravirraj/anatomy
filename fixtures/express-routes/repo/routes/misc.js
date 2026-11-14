const express = require("express");

const router = express.Router();

router.get("/misc", miscStatus);

function miscStatus(_req, res) {
  res.json({});
}

module.exports = router;
