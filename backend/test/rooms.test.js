import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import test from "node:test";

import { io as createSocketClient } from "socket.io-client";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const databaseDirectory = mkdtempSync(join(tmpdir(), "stacktrack-test-"));
process.env.DATABASE_URL = `file:${join(databaseDirectory, "test.db")}`;

execFileSync("npx", ["prisma", "db", "push", "--skip-generate"], {
  cwd: new URL("..", import.meta.url),
  env: process.env,
  stdio: "ignore",
});

const { app } = await import("../dist/app.js");
const { prisma } = await import("../dist/db.js");
const { configureRealtime } = await import("../dist/realtime.js");

async function withServer(app, fn) {
  const server = createServer(app);
  const ioServer = configureRealtime(server);

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    ioServer.close();
    server.close();
    await once(server, "close");
  }
}

async function createRoom(baseUrl) {
  const response = await fetch(`${baseUrl}/api/rooms`, { method: "POST" });
  const body = await response.json();

  return { response, body };
}

async function getRoom(baseUrl, roomId) {
  const response = await fetch(`${baseUrl}/api/rooms/${roomId}`);
  const body = await response.json();

  return { response, body };
}

async function joinPlayer(baseUrl, roomId, body = {}) {
  const response = await fetch(`${baseUrl}/api/rooms/${roomId}/players`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json();

  return { response, body: responseBody };
}

async function leavePlayer(baseUrl, roomId, playerId) {
  const response = await fetch(
    `${baseUrl}/api/rooms/${roomId}/players/${playerId}/leave`,
    { method: "POST" },
  );
  const body = await response.json();

  return { response, body };
}

async function createStackEvent(baseUrl, roomId, playerId, body) {
  const response = await fetch(
    `${baseUrl}/api/rooms/${roomId}/players/${playerId}/stack-events`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const responseBody = await response.json();

  return { response, body: responseBody };
}

test("POST /api/rooms returns a room id", async () => {
  await withServer(app, async (baseUrl) => {
    const { response, body } = await createRoom(baseUrl);

    assert.equal(response.status, 201);
    assert.equal(typeof body.roomId, "string");
    assert.match(body.roomId, uuidPattern);
    assert.doesNotThrow(() => new Date(body.createdAt).toISOString());
  });
});

test("POST /api/rooms returns unique ids", async () => {
  await withServer(app, async (baseUrl) => {
    const first = await createRoom(baseUrl);
    const second = await createRoom(baseUrl);

    assert.notEqual(first.body.roomId, second.body.roomId);
  });
});

test("POST /api/rooms persists the room", async () => {
  await withServer(app, async (baseUrl) => {
    const { body } = await createRoom(baseUrl);
    const room = await prisma.room.findUnique({
      where: { id: body.roomId },
    });

    assert.ok(room);
    assert.equal(room.id, body.roomId);
  });
});

test("GET /api/rooms/:roomId returns a persisted room", async () => {
  await withServer(app, async (baseUrl) => {
    const created = await createRoom(baseUrl);
    const fetched = await getRoom(baseUrl, created.body.roomId);

    assert.equal(fetched.response.status, 200);
    assert.equal(fetched.body.roomId, created.body.roomId);
    assert.equal(fetched.body.createdAt, created.body.createdAt);
    assert.deepEqual(fetched.body.players, []);
  });
});

test("POST /api/rooms/:roomId/players creates a player and token", async () => {
  await withServer(app, async (baseUrl) => {
    const created = await createRoom(baseUrl);
    const joined = await joinPlayer(baseUrl, created.body.roomId, {
      displayName: "Ada",
    });

    assert.equal(joined.response.status, 201);
    assert.equal(typeof joined.body.playerId, "string");
    assert.match(joined.body.playerId, uuidPattern);
    assert.equal(typeof joined.body.clientToken, "string");
    assert.equal(joined.body.room.players.length, 1);
    assert.equal(joined.body.room.players[0].displayName, "Ada");
    assert.equal(joined.body.room.players[0].isActive, true);
  });
});

test("POST /api/rooms/:roomId/players rejoins the same player with a token", async () => {
  await withServer(app, async (baseUrl) => {
    const created = await createRoom(baseUrl);
    const firstJoin = await joinPlayer(baseUrl, created.body.roomId, {
      displayName: "Ada",
    });
    const secondJoin = await joinPlayer(baseUrl, created.body.roomId, {
      clientToken: firstJoin.body.clientToken,
      displayName: "Ada Lovelace",
    });
    const thirdJoin = await joinPlayer(baseUrl, created.body.roomId);

    assert.equal(secondJoin.response.status, 201);
    assert.equal(secondJoin.body.playerId, firstJoin.body.playerId);
    assert.equal(secondJoin.body.clientToken, undefined);
    assert.equal(secondJoin.body.room.players.length, 1);
    assert.equal(secondJoin.body.room.players[0].displayName, "Ada Lovelace");
    assert.notEqual(thirdJoin.body.playerId, firstJoin.body.playerId);
  });
});

test("POST /api/rooms/:roomId/players/:playerId/leave marks a player inactive", async () => {
  await withServer(app, async (baseUrl) => {
    const created = await createRoom(baseUrl);
    const joined = await joinPlayer(baseUrl, created.body.roomId);
    const left = await leavePlayer(baseUrl, created.body.roomId, joined.body.playerId);

    assert.equal(left.response.status, 200);
    assert.equal(left.body.room.players[0].isActive, false);
    assert.equal(typeof left.body.room.players[0].leftAt, "string");
  });
});

test("stack events persist and derive player stack totals", async () => {
  await withServer(app, async (baseUrl) => {
    const created = await createRoom(baseUrl);
    const joined = await joinPlayer(baseUrl, created.body.roomId);
    const buyIn = await createStackEvent(
      baseUrl,
      created.body.roomId,
      joined.body.playerId,
      { type: "BUY_IN", amountCents: 10_000 },
    );
    const cashOut = await createStackEvent(
      baseUrl,
      created.body.roomId,
      joined.body.playerId,
      { type: "CASH_OUT", amountCents: 2_500 },
    );

    assert.equal(buyIn.response.status, 201);
    assert.equal(cashOut.response.status, 201);

    const player = cashOut.body.room.players[0];
    assert.equal(player.buyInCents, 10_000);
    assert.equal(player.cashOutCents, 2_500);
    assert.equal(player.stackCents, 7_500);

    const eventCount = await prisma.stackEvent.count({
      where: { playerId: joined.body.playerId },
    });
    assert.equal(eventCount, 2);
  });
});

test("socket clients receive room state broadcasts", async () => {
  await withServer(app, async (baseUrl) => {
    const created = await createRoom(baseUrl);
    const joined = await joinPlayer(baseUrl, created.body.roomId);
    const socket = createSocketClient(baseUrl, {
      transports: ["websocket"],
    });

    try {
      await once(socket, "connect");

      const initialStatePromise = once(socket, "room:state");
      const ack = await new Promise((resolve) => {
        socket.emit(
          "room:join",
          {
            roomId: created.body.roomId,
            playerId: joined.body.playerId,
            clientToken: joined.body.clientToken,
          },
          resolve,
        );
      });

      assert.deepEqual(ack, { ok: true });

      const [initialState] = await initialStatePromise;
      assert.equal(initialState.roomId, created.body.roomId);

      const nextStatePromise = once(socket, "room:state");
      await createStackEvent(baseUrl, created.body.roomId, joined.body.playerId, {
        type: "BUY_IN",
        amountCents: 5_000,
      });

      const [nextState] = await nextStatePromise;
      assert.equal(nextState.players[0].stackCents, 5_000);
    } finally {
      socket.disconnect();
    }
  });
});
