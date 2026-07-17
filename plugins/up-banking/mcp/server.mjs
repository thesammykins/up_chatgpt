import { BrokerApiClient, BrokerSession } from "./lib/broker-client.mjs";
import { startMcpServer } from "./lib/mcp-runtime.mjs";

const credentials = new BrokerSession();
const client = new BrokerApiClient({ socketPath: credentials.socketPath });

startMcpServer({ credentials, client });
