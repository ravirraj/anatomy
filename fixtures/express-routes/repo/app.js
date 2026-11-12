const express = require("express");
const apiRouter = require("./routes/index");
const postsRouter = require("./routes/posts");
const miscRouter = require("./routes/misc");

const miscMount = process.env.MISC_MOUNT || "/misc";

const app = express();

app.get("/health", healthCheck);
app.get("/users/:userId/posts/:postId", showUserPost);
app.delete("/sessions/:sessionId", endSession);
app.use("/api", apiRouter);
app.use("/api", postsRouter);
app.use(miscMount, miscRouter);

function healthCheck(_req, res) {
  res.json({ ok: true });
}

function showUserPost(_req, res) {
  res.json({});
}

function endSession(_req, res) {
  res.status(204).end();
}

app.listen(3000);
