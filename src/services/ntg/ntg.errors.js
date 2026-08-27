export class NtgError extends Error {
  constructor(message, { status = 500, code = "NTG_ERROR", cause = null, details = null } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "NtgError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.details = details;
  }
}

export class NtgValidationError extends NtgError {
  constructor(message, details = null) {
    super(message, { status: 400, code: "NTG_VALIDATION_ERROR", details });
    this.name = "NtgValidationError";
  }
}

export class NtgDataAccessError extends NtgError {
  constructor(message, cause = null) {
    super(message, { status: 503, code: "NTG_DATA_ACCESS_ERROR", cause });
    this.name = "NtgDataAccessError";
  }
}

export function toNtgHttpError(err) {
  if (err instanceof NtgError) return err;
  return new NtgError("Falha inesperada ao consultar o Narrative Taxonomy Graph.", {
    status: 500,
    code: "NTG_INTERNAL_ERROR",
    cause: err,
  });
}
