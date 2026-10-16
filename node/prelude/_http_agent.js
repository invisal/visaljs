// node:_http_agent: Node's module behind node:http's Agent, as its tests reach it.
import { Agent, globalAgent } from "./internal/http_agent.js";

export { Agent, globalAgent };
export default { Agent, globalAgent };
