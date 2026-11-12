/** Erreur HTTP renvoyée au client sous la forme `{ error }`. */
export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} introuvable.`);
