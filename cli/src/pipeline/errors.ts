// What an integration throws: a failure the command line prints as its message.

/** An integration's failure, as the message to print. */
export class IntegrationError extends Error {}

/** A command `ctx.run` ran that failed: its output, for the integration to look into. */
export class CommandError extends IntegrationError {
  readonly output: string;

  constructor(message: string, output: string) {
    super(message);
    this.output = output;
  }
}
