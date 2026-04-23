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
