const express = require("express");

const router = express.Router();

router.get("/posts", listPosts);
router.get("/posts", listPostsCached);
router.post("/posts", createPost);
router.patch("/posts/:postId", patchPost);
router.options("/posts", postOptions);
router.head("/posts", postHead);
router.all("/ping", ping);
router.get(["/archive", "/feed"], listArchived);
router.get(unlistedPath, showUnlisted);
router.delete(`/posts/${"draft"}`, deleteDraft);

const unlistedPath = "/unlisted";

function listPosts(_req, res) {
  res.json([]);
}

function listPostsCached(_req, res) {
  res.json([]);
}

function createPost(_req, res) {
  res.status(201).json({});
}

function patchPost(_req, res) {
  res.json({});
}

function postOptions(_req, res) {
  res.status(204).end();
}

function postHead(_req, res) {
  res.end();
}

function ping(_req, res) {
  res.json({ pong: true });
}

function listArchived(_req, res) {
  res.json([]);
}

function showUnlisted(_req, res) {
  res.json({});
}

function deleteDraft(_req, res) {
  res.status(204).end();
}

module.exports = router;
