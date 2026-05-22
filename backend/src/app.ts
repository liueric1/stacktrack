import cors from "cors";
import express from "express";

import { prisma } from "./db.js";
import { emitRoomState } from "./realtime.js";
import {
  createStackEvent,
  getRoomState,
  joinRoomPlayer,
  markPlayerLeft,
  serializeRoom,
} from "./roomState.js";

export const app = express();

app.use(cors());
app.use(express.json());

app.post("/api/rooms", async (_req, res, next) => {
  try {
    const room = await prisma.room.create({ data: {} });

    res.status(201).json(serializeRoom(room));
  } catch (error) {
    next(error);
  }
});

app.get("/api/rooms/:roomId", async (req, res, next) => {
  try {
    const room = await getRoomState(req.params.roomId);

    if (!room) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    res.json(room);
  } catch (error) {
    next(error);
  }
});

app.post("/api/rooms/:roomId/players", async (req, res, next) => {
  try {
    const clientToken = readOptionalString(req.body.clientToken);
    const displayName = readOptionalString(req.body.displayName);
    const result = await joinRoomPlayer({
      roomId: req.params.roomId,
      ...(clientToken === undefined ? {} : { clientToken }),
      ...(displayName === undefined ? {} : { displayName }),
    });

    if (!result) {
      res.status(404).json({ error: "Room not found" });
      return;
    }

    const room = await getRoomState(req.params.roomId);

    await emitRoomState(req.params.roomId);

    res.status(201).json({
      playerId: result.player.id,
      ...(result.clientToken ? { clientToken: result.clientToken } : {}),
      room,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/rooms/:roomId/players/:playerId/leave", async (req, res, next) => {
  try {
    const didLeave = await markPlayerLeft(req.params.roomId, req.params.playerId);

    if (!didLeave) {
      res.status(404).json({ error: "Player not found" });
      return;
    }

    const room = await getRoomState(req.params.roomId);
    await emitRoomState(req.params.roomId);

    res.json({ room });
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/rooms/:roomId/players/:playerId/stack-events",
  async (req, res, next) => {
    try {
      const type = readStackEventType(req.body.type);
      const amountCents = readPositiveInteger(req.body.amountCents);

      if (!type || amountCents === null) {
        res.status(400).json({ error: "Invalid stack event" });
        return;
      }

      const didCreate = await createStackEvent({
        roomId: req.params.roomId,
        playerId: req.params.playerId,
        type,
        amountCents,
      });

      if (!didCreate) {
        res.status(404).json({ error: "Player not found" });
        return;
      }

      const room = await getRoomState(req.params.roomId);
      await emitRoomState(req.params.roomId);

      res.status(201).json({ room });
    } catch (error) {
      next(error);
    }
  },
);

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStackEventType(value: unknown): "BUY_IN" | "CASH_OUT" | null {
  return value === "BUY_IN" || value === "CASH_OUT" ? value : null;
}

function readPositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
