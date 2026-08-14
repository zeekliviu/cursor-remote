#!/usr/bin/env node
import { startDaemon } from "./server.js";

startDaemon().catch((err) => {
  console.error(err);
  process.exit(1);
});
