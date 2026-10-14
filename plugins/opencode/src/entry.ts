import { define } from "@opencode/plugin/promise/plugin";
import { createSessionHubV2Setup } from "./adapter-v2.js";
import { sessionHubPlugin } from "./plugin.js";

export default {
  ...define({ id: "session-hub", setup: createSessionHubV2Setup() }),
  server: sessionHubPlugin,
};
