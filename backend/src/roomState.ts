import { randomBytes, createHash } from "node:crypto";

import { prisma } from "./db.js";

type RoomRecord = {
  id: string;
  createdAt: Date;
};

type PlayerRecord = {
  id: string;
  displayName: string | null;
  isActive: boolean;
  joinedAt: Date;
  leftAt: Date | null;
  lastSeenAt: Date;
  events: Array<{
    type: "BUY_IN" | "CASH_OUT";
    amountCents: number;
  }>;
};

export type RoomState = {
  roomId: string;
  createdAt: string;
  players: Array<{
    playerId: string;
    displayName: string | null;
    isActive: boolean;
    joinedAt: string;
    leftAt: string | null;
    lastSeenAt: string;
    buyInCents: number;
    cashOutCents: number;
    stackCents: number;
  }>;
};

export function generateClientToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashClientToken(clientToken: string): string {
  return createHash("sha256").update(clientToken).digest("hex");
}

export async function getRoomState(roomId: string): Promise<RoomState | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      players: {
        orderBy: { joinedAt: "asc" },
        include: { events: true },
      },
    },
  });

  if (!room) {
    return null;
  }

  return serializeRoomState(room);
}

export async function joinRoomPlayer({
  roomId,
  clientToken,
  displayName,
}: {
  roomId: string;
  clientToken?: string;
  displayName?: string;
}) {
  const room = await prisma.room.findUnique({ where: { id: roomId } });

  if (!room) {
    return null;
  }

  const token = clientToken ?? generateClientToken();
  const clientTokenHash = hashClientToken(token);
  const now = new Date();
  const displayNameData =
    displayName === undefined ? {} : { displayName: normalizeDisplayName(displayName) };

  const player = await prisma.player.upsert({
    where: {
      roomId_clientTokenHash: {
        roomId,
        clientTokenHash,
      },
    },
    create: {
      roomId,
      clientTokenHash,
      ...displayNameData,
    },
    update: {
      isActive: true,
      leftAt: null,
      lastSeenAt: now,
      ...displayNameData,
    },
  });

  return {
    player,
    clientToken: clientToken === undefined ? token : undefined,
  };
}

export async function markPlayerLeft(roomId: string, playerId: string): Promise<boolean> {
  const result = await prisma.player.updateMany({
    where: { id: playerId, roomId },
    data: {
      isActive: false,
      leftAt: new Date(),
      lastSeenAt: new Date(),
    },
  });

  return result.count > 0;
}

export async function createStackEvent({
  roomId,
  playerId,
  type,
  amountCents,
}: {
  roomId: string;
  playerId: string;
  type: "BUY_IN" | "CASH_OUT";
  amountCents: number;
}): Promise<boolean> {
  const player = await prisma.player.findFirst({
    where: { id: playerId, roomId },
  });

  if (!player) {
    return false;
  }

  await prisma.stackEvent.create({
    data: { roomId, playerId, type, amountCents },
  });

  return true;
}

export function serializeRoom(room: RoomRecord) {
  return {
    roomId: room.id,
    createdAt: room.createdAt.toISOString(),
  };
}

function serializeRoomState(room: RoomRecord & { players: PlayerRecord[] }): RoomState {
  return {
    ...serializeRoom(room),
    players: room.players.map((player) => {
      const buyInCents = sumEvents(player.events, "BUY_IN");
      const cashOutCents = sumEvents(player.events, "CASH_OUT");

      return {
        playerId: player.id,
        displayName: player.displayName,
        isActive: player.isActive,
        joinedAt: player.joinedAt.toISOString(),
        leftAt: player.leftAt?.toISOString() ?? null,
        lastSeenAt: player.lastSeenAt.toISOString(),
        buyInCents,
        cashOutCents,
        stackCents: buyInCents - cashOutCents,
      };
    }),
  };
}

function sumEvents(
  events: PlayerRecord["events"],
  type: PlayerRecord["events"][number]["type"],
): number {
  return events
    .filter((event) => event.type === type)
    .reduce((total, event) => total + event.amountCents, 0);
}

function normalizeDisplayName(displayName: string): string | null {
  const trimmed = displayName.trim();
  return trimmed.length > 0 ? trimmed : null;
}
