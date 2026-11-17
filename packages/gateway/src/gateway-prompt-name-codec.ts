import { GatewayNameCodec } from "./gateway-name-codec.ts";
import type {
	McpGatewayDecodedPromptName,
	McpGatewayPromptNameCodec,
} from "./mcp-gateway.types.ts";

/** Reversible, collision-free and 128-character-bounded prompt namespace. */
export class GatewayPromptNameCodec implements McpGatewayPromptNameCodec {
	readonly #codec: GatewayNameCodec;

	constructor(prefix = "gwp1") {
		this.#codec = new GatewayNameCodec(prefix);
	}

	encode(upstreamName: string, promptName: string): string {
		return this.#codec.encode(upstreamName, promptName);
	}

	decode(projectedName: string): McpGatewayDecodedPromptName {
		const decoded = this.#codec.decode(projectedName);
		return Object.freeze({
			upstreamName: decoded.upstreamName,
			promptName: decoded.toolName,
		});
	}

	tryDecode(projectedName: string): McpGatewayDecodedPromptName | undefined {
		const decoded = this.#codec.tryDecode(projectedName);
		if (decoded === undefined) return undefined;
		return Object.freeze({
			upstreamName: decoded.upstreamName,
			promptName: decoded.toolName,
		});
	}
}
