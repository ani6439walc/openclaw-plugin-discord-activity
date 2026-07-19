import { type OpenClawPluginApi } from "./api.js";
import { createPlugin } from "./src/plugin.js";

export default {
  id: "discord-activity",
  name: "Discord Activity",
  description:
    "Shows live agent and tool activity as a Discord message that is updated and deleted when the agent finishes.",
  register(api: OpenClawPluginApi) {
    const plugin = createPlugin(api);
    plugin.register(api);
  },
};
