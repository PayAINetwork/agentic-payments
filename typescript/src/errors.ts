export class AgentPaymentsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentPaymentsError";
  }
}

export class ConfigError extends AgentPaymentsError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class PayAIApiError extends AgentPaymentsError {
  public readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "PayAIApiError";
    this.status = status;
  }
}

export class ProtocolError extends AgentPaymentsError {
  public readonly protocol: string;

  constructor(protocol: string, message: string) {
    super(`[${protocol}] ${message}`);
    this.name = "ProtocolError";
    this.protocol = protocol;
  }
}

export class VerificationError extends ProtocolError {
  constructor(protocol: string, message: string) {
    super(protocol, message);
    this.name = "VerificationError";
  }
}

export class SettlementError extends ProtocolError {
  constructor(protocol: string, message: string) {
    super(protocol, message);
    this.name = "SettlementError";
  }
}
