import type { Server as HttpServer } from "node:http";

import { Server, type Socket } from "socket.io";

import { prisma } from "./db.js";
import { getRoomState, hashClientToken } from "./roomState.js";

let io: Server | null = null;

export function configureRealtime(server: HttpServer): Server {
  io = new Server(server, {
    cors: { origin: "*" },
  });

  io.on("connection", (socket) => {
    socket.on("room:join", async (payload, ack) => {
      const result = await joinSocketRoom(socket, payload);

      if (typeof ack === "function") {
        ack(result);
      }
    });
  });

  return io;
}

export async function emitRoomState(roomId: string): Promise<void> {
  if (!io) {
    return;
  }

  const roomState = await getRoomState(roomId);

  if (roomState) {
    io.to(socketRoomName(roomId)).emit("room:state", roomState);
  }
}

function socketRoomName(roomId: string): string {
  return `room:${roomId}`;
}

async function joinSocketRoom(
  socket: Socket,
  payload: unknown,
) {
  if (!isJoinPayload(payload)) {
    socket.emit("room:error", { error: "Invalid room join payload" });
    return { ok: false, error: "Invalid room join payload" };
  }

  const player = await prisma.player.findFirst({
    where: {
      id: payload.playerId,
      roomId: payload.roomId,
      clientTokenHash: hashClientToken(payload.clientToken),
    },
  });

  if (!player) {
    socket.emit("room:error", { error: "Player not found" });
    return { ok: false, error: "Player not found" };
  }

  await prisma.player.update({
    where: { id: player.id },
    data: { lastSeenAt: new Date() },
  });

  await socket.join(socketRoomName(payload.roomId));

  const roomState = await getRoomState(payload.roomId);

  if (roomState) {
    socket.emit("room:state", roomState);
    socket.to(socketRoomName(payload.roomId)).emit("room:state", roomState);
  }

  return { ok: true };
}

function isJoinPayload(payload: unknown): payload is {
  roomId: string;
  playerId: string;
  clientToken: string;
} {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "roomId" in payload &&
    "playerId" in payload &&
    "clientToken" in payload &&
    typeof payload.roomId === "string" &&
    typeof payload.playerId === "string" &&
    typeof payload.clientToken === "string"
  );
}
