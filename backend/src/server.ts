import { createServer } from "node:http";

import { app } from "./app.js";
import { configureRealtime } from "./realtime.js";

const port = Number(process.env.PORT ?? 3000);
const server = createServer(app);

configureRealtime(server);

server.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
