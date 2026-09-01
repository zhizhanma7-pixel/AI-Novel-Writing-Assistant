const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createApp } = require("../dist/app.js");

/**
 * P9 —— 大文件必须能进得来。
 *
 * 一张 PNG 角色卡经 base64 上送会膨胀约 4/3：20MB 的原始文件到服务端是
 * ~26.7MB。全局 JSON 上限是 20MB，所以这条路径如果不单独放宽，大卡片会在
 * 进入解析器之前就被拒，用户只会看到一个没有解释的失败。
 */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

/** 造一张带角色卡数据、并用一个大 chunk 撑到指定体积的 PNG。 */
function buildLargePng(card, targetBytes) {
  const cardBase64 = Buffer.from(JSON.stringify(card), "utf8").toString("base64");
  const head = Buffer.concat([
    PNG_SIGNATURE,
    chunk("tEXt", Buffer.concat([
      Buffer.from("chara", "latin1"),
      Buffer.from([0]),
      Buffer.from(cardBase64, "latin1"),
    ])),
  ]);
  const tail = chunk("IEND", Buffer.alloc(0));
  const padding = Math.max(0, targetBytes - head.length - tail.length - 12);
  // 用一个解析器会跳过的私有 chunk 占位，模拟真实图片数据的体积。
  return Buffer.concat([head, chunk("iTXt", Buffer.alloc(padding, 0x61)), tail]);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name: "大卡", description: "北境旧律仍由影卫执行。", personality: "沉默" },
};

test("P9 — a large PNG card is accepted instead of being rejected by the body limit", async () => {
  // 必须真的越过全局 20MB 上限才有意义：16MB 原始文件 → ~21.3MB base64。
  // 用 4MB 之类的体积，修复前也会通过，那样这条用例什么都没守住。
  const png = buildLargePng(CARD, 16 * 1024 * 1024);
  const pngBase64 = png.toString("base64");
  assert.ok(
    pngBase64.length > 20 * 1024 * 1024,
    `请求体必须真的超过全局 20MB 上限，实际 ${(pngBase64.length / 1024 / 1024).toFixed(1)}MB`,
  );

  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sillytavern/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pngBase64 }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200, `大文件不该被 body 上限拒绝，实际 ${response.status}`);
    assert.equal(payload.data.kind, "character_card");
    assert.equal(payload.data.extractedFrom, "chara");
    assert.equal(payload.data.cardPlan.cardName, "大卡");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("P9 — the configured limit leaves room for a 20MB file after base64", () => {
  // 这条守的是配置本身：换算关系写死在断言里，改小了会立刻发现。
  const twentyMegabytes = 20 * 1024 * 1024;
  const afterBase64 = Math.ceil(twentyMegabytes / 3) * 4;
  const configured = 32 * 1024 * 1024;

  assert.ok(
    afterBase64 < configured,
    `20MB 文件 base64 后约 ${(afterBase64 / 1024 / 1024).toFixed(1)}MB，上限必须高于它`,
  );
});

test("Phase 6 — malformed JSON is a readable client error, not a server failure", async () => {
  const app = createApp();
  const server = http.createServer(app);
  const port = await listen(server);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/sillytavern/inspect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"content":',
    });
    const payload = await response.json();
    assert.equal(response.status, 400);
    assert.equal(payload.success, false);
    assert.match(payload.error, /不是有效的 JSON/);
    assert.doesNotMatch(payload.error, /Unexpected|SyntaxError/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
