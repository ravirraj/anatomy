const express = require("express");

const router = express.Router();

router.get("/", listUsers);
router.post("/", createUser);
router.get("/:userId", getUser);
router.put("/:userId", updateUser);
router.delete("/:userId", deleteUser);

async function listUsers(_req, res) {
  res.json([]);
}

async function createUser(_req, res) {
  res.status(201).json({});
}

async function getUser(_req, res) {
  res.json({});
}

async function updateUser(_req, res) {
  res.json({});
}

async function deleteUser(_req, res) {
  res.status(204).end();
}

module.exports = router;
