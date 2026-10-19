export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

export const Errors = {
  unauthorized: () => new ApiError(401, "UNAUTHORIZED", "Sign in to continue."),
  validation: (msg: string) => new ApiError(400, "VALIDATION_FAILED", msg),
  peerInvalid: () => new ApiError(404, "PEER_INVALID", "That person could not be found."),
  messageNotFound: () => new ApiError(404, "MESSAGE_NOT_FOUND", "That message is not available."),
  messageEmpty: () => new ApiError(400, "MESSAGE_EMPTY", "Messages cannot be empty."),
  messageTooLong: (max: number) => new ApiError(400, "TEXT_TOO_LONG", `Text is longer than ${max} characters.`),
  tokenInvalid: () => new ApiError(400, "TOKEN_INVALID", "clientToken must be a UUID."),
  replyTargetInvalid: () => new ApiError(400, "REPLY_TARGET_INVALID", "The message you replied to is not available."),
  tooManyIds: () => new ApiError(400, "TOO_MANY_IDS", "Too many messages in one request."),
  emailTaken: () => new ApiError(409, "EMAIL_TAKEN", "That email is already used by another account."),
  rateLimited: (ms: number) => new ApiError(429, "RATE_LIMITED", "Slow down a little.", ms),
};
