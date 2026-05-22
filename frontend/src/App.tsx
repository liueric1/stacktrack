import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { io, type Socket } from 'socket.io-client'
import './App.css'

type CreateRoomResponse = {
  roomId: string
  createdAt: string
}

type RoomPlayer = {
  playerId: string
  displayName: string | null
  isActive: boolean
  buyInCents: number
  cashOutCents: number
  stackCents: number
}

type RoomState = {
  roomId: string
  createdAt: string
  players: RoomPlayer[]
}

type JoinPlayerResponse = {
  playerId: string
  clientToken?: string
  room: RoomState
}

const apiUrl = import.meta.env.VITE_API_URL ?? defaultApiUrl()
const buyInAmountCents = 10_000
const lastRoomStorageKey = 'stacktrack:lastRoomId'

function App() {
  const [routeRoomId, setRouteRoomId] = useState(() => readRoomIdFromPath() ?? readLastRoomId())
  const [hasToken, setHasToken] = useState(() => {
    const roomId = readRoomIdFromPath() ?? readLastRoomId()
    return roomId ? !!window.localStorage.getItem(clientTokenStorageKey(roomId)) : false
  })

  useEffect(() => {
    function handlePopState() {
      const nextRoomId = readRoomIdFromPath()
      setRouteRoomId(nextRoomId)
      if (nextRoomId) {
        setHasToken(!!window.localStorage.getItem(clientTokenStorageKey(nextRoomId)))
      } else {
        setHasToken(false)
      }
    }

    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  function navigateToRoom(roomId: string) {
    rememberRoom(roomId)
    window.history.pushState({}, '', `/${roomId}`)
    setRouteRoomId(roomId)
    setHasToken(true)
  }

  if (routeRoomId && hasToken) {
    return <RoomPage roomId={routeRoomId} />
  }

  if (routeRoomId && !hasToken) {
    return (
      <LandingPage
        roomId={routeRoomId}
        onRoomJoined={navigateToRoom}
      />
    )
  }

  return <LandingPage onRoomCreated={navigateToRoom} />
}

function LandingPage({
  roomId,
  onRoomCreated,
  onRoomJoined,
}: {
  roomId?: string
  onRoomCreated?: (roomId: string) => void
  onRoomJoined?: (roomId: string) => void
}) {
  const [displayName, setDisplayName] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isJoinMode = !!roomId

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setIsProcessing(true)
    setError(null)

    try {
      if (isJoinMode) {
        const clientToken = getOrCreateClientToken(roomId)
        const joinResponse = await joinPlayerRequest(roomId, clientToken, displayName)

        if (!joinResponse.ok) {
          throw new Error('Room join failed')
        }

        onRoomJoined?.(roomId)
      } else {
        const response = await fetch(`${apiUrl}/api/rooms`, {
          method: 'POST',
        })

        if (!response.ok) {
          throw new Error('Room creation failed')
        }

        const room = (await response.json()) as CreateRoomResponse
        const clientToken = getOrCreateClientToken(room.roomId)
        const joinResponse = await joinPlayerRequest(room.roomId, clientToken, displayName)

        if (!joinResponse.ok) {
          throw new Error('Initial player join failed')
        }

        onRoomCreated?.(room.roomId)
      }
    } catch {
      setError(
        isJoinMode
          ? 'Could not join this room. Check the room URL and backend server.'
          : 'Could not create a room. Check that the backend is running.'
      )
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <main className="app-shell">
      <form className="room-panel" onSubmit={handleSubmit} aria-labelledby="page-title">
        <div className="intro">
          <p className="eyebrow">Poker Stacktrack</p>
          <h1 id="page-title">{isJoinMode ? 'Join room' : 'Create a room'}</h1>
          <p className="summary">
            {isJoinMode
              ? `Enter your name to join room ${shortRoomId(roomId)}.`
              : 'Start a shared stack tracker and send the room link to the table.'}
          </p>
        </div>

        <div className="input-group">
          <label htmlFor="display-name" className="input-label">
            Your name (optional)
          </label>
          <input
            id="display-name"
            type="text"
            className="name-input"
            placeholder="e.g. Ada Lovelace"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={isProcessing}
            maxLength={50}
          />
        </div>

        <button className="primary-action" type="submit" disabled={isProcessing}>
          {isProcessing
            ? isJoinMode
              ? 'Joining...'
              : 'Creating...'
            : isJoinMode
              ? 'Join room'
              : 'Create room'}
        </button>

        {error ? <p className="error-message">{error}</p> : null}
      </form>
    </main>
  )
}

function RoomPage({ roomId }: { roomId: string }) {
  const [room, setRoom] = useState<RoomState | null>(null)
  const [playerId, setPlayerId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [isBuyingIn, setIsBuyingIn] = useState(false)
  const [didCopy, setDidCopy] = useState(false)
  const previousRoomRef = useRef<RoomState | null>(null)

  const roomUrl = useMemo(() => `${window.location.origin}/${roomId}`, [roomId])

  useEffect(() => {
    let socket: Socket | null = null
    let isCancelled = false

    async function joinRoom() {
      setError(null)
      previousRoomRef.current = null
      setLogs([])

      try {
        const clientToken = getOrCreateClientToken(roomId)
        const joinResponse = await joinPlayerRequest(roomId, clientToken)

        if (!joinResponse.ok) {
          throw new Error('Join failed')
        }

        const joined = (await joinResponse.json()) as JoinPlayerResponse

        if (isCancelled) {
          return
        }

        setPlayerId(joined.playerId)
        rememberRoom(roomId)
        applyRoomState(joined.room)
        addLog('You joined the room.')

        socket = io(apiUrl)
        socket.on('room:state', (nextRoom: RoomState) => {
          applyRoomState(nextRoom)
        })
        socket.on('room:error', (payload: { error?: string }) => {
          setError(payload.error ?? 'Realtime connection failed.')
        })
        socket.on('connect_error', () => {
          setError('Realtime connection failed. Check that the backend is reachable from this device.')
        })
        socket.emit('room:join', {
          roomId,
          playerId: joined.playerId,
          clientToken,
        })
      } catch {
        if (!isCancelled) {
          setError('Could not join this room. Check the room URL and backend server.')
        }
      }
    }

    function applyRoomState(nextRoom: RoomState) {
      if (isCancelled) {
        return
      }

      setLogs((currentLogs) => [
        ...deriveLogs(previousRoomRef.current, nextRoom),
        ...currentLogs,
      ].slice(0, 20))
      previousRoomRef.current = nextRoom
      setRoom(nextRoom)
    }

    function addLog(message: string) {
      setLogs((currentLogs) => [message, ...currentLogs].slice(0, 20))
    }

    joinRoom()

    return () => {
      isCancelled = true
      socket?.disconnect()
    }
  }, [roomId])

  async function addBuyIn() {
    if (!playerId) {
      return
    }

    setIsBuyingIn(true)
    setError(null)

    try {
      const response = await fetch(
        `${apiUrl}/api/rooms/${roomId}/players/${playerId}/stack-events`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'BUY_IN', amountCents: buyInAmountCents }),
        },
      )

      if (!response.ok) {
        throw new Error('Buy-in failed')
      }
    } catch {
      setError('Could not add a buy-in.')
    } finally {
      setIsBuyingIn(false)
    }
  }

  async function copyRoomUrl() {
    if (!navigator.clipboard) {
      window.prompt('Copy room link', roomUrl)
      return
    }

    await navigator.clipboard.writeText(roomUrl)
    setDidCopy(true)
  }

  return (
    <main className="app-shell room-shell">
      <section className="room-panel room-view" aria-labelledby="room-title">
        <div className="room-header">
          <div>
            <p className="eyebrow">Room</p>
            <h1 id="room-title">{shortRoomId(roomId)}</h1>
          </div>
          <button className="secondary-action" type="button" onClick={copyRoomUrl}>
            {didCopy ? 'Copied' : 'Copy link'}
          </button>
        </div>

        <button
          className="primary-action"
          type="button"
          onClick={addBuyIn}
          disabled={!playerId || isBuyingIn}
        >
          {!playerId ? 'Joining room...' : isBuyingIn ? 'Adding...' : 'Add $100 buy-in'}
        </button>

        {error ? <p className="error-message">{error}</p> : null}

        <div className="room-grid">
          <section className="stack-list" aria-labelledby="players-title">
            <h2 id="players-title">Players</h2>
            {room?.players.length ? (
              <ul>
                {room.players.map((player) => (
                  <li key={player.playerId}>
                    <span>{playerLabel(player)}</span>
                    <strong>{formatMoney(player.stackCents)}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Joining room...</p>
            )}
          </section>

          <section className="activity-log" aria-labelledby="activity-title">
            <h2 id="activity-title">Activity</h2>
            {logs.length ? (
              <ol>
                {logs.map((log, index) => (
                  <li key={`${log}-${index}`}>{log}</li>
                ))}
              </ol>
            ) : (
              <p className="muted">Waiting for room activity.</p>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}

function readRoomIdFromPath(): string | null {
  const segments = window.location.pathname.split('/').filter(Boolean)

  if (segments.length === 0) {
    return null
  }

  if (segments[0] === 'rooms') {
    return segments[1] ?? null
  }

  return segments[0] ?? null
}

function defaultApiUrl(): string {
  return `${window.location.protocol}//${window.location.hostname}:3000`
}

function getOrCreateClientToken(roomId: string): string {
  const storageKey = clientTokenStorageKey(roomId)
  const existingToken = window.localStorage.getItem(storageKey)

  if (existingToken) {
    return existingToken
  }

  const token = generateClientToken()
  window.localStorage.setItem(storageKey, token)
  return token
}

function readLastRoomId(): string | null {
  const roomId = window.localStorage.getItem(lastRoomStorageKey)

  if (!roomId || !window.localStorage.getItem(clientTokenStorageKey(roomId))) {
    return null
  }

  return roomId
}

function rememberRoom(roomId: string) {
  window.localStorage.setItem(lastRoomStorageKey, roomId)
}

function clientTokenStorageKey(roomId: string): string {
  return `stacktrack:${roomId}:clientToken`
}

function generateClientToken(): string {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID()
  }

  const randomValues = new Uint8Array(32)

  if (window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(randomValues)
  } else {
    for (let index = 0; index < randomValues.length; index += 1) {
      randomValues[index] = Math.floor(Math.random() * 256)
    }
  }

  return Array.from(randomValues, (value) => value.toString(16).padStart(2, '0')).join('')
}

function joinPlayerRequest(roomId: string, clientToken: string, displayName?: string): Promise<Response> {
  return fetch(`${apiUrl}/api/rooms/${roomId}/players`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientToken, displayName }),
  })
}

function deriveLogs(previousRoom: RoomState | null, nextRoom: RoomState): string[] {
  if (!previousRoom) {
    return []
  }

  const previousPlayers = new Map(previousRoom.players.map((player) => [player.playerId, player]))
  const logs: string[] = []

  for (const nextPlayer of nextRoom.players) {
    const previousPlayer = previousPlayers.get(nextPlayer.playerId)

    if (!previousPlayer) {
      logs.push(`${playerLabel(nextPlayer)} joined the room.`)
      continue
    }

    if (!previousPlayer.isActive && nextPlayer.isActive) {
      logs.push(`${playerLabel(nextPlayer)} rejoined the room.`)
    }

    if (previousPlayer.isActive && !nextPlayer.isActive) {
      logs.push(`${playerLabel(nextPlayer)} left the room.`)
    }

    if (nextPlayer.buyInCents > previousPlayer.buyInCents) {
      logs.push(
        `${playerLabel(nextPlayer)} bought in for ${formatMoney(
          nextPlayer.buyInCents - previousPlayer.buyInCents,
        )}.`,
      )
    }

    if (nextPlayer.cashOutCents > previousPlayer.cashOutCents) {
      logs.push(
        `${playerLabel(nextPlayer)} cashed out ${formatMoney(
          nextPlayer.cashOutCents - previousPlayer.cashOutCents,
        )}.`,
      )
    }
  }

  return logs.reverse()
}

function playerLabel(player: RoomPlayer): string {
  return player.displayName ?? `Player ${player.playerId.slice(0, 8)}`
}

function shortRoomId(roomId: string): string {
  return roomId.slice(0, 8)
}

function formatMoney(amountCents: number): string {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
  }).format(amountCents / 100)
}

export default App
