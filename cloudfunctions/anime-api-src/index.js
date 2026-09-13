const http = require("http");
const { URL } = require("url");
const tcb = require("@cloudbase/node-sdk");

// HTTP 函数必须使用显式凭证，通过环境变量注入（CLOUDBASE_APIKEY）
const ENV_ID = process.env.TCB_ENV || "dpcca-wiki-d7g0dl19y23cd30f3";
const app = tcb.init({
  env: ENV_ID,
  accessKey: process.env.CLOUDBASE_APIKEY,
});
const db = app.database();
const _ = db.command;

const COLLECTION = "anime_ratings";
const MAX_SCORE = 10;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
  });
  res.end(JSON.stringify(data));
}

function sendOptions(res) {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function parseAnimeId(url) {
  // /api/anime/:animeId/ratings 或 /api/anime/:animeId
  const m = url.pathname.match(/^\/api\/anime\/([^/]+)(\/ratings)?$/);
  return m ? m[1] : null;
}

// 提交一条评分
async function submitRating(animeId, body) {
  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 1 || score > MAX_SCORE) {
    const err = new Error(`score must be an integer between 1 and ${MAX_SCORE}`);
    err.status = 400;
    throw err;
  }
  const nickname = String(body.nickname || "").trim().slice(0, 20) || "匿名追番人";
  const comment = String(body.comment || "").trim().slice(0, 200);

  const res = await db.collection(COLLECTION).add({
    animeId,
    score,
    nickname,
    comment,
    createTime: Date.now(),
  });
  return { id: res.id, animeId, score, nickname, comment };
}

// 查询某番剧的评分汇总
async function getAnimeRatings(animeId) {
  const res = await db
    .collection(COLLECTION)
    .where({ animeId })
    .orderBy("createTime", "desc")
    .limit(100)
    .get();

  const list = res.data || [];
  const count = list.length;
  const avg =
    count > 0
      ? Math.round((list.reduce((s, r) => s + r.score, 0) / count) * 10) / 10
      : 0;
  const distribution = {};
  for (let i = 1; i <= MAX_SCORE; i++) distribution[i] = 0;
  list.forEach((r) => {
    distribution[r.score] = (distribution[r.score] || 0) + 1;
  });

  return {
    animeId,
    count,
    avg,
    distribution,
    recent: list.slice(0, 20).map((r) => ({
      id: r._id,
      score: r.score,
      nickname: r.nickname,
      comment: r.comment,
      createTime: r.createTime,
    })),
  };
}

// 全部番剧评分排行（按平均分降序）
async function getLeaderboard() {
  const agg = await db
    .collection(COLLECTION)
    .aggregate()
    .group({
      _id: "$animeId",
      avg: db.command.aggregate.avg("$score"),
      count: db.command.aggregate.sum(1),
    })
    .sort({ avg: -1, count: -1 })
    .limit(50)
    .end();

  const rows = (agg.data || []).map((r) => ({
    animeId: r._id,
    avg: Math.round(r.avg * 10) / 10,
    count: r.count,
  }));
  return { list: rows };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    return sendOptions(res);
  }

  const url = new URL(req.url || "/", "http://127.0.0.1");

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, service: "anime-api" });
    }

    if (url.pathname === "/api/ratings/leaderboard" && req.method === "GET") {
      return sendJson(res, 200, await getLeaderboard());
    }

    const animeId = parseAnimeId(url);
    if (!animeId) {
      return sendJson(res, 404, { error: "Not Found" });
    }

    if (req.method === "GET") {
      return sendJson(res, 200, await getAnimeRatings(animeId));
    }

    if (req.method === "POST") {
      const body = await readJsonBody(req);
      const created = await submitRating(animeId, body);
      return sendJson(res, 201, created);
    }

    return sendJson(res, 405, { error: "Method Not Allowed" });
  } catch (err) {
    const status = err.status || 500;
    if (status === 500) console.error("Unhandled error:", err);
    return sendJson(res, status, {
      error: status === 500 ? "Internal Server Error" : err.message,
    });
  }
});

server.listen(9000);
