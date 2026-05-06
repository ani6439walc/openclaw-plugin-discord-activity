import { type OpenClawPluginApi } from "./api.js";
import { createPlugin } from "./src/plugin.js";

export default {
  id: "discord-tool-status",
  name: "Discord Tool Status",
  description:
    "Shows live tool-call status as a Discord message that is updated and deleted when the agent finishes.",
  register(api: OpenClawPluginApi) {
    const plugin = createPlugin(api);
    plugin.register(api);
  },
};
