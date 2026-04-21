import type { Address, OutgoingParseMode } from "../adapters/types.js";

export const HTTP_INGRESS_CONFIG_KEY = "http_ingress";
export const DEFAULT_HTTP_INGRESS_HOST = "127.0.0.1";
export const DEFAULT_HTTP_INGRESS_PORT = 8787;

export interface HttpBridgeAuthConfig {
  header: string;
  secret: string;
}

export interface HttpBridgeTargetConfig {
  to: Address;
  senderAgent?: string;
  parseMode?: OutgoingParseMode;
}

export interface HttpBridgeFormatterConfig {
  text: string;
  metadata?: Record<string, unknown>;
  includeRawBody?: boolean;
}

export interface HttpBridgeConfig {
  name: string;
  path: string;
  auth: HttpBridgeAuthConfig;
  target: HttpBridgeTargetConfig;
  formatter: HttpBridgeFormatterConfig;
}

export interface HttpIngressConfig {
  host: string;
  port: number;
  bridges: HttpBridgeConfig[];
}
