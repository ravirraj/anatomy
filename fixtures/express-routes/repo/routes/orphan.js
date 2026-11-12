const express = require("express");

const router = express.Router();

router.get("/secret", showSecret);
router.post("/secret", makeSecret);

function showSecret(_req, res) {
  res.json({});
}

function makeSecret(_req, res) {
  res.status(201).json({});
}

module.exports = router;
