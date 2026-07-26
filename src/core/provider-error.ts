import type { ProviderErrorKind } from "../domain.ts";
import { sanitizeTerminalText } from "../terminal/sanitize.ts";

export class ProviderSessionInvalidatedError extends Error {}

export function classifyProviderError(message: unknown): ProviderErrorKind {
  const value = sanitizeTerminalText(message).toLowerCase();
  if (/auth|credential|login|unauthori[sz]ed|expired token/.test(value)) return "authentication";
  if (/invalid model|model .*not found|unsupported model|unknown model/.test(value)) return "invalid_model";
  if (/permission|denied|sandbox|not allowed|approval/.test(value)) return "permission";
  if (/config|setting|schema version/.test(value)) return "configuration";
  if (/protocol|malformed|json|rpc|schema|unexpected event/.test(value)) return "protocol";
  if (/not found|enoent|missing binary|unavailable|cannot find/.test(value)) return "discovery";
  if (/exit|signal|terminated|closed|eof|spawn/.test(value)) return "process_exit";
  return "unknown";
}

export function providerErrorAction(kind: ProviderErrorKind): string {
  switch (kind) {
    case "authentication": return "Authenticate with the provider CLI, then retry.";
    case "invalid_model": return "Choose default or enter a valid provider model ID.";
    case "configuration": return "Fix the reported Splitlane or provider configuration value.";
    case "permission": return "Inspect the approval or sandbox boundary; bypass remains disabled.";
    case "protocol": return "Open diagnostics and verify the installed provider CLI version.";
    case "discovery": return "Install the official provider CLI and ensure it is on PATH.";
    case "process_exit": return "Open diagnostics, then retry or reset only this lane.";
    default: return "Open diagnostics for the bounded provider error.";
  }
}
